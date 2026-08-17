import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { hashPassword, validateEmail, validatePassword } from "../auth.js";
import {
  createVerificationCode,
  verifyCode,
  invalidatePending,
} from "../services/emailVerification.js";
import { isSesConfigured, sendEmail, renderVerificationEmail } from "../services/emailSender.js";
import { isValidCnpj, normalizeCnpjDigits } from "../services/cnpjLookup.js";
import { createRateLimiter, clientIp } from "../services/rateLimit.js";

// ── Rate limiting dos endpoints públicos de signup ──────────────────────────────
// request-code: por IP (bloqueia scripts) + por e-mail (bloqueia bombardeio de UMA
// caixa de entrada, robusto mesmo atrás de proxy/NAT). signup: por IP.
const requestCodeIpLimiter = createRateLimiter({ name: "signup-request-code-ip", windowMs: 60_000, max: 12 });
const requestCodeEmailLimiter = createRateLimiter({
  name: "signup-request-code-email",
  windowMs: 60 * 60_000, // 1h
  max: 8,
  keyFn: (r) => {
    const email = typeof (r.body as RequestCodeBody | undefined)?.email === "string"
      ? (r.body as RequestCodeBody).email!.trim().toLowerCase()
      : "";
    // Sem e-mail no corpo, cai no IP para não colapsar todos num só balde.
    return email ? `email:${email}` : `ip:${clientIp(r)}`;
  },
});
const signupIpLimiter = createRateLimiter({ name: "signup-submit-ip", windowMs: 60_000, max: 20 });

type SignupBody = {
  name?: string;
  planId?: string;
  adminEmail?: string;
  adminName?: string;
  password?: string;
  code?: string;
  // Dados adicionais da empresa (opcionais no signup público)
  cnpj?: string;
  responsibleName?: string;
  responsibleEmail?: string;
  responsiblePhone?: string;
  addressCep?: string;
  addressStreet?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressDistrict?: string;
  addressCity?: string;
  addressState?: string;
};

type RequestCodeBody = { email?: string };

const VERIFY_ERROR_MESSAGES: Record<string, string> = {
  not_found: "Nenhum código pendente. Solicite um novo código.",
  expired: "Código expirado. Solicite um novo código.",
  too_many_attempts: "Muitas tentativas. Solicite um novo código.",
  mismatch: "Código incorreto.",
};

/** Normaliza um campo textual opcional do body → string trimada ou undefined. */
function optStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Rotas públicas de cadastro de tenant (signup) + verificação de e-mail por código.
 * GET /api/plans foi movido para routes/plans.ts (canônico). */
export async function signupRoutes(app: FastifyInstance) {
  // ── Solicitar código de verificação de e-mail ────────────────────────────────
  app.post<{ Body: RequestCodeBody }>(
    "/api/tenant/signup/request-code",
    { preHandler: [requestCodeIpLimiter, requestCodeEmailLimiter] },
    async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    if (!validateEmail(email)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail inválido" });
    }

    // Cria o código primeiro — o custo (bcrypt) e o cooldown ficam IGUAIS para e-mail
    // existente ou novo, evitando oráculo de enumeração por timing/comportamento.
    const created = await createVerificationCode(email, "tenant_signup");
    if (!created.ok) {
      return reply
        .status(429)
        .send({ code: "TOO_MANY_REQUESTS", message: "Aguarde alguns segundos antes de solicitar um novo código.", retryAfterMs: created.retryAfterMs });
    }

    // Anti-enumeração: se o e-mail já pertence a um usuário, NÃO enviamos código (não há
    // cadastro novo a confirmar), mas respondemos de forma IDÊNTICA ao sucesso — o cliente
    // não distingue "existe" de "não existe" por esta rota. O signup final valida de novo.
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return reply.send({ sent: true, expiresAt: created.expiresAt.toISOString() });
    }

    // Envio real via SES (prod). Em dev/test (SES OFF), devolve devCode para permitir o fluxo.
    if (isSesConfigured()) {
      const { subject, html, text } = renderVerificationEmail(created.code);
      try {
        await sendEmail({ to: email, subject, html, text });
      } catch (e) {
        // Falha de envio NÃO deve travar o usuário: libera reenvio imediato.
        await invalidatePending(email, "tenant_signup").catch(() => {});
        request.log.error({ err: e instanceof Error ? e.message : String(e) }, "SES send failed (request-code)");
        return reply
          .status(502)
          .send({ code: "EMAIL_SEND_FAILED", message: "Não foi possível enviar o e-mail agora. Tente novamente." });
      }
      return reply.send({ sent: true, expiresAt: created.expiresAt.toISOString() });
    }

    // SES desligado. Fora de produção (dev/test) expõe o devCode para permitir o fluxo.
    // Em produção com SES desligado é MISCONFIG: nunca vazar o código num endpoint público.
    if (process.env.NODE_ENV !== "production") {
      return reply.send({ sent: false, devCode: created.code, expiresAt: created.expiresAt.toISOString() });
    }
    await invalidatePending(email, "tenant_signup").catch(() => {});
    request.log.error("SES desligado em produção — código de verificação não entregável");
    return reply
      .status(503)
      .send({ code: "EMAIL_DISABLED", message: "Verificação de e-mail indisponível no momento. Tente mais tarde." });
  });

  // ── Concluir cadastro (exige código verificado) ───────────────────────────────
  app.post<{ Body: SignupBody }>(
    "/api/tenant/signup",
    { preHandler: signupIpLimiter },
    async (request, reply) => {
    const body = request.body ?? {};
    const tenantName = typeof body.name === "string" ? body.name.trim() : "";
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    const adminEmail = typeof body.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
    const adminName = typeof body.adminName === "string" ? body.adminName.trim() : "";
    const password = body.password;
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!tenantName || tenantName.length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome da empresa é obrigatório (mín. 2 caracteres)" });
    }
    if (!planId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Selecione um plano" });
    }
    if (!adminEmail) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail do administrador é obrigatório" });
    }
    if (!validateEmail(adminEmail)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail do administrador inválido" });
    }
    if (!adminName || adminName.length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do administrador é obrigatório (mín. 2 caracteres)" });
    }
    if (typeof password !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Senha é obrigatória" });
    }
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.ok) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: pwdCheck.message });
    }
    if (!code) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Código de verificação é obrigatório" });
    }

    // Campos opcionais da empresa
    const cnpjRaw = optStr(body.cnpj);
    let cnpj: string | null = null;
    if (cnpjRaw) {
      cnpj = normalizeCnpjDigits(cnpjRaw);
      if (!isValidCnpj(cnpj)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "CNPJ inválido" });
      }
    }
    const responsibleEmail = optStr(body.responsibleEmail)?.toLowerCase() ?? null;
    if (responsibleEmail && !validateEmail(responsibleEmail)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail do responsável inválido" });
    }

    // Validações baratas ANTES de consumir o código: plano válido e e-mail livre.
    // Assim um plano inválido ou e-mail já cadastrado não "queima" o código do usuário
    // (que teria de pedir outro à toa). O código só é consumido quando o cadastro pode
    // de fato prosseguir. A corrida (TOCTOU) de duplicidade é fechada pelo 23505 abaixo.
    const planRow0 = await pool.query("SELECT id FROM plans WHERE id = $1", [planId]);
    if (planRow0.rows.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inválido" });
    }
    const existingUser0 = await pool.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
    if (existingUser0.rows.length > 0) {
      return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado no sistema" });
    }

    // Verifica o código (consome no acerto) só após as validações baratas.
    const verified = await verifyCode(adminEmail, code, "tenant_signup");
    if (!verified.ok) {
      return reply.status(400).send({ code: "INVALID_CODE", message: VERIFY_ERROR_MESSAGES[verified.reason] ?? "Código inválido." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tenantInsert = await client.query(
        `INSERT INTO tenants
           (name, plan_id, status, email, email_confirmed, cnpj,
            responsible_name, responsible_email, responsible_phone,
            address_cep, address_street, address_number, address_complement,
            address_district, address_city, address_state)
         VALUES ($1, $2, 'inactive', $3, true, $4,
                 $5, $6, $7,
                 $8, $9, $10, $11,
                 $12, $13, $14)
         RETURNING id, name, plan_id, status, email, email_confirmed, created_at`,
        [
          tenantName,
          planId,
          adminEmail,
          cnpj,
          optStr(body.responsibleName) ?? null,
          responsibleEmail,
          optStr(body.responsiblePhone) ?? null,
          optStr(body.addressCep) ?? null,
          optStr(body.addressStreet) ?? null,
          optStr(body.addressNumber) ?? null,
          optStr(body.addressComplement) ?? null,
          optStr(body.addressDistrict) ?? null,
          optStr(body.addressCity) ?? null,
          optStr(body.addressState)?.toUpperCase() ?? null,
        ]
      );
      const tenant = tenantInsert.rows[0];
      const tenantId = tenant.id;

      const passwordHash = await hashPassword(password);
      await client.query(
        `INSERT INTO users (email, name, password_hash, tenant_id, role, status)
         VALUES ($1, $2, $3, $4, 'tenant_admin', 'active')
         RETURNING id, email, name, tenant_id, role, status, created_at`,
        [adminEmail, adminName, passwordHash, tenantId]
      );
      await client.query("COMMIT");

      return reply.status(201).send({
        message: "Cadastro realizado. Seu tenant será ativado após a confirmação do pagamento.",
        tenant: {
          id: tenantId,
          name: tenant.name,
          planId: tenant.plan_id,
          status: tenant.status,
          email: tenant.email,
          emailConfirmed: !!tenant.email_confirmed,
          createdAt: (tenant.created_at as Date)?.toISOString?.(),
        },
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Corrida de duplicidade: outro signup inseriu o mesmo e-mail entre o pre-check e o
      // INSERT (violação de UNIQUE em users.email) → 409 claro em vez de 500.
      if ((e as { code?: string })?.code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado no sistema" });
      }
      throw e;
    } finally {
      client.release();
    }
  });
}
