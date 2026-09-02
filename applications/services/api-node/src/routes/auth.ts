import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { signToken, comparePassword, hashPassword } from "../auth.js";
import { createRateLimiter, createFailureTracker } from "../services/rateLimit.js";

type Role = "user" | "tenant_admin" | "zentriz_admin";
type LoginBody = { email: string; password: string; role?: Role };

const VALID_ROLES: Role[] = ["user", "tenant_admin", "zentriz_admin"];

// Hash "isca" reutilizado para equalizar o tempo de resposta quando o e-mail não
// existe — remove o oráculo de enumeração de contas por timing. Calculado sob demanda.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("::genesis-timing-guard::");
  return dummyHashPromise;
}

// Fix 1.1 (auditoria 2026-09-02): o login era a única rota pública sem freio — brute-force /
// credential-stuffing viável pela borda. Duas camadas: teto por IP (toda tentativa conta;
// generoso p/ uso legítimo) e lockout por e-mail contando SÓ FALHAS (senão qualquer anônimo
// trancaria a conta da vítima). Limites via env p/ ajuste operacional sem rebuild.
const loginIpLimiter = createRateLimiter({
  windowMs: parseInt(process.env.LOGIN_RATE_WINDOW_MS ?? "60000", 10),
  max: parseInt(process.env.LOGIN_RATE_MAX_PER_IP ?? "20", 10),
  name: "login-ip",
});
const loginFailTracker = createFailureTracker({
  windowMs: parseInt(process.env.LOGIN_FAIL_WINDOW_MS ?? "900000", 10), // 15 min
  max: parseInt(process.env.LOGIN_FAIL_MAX_PER_EMAIL ?? "10", 10),
});

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginBody }>("/api/auth/login", { preHandler: loginIpLimiter }, async (request, reply) => {
    const { email, password, role } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "email e password são obrigatórios" });
    }
    const emailKey = email.toLowerCase();
    if (process.env.NODE_ENV !== "test" && loginFailTracker.isBlocked(emailKey)) {
      const retryAfterMs = loginFailTracker.retryAfterMs(emailKey);
      reply.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return reply.status(429).send({
        code: "TOO_MANY_REQUESTS",
        message: "Muitas tentativas de login para esta conta. Aguarde alguns minutos e tente novamente.",
        retryAfterMs,
      });
    }
    // O papel é opcional; quando informado (pela tela de login) desambigua contas
    // que compartilham o mesmo e-mail em papeis distintos (ver migration 049).
    const wantRole: Role | null = role && VALID_ROLES.includes(role) ? role : null;

    const client = await pool.connect();
    try {
      const userResult = await client.query(
        `SELECT id, email, name, password_hash, tenant_id, role, status, created_at
           FROM users
          WHERE email = $1 AND ($2::text IS NULL OR role = $2)
          ORDER BY CASE role WHEN 'zentriz_admin' THEN 0 WHEN 'tenant_admin' THEN 1 ELSE 2 END
          LIMIT 1`,
        [email.toLowerCase(), wantRole]
      );
      const user = userResult.rows[0];
      if (!user) {
        // Compara contra um hash isca para não vazar (por timing) se o e-mail existe.
        await comparePassword(password, await getDummyHash());
        loginFailTracker.recordFailure(emailKey);
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Credenciais inválidas" });
      }

      const ok = user.password_hash ? await comparePassword(password, user.password_hash) : false;
      if (!ok) {
        loginFailTracker.recordFailure(emailKey);
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Credenciais inválidas" });
      }
      // Só revelamos o estado da conta após a senha conferir (evita enumeração de contas inativas).
      if (user.status !== "active") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Usuário inativo" });
      }

      let tenant = null;
      if (user.tenant_id) {
        const tenantResult = await client.query(
          `SELECT t.id, t.name, t.plan_id, t.status, p.id as plan_pk, p.name as plan_name, p.slug as plan_slug, p.max_projects, p.max_users_per_tenant
           FROM tenants t JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`,
          [user.tenant_id]
        );
        const row = tenantResult.rows[0];
        if (row) {
          tenant = {
            id: row.id,
            name: row.name,
            planId: row.plan_id,
            plan: {
              id: row.plan_pk,
              name: row.plan_name,
              slug: row.plan_slug,
              maxProjects: row.max_projects,
              maxUsersPerTenant: row.max_users_per_tenant,
            },
            status: row.status,
          };
        }
        // Bloqueio de acesso: nenhum usuário de um tenant não-ativo pode entrar.
        // O master (zentriz_admin, tenant_id NULL) não passa por aqui e nunca é bloqueado.
        if (!tenant || tenant.status !== "active") {
          return reply.status(403).send({ code: "TENANT_INACTIVE", message: "Tenant inativo. Acesso indisponível até a ativação." });
        }
      }

      const token = signToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenant_id,
          role: user.role,
          status: user.status,
          createdAt: user.created_at,
        },
        tenant,
      });
    } finally {
      client.release();
    }
  });
}
