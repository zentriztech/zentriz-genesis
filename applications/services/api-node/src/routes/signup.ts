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
  app.post<{ Body: RequestCodeBody }>("/api/tenant/signup/request-code", async (request, reply) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    if (!validateEmail(email)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail inválido" });
    }

    // Se o e-mail já existe como usuário, não revela (anti-enumeração) mas também não
    // gera código — retorna genérico. O signup final valida de novo com 409 claro.
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado no sistema" });
    }

    const created = await createVerificationCode(email, "tenant_signup");
    if (!created.ok) {
      return reply
        .status(429)
        .send({ code: "TOO_MANY_REQUESTS", message: "Aguarde alguns segundos antes de solicitar um novo código.", retryAfterMs: created.retryAfterMs });
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
  app.post<{ Body: SignupBody }>("/api/tenant/signup", async (request, reply) => {
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

    // Verifica o código ANTES de qualquer escrita.
    const verified = await verifyCode(adminEmail, code, "tenant_signup");
    if (!verified.ok) {
      return reply.status(400).send({ code: "INVALID_CODE", message: VERIFY_ERROR_MESSAGES[verified.reason] ?? "Código inválido." });
    }

    const client = await pool.connect();
    try {
      const planRow = await client.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (planRow.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inválido" });
      }

      const existingUser = await client.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
      if (existingUser.rows.length > 0) {
        return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado no sistema" });
      }

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
      throw e;
    } finally {
      client.release();
    }
  });
}
