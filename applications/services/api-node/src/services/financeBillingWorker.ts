/**
 * financeBillingWorker.ts — RFC-0002 Parte B (F2).
 *
 * Job periódico do ciclo de vida da assinatura (roda no api-node via setInterval):
 *   1. Vencimento: cobranças `open`/`partially_paid` com due_date no passado
 *      (fuso America/Sao_Paulo, L1) → `overdue`.
 *   2. Suspensão por inadimplência: tenant `active` que tenha cobrança de ASSINATURA
 *      `overdue` há mais de FINANCE_SUSPEND_GRACE_DAYS (default 3) → `suspended`.
 *
 * A REATIVAÇÃO não é feita aqui — ela acontece na baixa do pagamento
 * (maybeActivateTenant em routes/finance.ts). Assim o único gatilho de "voltar a
 * ativo" é dinheiro entrando, evitando flapping.
 *
 * Não toca cobranças `draft`, `paid`, `canceled`, `refunded` nem tenants não-ativos.
 */
import { pool } from "../db/client.js";
import { bustTenantStatus } from "./tenantStatusCache.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

const INTERVAL_MS = Number(process.env.FINANCE_BILLING_INTERVAL_MS ?? 60 * 60 * 1000); // 1h
const SUSPEND_GRACE_DAYS = Math.max(0, Number(process.env.FINANCE_SUSPEND_GRACE_DAYS ?? 3));

export async function runFinanceBillingOnce(): Promise<{ markedOverdue: number; suspended: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Vencimento — só cobranças ativas de fato (open/partially_paid) e com prazo no passado.
    const overdue = await client.query<{ id: string }>(
      `UPDATE charges
          SET status = 'overdue'
        WHERE status IN ('open', 'partially_paid')
          AND due_date IS NOT NULL
          AND due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
      RETURNING id`,
    );

    // 2) Suspensão — tenant ativo com assinatura vencida além do período de carência.
    //    Tenants internos isentos (billing_exempt) nunca são suspensos por inadimplência.
    const suspended = await client.query<{ id: string }>(
      `UPDATE tenants t
          SET status = 'suspended'
        WHERE t.status = 'active'
          AND t.billing_exempt = false
          AND EXISTS (
            SELECT 1 FROM charges c
             WHERE c.tenant_id = t.id
               AND c.kind = 'subscription'
               AND c.status = 'overdue'
               AND c.due_date < ((now() AT TIME ZONE 'America/Sao_Paulo')::date - $1::int)
          )
      RETURNING id`,
      [SUSPEND_GRACE_DAYS],
    );

    for (const r of suspended.rows) {
      await client.query(
        `INSERT INTO finance_audit (entity_type, entity_id, action, actor_user_id, detail)
         VALUES ('tenant', $1, 'suspend', NULL, $2)`,
        [r.id, JSON.stringify({ reason: "overdue", graceDays: SUSPEND_GRACE_DAYS })],
      );
    }

    await client.query("COMMIT");

    // Invalida o cache de status só após o COMMIT (visibilidade correta).
    for (const r of suspended.rows) bustTenantStatus(r.id);

    if (overdue.rowCount || suspended.rowCount) {
      console.info(
        `[finance-billing] overdue=${overdue.rowCount ?? 0} suspended=${suspended.rowCount ?? 0} (grace=${SUSPEND_GRACE_DAYS}d)`,
      );
    }
    return { markedOverdue: overdue.rowCount ?? 0, suspended: suspended.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Executa uma passada com guarda de reentrância — se uma já estiver em voo, pula esta. */
export async function tick(): Promise<void> {
  if (running) {
    console.warn("[finance-billing] passada anterior ainda em execução — pulando este tick");
    return;
  }
  running = true;
  try {
    await runFinanceBillingOnce();
  } catch (err) {
    console.error("[finance-billing] erro:", err);
  } finally {
    running = false;
  }
}

export function startFinanceBillingWorker(): void {
  if (timer) {
    console.warn("[finance-billing] worker já iniciado — ignorando start duplicado");
    return;
  }
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  console.info(`[finance-billing] iniciado (intervalo=${INTERVAL_MS / 1000 / 60}min, carência=${SUSPEND_GRACE_DAYS}d)`);

  // Roda uma vez logo após o boot (pega backlog imediato).
  setTimeout(() => { void tick(); }, 30_000);
}

export function stopFinanceBillingWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
