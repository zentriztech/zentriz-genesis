/**
 * finance.ts — Módulo Financeiro (F1+F2+F3) — RFC-0002 Parte B.
 *
 * Escopo acumulado:
 *   • Contas bancárias da empresa (recebedora) — CRUD.
 *   • Cobranças (charges) — listar, detalhar, criar (avulsa/assinatura), gerar mês, ajustar/cancelar.
 *   • Pagamentos (baixa manual) — listar, criar (recalcula status da cobrança) [F1].
 *   • Ciclo de vida da assinatura — ativação por pagamento (maybeActivateTenant) [F2].
 *   • Sumário financeiro (MRR, em aberto, vencidas, recebido no mês).
 *   • Notas fiscais internas (invoices) — emitir a partir de cobrança PAGA, listar,
 *     detalhar, cancelar. Emissão via porta InvoiceProvider (stub interno em F3) [F3].
 *
 * TODAS as rotas são exclusivas de `zentriz_admin` — o Financeiro É a conta de gestão.
 * Por isso NÃO aplicamos o `denyCreationForManagement` aqui (aquele guard barra AUTORIA
 * de specs/produtos/projetos por conta de gestão; finanças são função legítima da gestão).
 *
 * Dinheiro sempre em centavos inteiros. Moeda única BRL.
 * SEM gateway de pagamento real e SEM NFS-e municipal (F4).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { bustTenantStatus } from "../services/tenantStatusCache.js";
import { getInvoiceProvider } from "../services/invoiceProvider.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function requireAdmin(user: AuthUser): boolean {
  return user?.role === "zentriz_admin";
}

const FORBIDDEN = { code: "FORBIDDEN", message: "Acesso restrito a Zentriz Admin" } as const;

// ── Validadores ──────────────────────────────────────────────────────────────
// Teto de segurança: coluna amount_cents é INTEGER no Postgres (máx ~2.147e9). Barramos
// no app com margem para devolver 400 (e não um 500 por overflow 22003 no INSERT).
const MAX_CENTS = 2_000_000_000;
function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CENTS;
}
function isPositiveCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_CENTS;
}
// Estados de cobrança que aceitam registro de pagamento (baixa manual).
const PAYABLE_STATUSES = ["open", "overdue", "partially_paid"] as const;
const COMPETENCE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
function isCompetence(value: unknown): value is string {
  return typeof value === "string" && COMPETENCE_RE.test(value);
}
const PAYMENT_METHODS = ["pix", "boleto", "card", "transfer", "cash", "manual"] as const;
const CHARGE_KINDS = ["subscription", "one_off", "proration"] as const;

/** Primeiro-dia-do-mês da competência + N dias como vencimento padrão (string YYYY-MM-DD). */
function defaultDueDate(competence: string, dayOfMonth = 10): string {
  const dd = String(Math.min(28, Math.max(1, dayOfMonth))).padStart(2, "0");
  return `${competence}-${dd}`;
}

// ── mapRows ────────────────────────────────────────────────────────────────
function mapBankAccount(r: Record<string, unknown>) {
  return {
    id: r.id,
    label: r.label,
    bankName: r.bank_name,
    bankCode: r.bank_code,
    agency: r.agency,
    account: r.account,
    accountType: r.account_type,
    pixKey: r.pix_key,
    pixKeyType: r.pix_key_type,
    holderName: r.holder_name,
    holderDocument: r.holder_document,
    isDefault: !!r.is_default,
    active: !!r.active,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? r.created_at,
  };
}

function mapCharge(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name ?? undefined,
    planId: r.plan_id,
    amountCents: r.amount_cents,
    currency: r.currency,
    description: r.description,
    competenceMonth: r.competence_month,
    kind: r.kind,
    dueDate: r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : r.due_date,
    status: r.status,
    issuedAt: (r.issued_at as Date)?.toISOString?.() ?? r.issued_at ?? null,
    paidAt: (r.paid_at as Date)?.toISOString?.() ?? r.paid_at ?? null,
    paymentMethod: r.payment_method,
    externalId: r.external_id,
    paidCents: r.paid_cents !== undefined ? Number(r.paid_cents) : undefined,
    createdBy: r.created_by,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? r.created_at,
  };
}

function mapPayment(r: Record<string, unknown>) {
  return {
    id: r.id,
    chargeId: r.charge_id,
    tenantId: r.tenant_id,
    amountCents: r.amount_cents,
    method: r.method,
    receivedAt: (r.received_at as Date)?.toISOString?.() ?? r.received_at,
    bankAccountId: r.bank_account_id,
    externalId: r.external_id,
    reference: r.reference,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? r.created_at,
  };
}

function mapInvoice(r: Record<string, unknown>) {
  return {
    id: r.id,
    number: r.number !== undefined && r.number !== null ? Number(r.number) : undefined,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name ?? undefined,
    chargeId: r.charge_id,
    amountCents: r.amount_cents,
    currency: r.currency,
    description: r.description,
    competenceMonth: r.competence_month,
    status: r.status,
    provider: r.provider,
    providerRef: r.provider_ref,
    issuedAt: (r.issued_at as Date)?.toISOString?.() ?? r.issued_at,
    canceledAt: (r.canceled_at as Date)?.toISOString?.() ?? r.canceled_at ?? null,
    createdBy: r.created_by,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? r.created_at,
  };
}

// ── Auditoria append-only (best-effort dentro da mesma transação) ─────────────
async function audit(
  client: PoolClient,
  entityType: "charge" | "payment" | "bank_account" | "invoice" | "tenant",
  entityId: string,
  action: string,
  actorUserId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO finance_audit (entity_type, entity_id, action, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, action, actorUserId, JSON.stringify(detail)],
  );
}

/**
 * recalcChargeStatus — ÚNICO escritor do status de uma cobrança a partir da soma de
 * pagamentos (M3). Não mexe em cobranças `draft`, `canceled` ou `refunded`. Recomputa
 * paid / partially_paid / open a partir do total pago. Deve rodar dentro de uma transação.
 * Retorna { status, paidCents, amountCents } após o recálculo.
 */
export async function recalcChargeStatus(
  client: PoolClient,
  chargeId: string,
): Promise<{ status: string; paidCents: number; amountCents: number } | null> {
  const chargeRes = await client.query(
    `SELECT amount_cents, status FROM charges WHERE id = $1 FOR UPDATE`,
    [chargeId],
  );
  if (chargeRes.rows.length === 0) return null;
  const amountCents = Number(chargeRes.rows[0].amount_cents);
  const current = String(chargeRes.rows[0].status);

  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid FROM payments WHERE charge_id = $1`,
    [chargeId],
  );
  const paidCents = Number(paidRes.rows[0].paid);

  // Estados terminais/manuais não são recomputados por pagamento.
  if (current === "draft" || current === "canceled" || current === "refunded") {
    return { status: current, paidCents, amountCents };
  }

  let next: string;
  if (paidCents >= amountCents && amountCents > 0) next = "paid";
  else if (paidCents > 0) next = "partially_paid";
  else next = "open"; // sem pagamentos: volta a aberto (job de overdue reavalia depois — F2)

  const paidAtExpr = next === "paid" ? "now()" : "NULL";
  await client.query(
    `UPDATE charges SET status = $1, paid_at = ${paidAtExpr} WHERE id = $2`,
    [next, chargeId],
  );
  return { status: next, paidCents, amountCents };
}

/**
 * maybeActivateTenant — RFC-0002 F2. Reativa (ou ativa pela primeira vez) um tenant
 * `inactive`/`suspended` quando ele fica em dia: sem NENHUMA cobrança de assinatura
 * vencida (`overdue`). Idempotente e no-op para tenant já `active`. Roda dentro da
 * transação do pagamento (usa FOR UPDATE para evitar corrida com o job de suspensão).
 * Retorna true se houve ativação (o chamador deve invalidar o cache após o COMMIT).
 */
export async function maybeActivateTenant(
  client: PoolClient,
  tenantId: string,
  actorUserId: string | null,
): Promise<boolean> {
  const t = await client.query(`SELECT status FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
  if (t.rows.length === 0) return false;
  const from = String(t.rows[0].status);
  if (from === "active") return false;
  // Só ativa se estiver em dia com a assinatura (nenhuma cobrança de assinatura vencida).
  const overdue = await client.query(
    `SELECT 1 FROM charges WHERE tenant_id = $1 AND kind = 'subscription' AND status = 'overdue' LIMIT 1`,
    [tenantId],
  );
  if (overdue.rows.length > 0) return false;
  await client.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantId]);
  await audit(client, "tenant", tenantId, "activate", actorUserId, { from, reason: "payment" });
  return true;
}

/**
 * issueInvoiceForCharge — RFC-0002 F3 (MVP interno). Emite (ou recusa) a nota de uma
 * cobrança PAGA. Deve rodar DENTRO de uma transação (o chamador faz BEGIN/COMMIT); usa
 * FOR UPDATE na cobrança para consistência. Regras: cobrança precisa existir e estar
 * `paid`; no máximo UMA nota `issued` por cobrança (dupla emissão → conflito). A emissão
 * passa pela porta InvoiceProvider (stub 'internal' em F3). Retorna a linha da nota
 * emitida ou um erro tipado que o chamador mapeia para HTTP.
 */
export type IssueInvoiceResult =
  | { ok: true; invoice: Record<string, unknown> }
  | { ok: false; httpStatus: number; code: string; message: string };

export async function issueInvoiceForCharge(
  client: PoolClient,
  chargeId: string,
  actorUserId: string | null,
): Promise<IssueInvoiceResult> {
  // Trava a cobrança para derivar dados consistentes e evitar corrida com baixa/estorno.
  const chargeRes = await client.query(
    `SELECT c.id, c.tenant_id, c.amount_cents, c.status, c.competence_month, c.description,
            t.name AS tenant_name
     FROM charges c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = $1 FOR UPDATE OF c`,
    [chargeId],
  );
  if (chargeRes.rows.length === 0) {
    return { ok: false, httpStatus: 404, code: "NOT_FOUND", message: "Cobrança não encontrada" };
  }
  const charge = chargeRes.rows[0];
  // Só emitimos nota de cobrança efetivamente quitada (evita nota sem lastro de caixa).
  if (String(charge.status) !== "paid") {
    return {
      ok: false, httpStatus: 409, code: "CONFLICT",
      message: `Só é possível emitir nota de cobrança paga (status atual: '${charge.status}')`,
    };
  }
  // Pré-checagem amigável de dupla emissão (o índice único parcial é a garantia real).
  const dup = await client.query(
    `SELECT id FROM invoices WHERE charge_id = $1 AND status = 'issued' LIMIT 1`,
    [chargeId],
  );
  if (dup.rows.length > 0) {
    return { ok: false, httpStatus: 409, code: "CONFLICT", message: "Já existe nota emitida para esta cobrança" };
  }

  const description = typeof charge.description === "string" && charge.description.trim()
    ? charge.description.trim()
    : `Nota referente à cobrança ${chargeId}`;
  // Insere reservando o número sequencial; provider_ref é preenchido logo após.
  const ins = await client.query(
    `INSERT INTO invoices
       (tenant_id, charge_id, amount_cents, description, competence_month, status, provider, created_by)
     VALUES ($1,$2,$3,$4,$5,'issued','internal',$6) RETURNING *`,
    [charge.tenant_id, chargeId, charge.amount_cents, description, charge.competence_month, actorUserId],
  );
  const row = ins.rows[0];

  // Porta de emissão (F3 = stub interno, síncrono e sem falha; F4 troca o adaptador).
  const provider = getInvoiceProvider();
  const issued = await provider.issue({
    number: Number(row.number),
    tenantId: String(charge.tenant_id),
    tenantName: charge.tenant_name ?? undefined,
    amountCents: Number(charge.amount_cents),
    competenceMonth: charge.competence_month ?? null,
    description,
    chargeId,
  });
  const upd = await client.query(
    `UPDATE invoices SET provider = $1, provider_ref = $2 WHERE id = $3 RETURNING *`,
    [issued.provider, issued.providerRef, row.id],
  );
  await audit(client, "invoice", String(row.id), "issue", actorUserId, {
    chargeId, tenantId: charge.tenant_id, amountCents: charge.amount_cents,
    provider: issued.provider, providerRef: issued.providerRef,
  });
  // Enriquece a resposta com o nome do tenant (RETURNING * não tem o JOIN) — paridade com o GET.
  const invoice = { ...upd.rows[0], tenant_name: charge.tenant_name ?? null };
  return { ok: true, invoice };
}

export async function financeRoutes(app: FastifyInstance) {
  await app.register(async (authed) => {
    authed.addHook("preHandler", authMiddleware);
    registerFinanceRoutes(authed);
  });
}

function registerFinanceRoutes(app: FastifyInstance) {
  // ═══════════════════ Contas bancárias ═══════════════════
  app.get("/api/finance/bank-accounts", async (request, reply) => {
    if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
    const res = await pool.query(
      `SELECT * FROM company_bank_accounts ORDER BY active DESC, is_default DESC, created_at DESC`,
    );
    return reply.send(res.rows.map(mapBankAccount));
  });

  app.post<{ Body: Record<string, unknown> }>("/api/finance/bank-accounts", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const b = request.body ?? {};
    const label = typeof b.label === "string" ? b.label.trim() : "";
    const bankName = typeof b.bankName === "string" ? b.bankName.trim() : "";
    if (!label) return reply.status(400).send({ code: "BAD_REQUEST", message: "label é obrigatório" });
    if (!bankName) return reply.status(400).send({ code: "BAD_REQUEST", message: "bankName é obrigatório" });
    const accountType = b.accountType;
    if (accountType != null && accountType !== "checking" && accountType !== "savings") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "accountType inválido (checking|savings)" });
    }
    const pixKeyType = b.pixKeyType;
    if (pixKeyType != null && !["cpf", "cnpj", "email", "phone", "random"].includes(String(pixKeyType))) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "pixKeyType inválido" });
    }
    const wantDefault = b.isDefault === true;
    const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Se marcar como padrão, desmarca a anterior (respeita o índice único parcial).
      if (wantDefault) {
        await client.query(`UPDATE company_bank_accounts SET is_default = false WHERE is_default = true`);
      }
      const res = await client.query(
        `INSERT INTO company_bank_accounts
           (label, bank_name, bank_code, agency, account, account_type,
            pix_key, pix_key_type, holder_name, holder_document, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          label, bankName, opt(b.bankCode), opt(b.agency), opt(b.account),
          accountType ?? null, opt(b.pixKey), pixKeyType ?? null,
          opt(b.holderName), opt(b.holderDocument), wantDefault,
        ],
      );
      await audit(client, "bank_account", res.rows[0].id, "create", user.id, { label });
      await client.query("COMMIT");
      return reply.status(201).send(mapBankAccount(res.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Corrida rara: duas criações simultâneas marcando is_default violam o índice único parcial.
      if ((e as { code?: string })?.code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "Já existe uma conta padrão; tente novamente" });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/finance/bank-accounts/:id",
    async (request, reply) => {
      const user = getUser(request);
      if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
      const { id } = request.params;
      const b = request.body ?? {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(`SELECT id FROM company_bank_accounts WHERE id = $1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) {
          await client.query("ROLLBACK");
          return reply.status(404).send({ code: "NOT_FOUND", message: "Conta não encontrada" });
        }
        if (b.isDefault === true) {
          await client.query(`UPDATE company_bank_accounts SET is_default = false WHERE is_default = true AND id <> $1`, [id]);
        }
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        const strFields: Record<string, string> = {
          label: "label", bankName: "bank_name", bankCode: "bank_code", agency: "agency",
          account: "account", pixKey: "pix_key", holderName: "holder_name", holderDocument: "holder_document",
        };
        for (const [k, col] of Object.entries(strFields)) {
          if (typeof b[k] === "string") { sets.push(`${col} = $${i++}`); vals.push((b[k] as string).trim() || null); }
        }
        if (b.accountType === "checking" || b.accountType === "savings" || b.accountType === null) {
          sets.push(`account_type = $${i++}`); vals.push(b.accountType);
        }
        if (typeof b.pixKeyType === "string" && ["cpf","cnpj","email","phone","random"].includes(b.pixKeyType)) {
          sets.push(`pix_key_type = $${i++}`); vals.push(b.pixKeyType);
        }
        if (typeof b.isDefault === "boolean") { sets.push(`is_default = $${i++}`); vals.push(b.isDefault); }
        if (typeof b.active === "boolean") { sets.push(`active = $${i++}`); vals.push(b.active); }
        if (sets.length === 0) {
          await client.query("ROLLBACK");
          return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum campo válido para atualizar" });
        }
        vals.push(id);
        const res = await client.query(
          `UPDATE company_bank_accounts SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals,
        );
        await audit(client, "bank_account", id, "update", user.id, { fields: Object.keys(b) });
        await client.query("COMMIT");
        return reply.send(mapBankAccount(res.rows[0]));
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  );

  // DELETE = soft-delete (active=false); nunca apaga (preserva referência em payments).
  app.delete<{ Params: { id: string } }>("/api/finance/bank-accounts/:id", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `UPDATE company_bank_accounts SET active = false, is_default = false WHERE id = $1 RETURNING id`, [id],
      );
      if (res.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Conta não encontrada" });
      }
      await audit(client, "bank_account", id, "deactivate", user.id, {});
      await client.query("COMMIT");
      return reply.status(204).send();
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  // ═══════════════════ Cobranças ═══════════════════
  app.get<{ Querystring: { tenantId?: string; status?: string; competence?: string } }>(
    "/api/finance/charges",
    async (request, reply) => {
      if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
      const q = request.query ?? {};
      const conds: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (q.tenantId) { conds.push(`c.tenant_id = $${i++}`); vals.push(q.tenantId); }
      if (q.status) { conds.push(`c.status = $${i++}`); vals.push(q.status); }
      if (q.competence) { conds.push(`c.competence_month = $${i++}`); vals.push(q.competence); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const res = await pool.query(
        `SELECT c.*, t.name AS tenant_name,
                COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.charge_id = c.id), 0)::bigint AS paid_cents
         FROM charges c JOIN tenants t ON t.id = c.tenant_id
         ${where}
         ORDER BY c.created_at DESC LIMIT 500`,
        vals,
      );
      return reply.send(res.rows.map(mapCharge));
    },
  );

  app.get<{ Params: { id: string } }>("/api/finance/charges/:id", async (request, reply) => {
    if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
    const res = await pool.query(
      `SELECT c.*, t.name AS tenant_name,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.charge_id = c.id), 0)::bigint AS paid_cents
       FROM charges c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`,
      [request.params.id],
    );
    if (res.rows.length === 0) return reply.status(404).send({ code: "NOT_FOUND", message: "Cobrança não encontrada" });
    const payments = await pool.query(
      `SELECT * FROM payments WHERE charge_id = $1 ORDER BY received_at DESC`, [request.params.id],
    );
    return reply.send({ ...mapCharge(res.rows[0]), payments: payments.rows.map(mapPayment) });
  });

  app.post<{ Body: Record<string, unknown> }>("/api/finance/charges", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const b = request.body ?? {};
    const tenantId = typeof b.tenantId === "string" ? b.tenantId.trim() : "";
    if (!tenantId) return reply.status(400).send({ code: "BAD_REQUEST", message: "tenantId é obrigatório" });
    // Criação manual exige valor > 0: uma cobrança de 0 centavo nunca poderia ser quitada
    // (recalc só marca 'paid' com amount > 0) e ficaria presa em aberto.
    if (!isPositiveCents(b.amountCents)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "amountCents deve ser inteiro > 0 (centavos)" });
    }
    const kind = typeof b.kind === "string" && (CHARGE_KINDS as readonly string[]).includes(b.kind) ? b.kind : "one_off";
    if (b.competenceMonth != null && !isCompetence(b.competenceMonth)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "competenceMonth inválido (YYYY-MM)" });
    }
    if (kind === "subscription" && !isCompetence(b.competenceMonth)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "cobrança de assinatura exige competenceMonth (YYYY-MM)" });
    }
    const tenant = await pool.query(`SELECT id, plan_id FROM tenants WHERE id = $1`, [tenantId]);
    if (tenant.rows.length === 0) return reply.status(404).send({ code: "NOT_FOUND", message: "Tenant não encontrado" });

    const competence = isCompetence(b.competenceMonth) ? (b.competenceMonth as string) : null;
    const dueDate = typeof b.dueDate === "string" && b.dueDate.trim() ? b.dueDate.trim()
      : competence ? defaultDueDate(competence) : null;
    const planId = typeof b.planId === "string" ? b.planId : tenant.rows[0].plan_id ?? null;
    const description = typeof b.description === "string" ? b.description.trim() || null : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO charges
           (tenant_id, plan_id, amount_cents, description, competence_month, kind, due_date, status, issued_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',now(),$8) RETURNING *`,
        [tenantId, planId, b.amountCents, description, competence, kind, dueDate, user.id],
      );
      await audit(client, "charge", res.rows[0].id, "create", user.id, { tenantId, amountCents: b.amountCents, kind, competence });
      await client.query("COMMIT");
      return reply.status(201).send(mapCharge(res.rows[0]));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if ((e as { code?: string })?.code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "Já existe cobrança de assinatura para este tenant/competência" });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/finance/charges/generate-month — gera a cobrança de ASSINATURA da competência
   * para cada tenant elegível (plano com preço > 0). Idempotente: o índice único parcial
   * (tenant_id, competence_month) WHERE kind='subscription' evita duplicar. Inclui tenants
   * 'inactive' e 'active' (H2): a primeira competência cobra também quem acabou de assinar.
   */
  app.post<{ Body: { competence?: string } }>("/api/finance/charges/generate-month", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const competence = request.body?.competence;
    if (!isCompetence(competence)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "competence inválido (YYYY-MM)" });
    }
    const dueDate = defaultDueDate(competence);
    // Elegíveis: tenants ATIVOS sempre; tenants INATIVOS somente na PRIMEIRA cobrança de
    // assinatura (H2 / B.4) — enquanto a ativação-por-pagamento não existe (F2), um inativo
    // nunca vira ativo, então incluí-lo em toda competência mintaria cobranças-fantasma que
    // nunca serão pagas. O NOT EXISTS garante que o inativo só é cobrado se ainda não tiver
    // NENHUMA cobrança de assinatura (a de onboarding do signup já o exclui daqui).
    const tenants = await pool.query(
      `SELECT t.id, t.plan_id, p.monthly_price_cents
       FROM tenants t JOIN plans p ON p.id = t.plan_id
       WHERE COALESCE(p.monthly_price_cents, 0) > 0
         AND t.billing_exempt = false
         AND (
           t.status = 'active'
           OR (t.status = 'inactive' AND NOT EXISTS (
             SELECT 1 FROM charges c
             WHERE c.tenant_id = t.id AND c.kind = 'subscription' AND c.status <> 'canceled'
           ))
         )`,
    );
    let created = 0;
    let skipped = 0;
    const client = await pool.connect();
    try {
      for (const t of tenants.rows) {
        await client.query("BEGIN");
        try {
          const res = await client.query(
            `INSERT INTO charges
               (tenant_id, plan_id, amount_cents, description, competence_month, kind, due_date, status, issued_at, created_by)
             VALUES ($1,$2,$3,$4,$5,'subscription',$6,'open',now(),$7)
             ON CONFLICT (tenant_id, competence_month) WHERE kind = 'subscription' AND status <> 'canceled'
             DO NOTHING RETURNING id`,
            [t.id, t.plan_id, t.monthly_price_cents, `Assinatura ${competence}`, competence, dueDate, user.id],
          );
          if (res.rows.length > 0) {
            await audit(client, "charge", res.rows[0].id, "generate_month", user.id, { competence });
            created++;
          } else {
            skipped++;
          }
          await client.query("COMMIT");
        } catch (inner) {
          await client.query("ROLLBACK").catch(() => {});
          skipped++;
        }
      }
    } finally {
      client.release();
    }
    return reply.send({ competence, created, skipped, eligible: tenants.rows.length });
  });

  /**
   * PATCH /api/finance/charges/:id — ajustar (só enquanto 'draft') ou CANCELAR.
   * Imutabilidade (M5): após sair de 'draft', só se permite cancelar (e apenas se não paga).
   */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/finance/charges/:id",
    async (request, reply) => {
      const user = getUser(request);
      if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
      const { id } = request.params;
      const b = request.body ?? {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const cur = await client.query(`SELECT * FROM charges WHERE id = $1 FOR UPDATE`, [id]);
        if (cur.rows.length === 0) {
          await client.query("ROLLBACK");
          return reply.status(404).send({ code: "NOT_FOUND", message: "Cobrança não encontrada" });
        }
        const charge = cur.rows[0];

        // Cancelamento explícito.
        if (b.status === "canceled") {
          if (charge.status === "paid" || charge.status === "partially_paid") {
            await client.query("ROLLBACK");
            return reply.status(409).send({ code: "CONFLICT", message: "Cobrança com pagamento não pode ser cancelada; use estorno (F4)" });
          }
          const res = await client.query(`UPDATE charges SET status = 'canceled' WHERE id = $1 RETURNING *`, [id]);
          await audit(client, "charge", id, "cancel", user.id, {});
          await client.query("COMMIT");
          return reply.send(mapCharge(res.rows[0]));
        }

        // Ajuste de campos: apenas enquanto 'draft'.
        if (charge.status !== "draft") {
          await client.query("ROLLBACK");
          return reply.status(409).send({ code: "CONFLICT", message: "Cobrança imutável após emitida; só é possível cancelar" });
        }
        const sets: string[] = [];
        const vals: unknown[] = [];
        let i = 1;
        if (isCents(b.amountCents)) { sets.push(`amount_cents = $${i++}`); vals.push(b.amountCents); }
        if (typeof b.description === "string") { sets.push(`description = $${i++}`); vals.push(b.description.trim() || null); }
        if (typeof b.dueDate === "string" && b.dueDate.trim()) { sets.push(`due_date = $${i++}`); vals.push(b.dueDate.trim()); }
        if (b.status === "open") { sets.push(`status = 'open'`); sets.push(`issued_at = now()`); }
        if (sets.length === 0) {
          await client.query("ROLLBACK");
          return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum campo válido para atualizar" });
        }
        vals.push(id);
        const res = await client.query(`UPDATE charges SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals);
        await audit(client, "charge", id, "adjust", user.id, { fields: Object.keys(b) });
        await client.query("COMMIT");
        return reply.send(mapCharge(res.rows[0]));
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  );

  // ═══════════════════ Pagamentos ═══════════════════
  app.get<{ Querystring: { tenantId?: string; chargeId?: string } }>(
    "/api/finance/payments",
    async (request, reply) => {
      if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
      const q = request.query ?? {};
      const conds: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (q.tenantId) { conds.push(`tenant_id = $${i++}`); vals.push(q.tenantId); }
      if (q.chargeId) { conds.push(`charge_id = $${i++}`); vals.push(q.chargeId); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const res = await pool.query(`SELECT * FROM payments ${where} ORDER BY received_at DESC LIMIT 500`, vals);
      return reply.send(res.rows.map(mapPayment));
    },
  );

  // POST /api/finance/payments — baixa manual; recalcula o status da cobrança (M3).
  app.post<{ Body: Record<string, unknown> }>("/api/finance/payments", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const b = request.body ?? {};
    const chargeId = typeof b.chargeId === "string" ? b.chargeId.trim() : "";
    if (!chargeId) return reply.status(400).send({ code: "BAD_REQUEST", message: "chargeId é obrigatório" });
    if (!isPositiveCents(b.amountCents)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "amountCents deve ser inteiro > 0 (centavos)" });
    }
    const method = typeof b.method === "string" ? b.method : "";
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `method inválido (${PAYMENT_METHODS.join("|")})` });
    }
    const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const receivedAt = typeof b.receivedAt === "string" && b.receivedAt.trim() ? b.receivedAt.trim() : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const charge = await client.query(`SELECT id, tenant_id, status, kind FROM charges WHERE id = $1 FOR UPDATE`, [chargeId]);
      if (charge.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Cobrança não encontrada" });
      }
      // Só aceita baixa em cobrança emitida e não liquidada. Bloqueia draft (não emitida),
      // paid (já quitada), canceled e refunded — senão o pagamento entraria no caixa
      // (summary conta todos os payments) sem refletir no status da cobrança.
      const chargeStatus = String(charge.rows[0].status);
      if (!(PAYABLE_STATUSES as readonly string[]).includes(chargeStatus)) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Não é possível registrar pagamento em cobrança '${chargeStatus}'`,
        });
      }
      const tenantId = charge.rows[0].tenant_id;
      const chargeKind = String(charge.rows[0].kind);
      const insert = await client.query(
        `INSERT INTO payments
           (charge_id, tenant_id, amount_cents, method, received_at, bank_account_id, external_id, reference, notes, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7,$8,$9,$10) RETURNING *`,
        [chargeId, tenantId, b.amountCents, method, receivedAt, opt(b.bankAccountId), opt(b.externalId), opt(b.reference), opt(b.notes), user.id],
      );
      const recalc = await recalcChargeStatus(client, chargeId);
      // Reflete o método de pagamento predominante na cobrança quando quitada.
      let activated = false;
      if (recalc?.status === "paid") {
        await client.query(`UPDATE charges SET payment_method = $1 WHERE id = $2`, [method, chargeId]);
        // F2: só o pagamento de uma cobrança de ASSINATURA reativa o tenant. Quitar uma
        // cobrança avulsa (one_off/proration/setup) NÃO deve ligar um tenant novo que nunca
        // pagou assinatura, nem reverter uma suspensão manual do master feita por outro
        // motivo (abuso/legal). O gatilho de "voltar a ativo" é a assinatura em dia.
        if (chargeKind === "subscription") {
          activated = await maybeActivateTenant(client, tenantId, user.id);
        }
      }
      await audit(client, "payment", insert.rows[0].id, "create", user.id, { chargeId, amountCents: b.amountCents, method, chargeStatus: recalc?.status });
      await client.query("COMMIT");
      // Invalida o cache de status SÓ após o COMMIT (senão outra requisição recacheia o valor antigo).
      if (activated) bustTenantStatus(tenantId);
      return reply.status(201).send({ payment: mapPayment(insert.rows[0]), charge: recalc, tenantActivated: activated });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if ((e as { code?: string })?.code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "Pagamento duplicado (external_id já registrado)" });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  // ═══════════════════ Sumário ═══════════════════
  app.get("/api/finance/summary", async (request, reply) => {
    if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
    // MRR = soma dos preços mensais dos planos de tenants ativos (visão de assinatura recorrente).
    const mrr = await pool.query(
      `SELECT COALESCE(SUM(p.monthly_price_cents), 0)::bigint AS mrr
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.status = 'active'`,
    );
    // "Em aberto" = valor AINDA A RECEBER (amount - já pago), não o valor cheio da cobrança,
    // senão a parcela já recebida seria contada duas vezes (aqui e em "recebido no mês").
    const open = await pool.query(
      `SELECT COALESCE(SUM(c.amount_cents - COALESCE(pp.paid, 0)), 0)::bigint AS total, COUNT(*)::int AS n
       FROM charges c
       LEFT JOIN (SELECT charge_id, SUM(amount_cents) AS paid FROM payments GROUP BY charge_id) pp
         ON pp.charge_id = c.id
       WHERE c.status IN ('open', 'partially_paid')`,
    );
    const overdue = await pool.query(
      `SELECT COALESCE(SUM(c.amount_cents - COALESCE(pp.paid, 0)), 0)::bigint AS total, COUNT(*)::int AS n
       FROM charges c
       LEFT JOIN (SELECT charge_id, SUM(amount_cents) AS paid FROM payments GROUP BY charge_id) pp
         ON pp.charge_id = c.id
       WHERE c.status = 'overdue'`,
    );
    // Recebido no mês corrente no fuso America/Sao_Paulo (L1).
    const received = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total, COUNT(*)::int AS n
       FROM payments
       WHERE date_trunc('month', received_at AT TIME ZONE 'America/Sao_Paulo')
           = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`,
    );
    return reply.send({
      currency: "BRL",
      mrrCents: Number(mrr.rows[0].mrr),
      openCents: Number(open.rows[0].total),
      openCount: open.rows[0].n,
      overdueCents: Number(overdue.rows[0].total),
      overdueCount: overdue.rows[0].n,
      receivedThisMonthCents: Number(received.rows[0].total),
      receivedThisMonthCount: received.rows[0].n,
    });
  });

  // ═══════════════════ Notas fiscais (invoices) — F3 (MVP interno) ═══════════════════
  app.get<{ Querystring: { tenantId?: string; status?: string; competence?: string } }>(
    "/api/finance/invoices",
    async (request, reply) => {
      if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
      const q = request.query ?? {};
      const conds: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (q.tenantId) { conds.push(`inv.tenant_id = $${i++}`); vals.push(q.tenantId); }
      if (q.status) { conds.push(`inv.status = $${i++}`); vals.push(q.status); }
      if (q.competence) { conds.push(`inv.competence_month = $${i++}`); vals.push(q.competence); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const res = await pool.query(
        `SELECT inv.*, t.name AS tenant_name
         FROM invoices inv JOIN tenants t ON t.id = inv.tenant_id
         ${where}
         ORDER BY inv.number DESC LIMIT 500`,
        vals,
      );
      return reply.send(res.rows.map(mapInvoice));
    },
  );

  app.get<{ Params: { id: string } }>("/api/finance/invoices/:id", async (request, reply) => {
    if (!requireAdmin(getUser(request))) return reply.status(403).send(FORBIDDEN);
    const res = await pool.query(
      `SELECT inv.*, t.name AS tenant_name
       FROM invoices inv JOIN tenants t ON t.id = inv.tenant_id WHERE inv.id = $1`,
      [request.params.id],
    );
    if (res.rows.length === 0) return reply.status(404).send({ code: "NOT_FOUND", message: "Nota não encontrada" });
    return reply.send(mapInvoice(res.rows[0]));
  });

  /**
   * POST /api/finance/invoices — emite uma nota (interna) a partir de uma cobrança PAGA.
   * Deriva tenant/valor/competência/descrição da própria cobrança. Uma cobrança só pode
   * ter UMA nota emitida por vez (índice único parcial); dupla emissão → 409. Cancelar a
   * nota libera reemissão. A emissão passa pela porta InvoiceProvider (stub 'internal' em F3).
   */
  app.post<{ Body: { chargeId?: string } }>("/api/finance/invoices", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const chargeId = typeof request.body?.chargeId === "string" ? request.body.chargeId.trim() : "";
    if (!chargeId) return reply.status(400).send({ code: "BAD_REQUEST", message: "chargeId é obrigatório" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await issueInvoiceForCharge(client, chargeId, user.id);
      if (!result.ok) {
        await client.query("ROLLBACK");
        return reply.status(result.httpStatus).send({ code: result.code, message: result.message });
      }
      await client.query("COMMIT");
      return reply.status(201).send(mapInvoice(result.invoice));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Corrida de dupla emissão barrada pelo índice único parcial.
      if ((e as { code?: string })?.code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "Já existe nota emitida para esta cobrança" });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  // POST /api/finance/invoices/:id/cancel — cancela uma nota emitida (libera reemissão da cobrança).
  app.post<{ Params: { id: string } }>("/api/finance/invoices/:id/cancel", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) return reply.status(403).send(FORBIDDEN);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        `SELECT inv.id, inv.status, t.name AS tenant_name
         FROM invoices inv JOIN tenants t ON t.id = inv.tenant_id
         WHERE inv.id = $1 FOR UPDATE OF inv`,
        [id],
      );
      if (cur.rows.length === 0) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ code: "NOT_FOUND", message: "Nota não encontrada" });
      }
      if (String(cur.rows[0].status) === "canceled") {
        await client.query("ROLLBACK");
        return reply.status(409).send({ code: "CONFLICT", message: "Nota já está cancelada" });
      }
      const res = await client.query(
        `UPDATE invoices SET status = 'canceled', canceled_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      await audit(client, "invoice", id, "cancel", user.id, {});
      await client.query("COMMIT");
      // Paridade com o GET: inclui tenantName (o RETURNING * não tem o JOIN).
      return reply.send(mapInvoice({ ...res.rows[0], tenant_name: cur.rows[0].tenant_name }));
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}
