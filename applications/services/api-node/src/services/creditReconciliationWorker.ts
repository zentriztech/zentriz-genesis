/**
 * creditReconciliationWorker.ts — Reconciliação do ledger de crédito como INVARIANTE agendada
 * (decisão B do Jean: worker Node dentro da API, padrão financeBillingWorker; sem cron no host).
 *
 * Roda as 4 invariantes da §7 do plano a cada ciclo e ALERTA (console.error) em qualquer
 * violação. É uma rede de segurança redundante com os triggers 065b (append-only + zero-sum):
 *   (1) zero-sum por transação            — guarda contra trigger desabilitado;
 *   (2) saldo nunca negativo;
 *   (3) header denormalizado casa com as pernas (LEFT JOIN pega header órfã sem pernas);
 *   (4) Σconsume == Σpayments(method='credit') por tenant.
 * NÃO escreve nada — só verifica e alerta (o consumo é aplicado no passo de generate-month).
 */
import { pool } from "../db/client.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

const INTERVAL_MS = Number(process.env.CREDIT_RECON_INTERVAL_MS ?? 60 * 60 * 1000); // 1h

export interface ReconciliationReport {
  unbalancedTransactions: string[]; // (1) transaction_id com pernas que não somam zero
  negativeBalances: string[]; // (2) tenant_id com saldo < 0
  headerLegMismatches: string[]; // (3) transaction_id com header != pernas (ou sem pernas)
  consumeVsPaymentMismatches: Array<{ tenantId: string; consumido: number; pagoCredito: number }>; // (4)
  ok: boolean;
}

export async function runCreditReconciliationOnce(): Promise<ReconciliationReport> {
  // (1) zero-sum por transação (redundante com o trigger; guarda contra trigger desabilitado).
  const unbalanced = await pool.query<{ transaction_id: string }>(
    `SELECT transaction_id FROM credit_ledger_entries
      GROUP BY transaction_id
     HAVING SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END) <> 0`,
  );

  // (2) saldo nunca negativo.
  const negative = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_credit_balance WHERE balance_cents < 0`,
  );

  // (3) header denormalizado casa com as pernas. LEFT JOIN + one_side IS NULL pega header órfã.
  const mismatch = await pool.query<{ id: string }>(
    `SELECT t.id FROM credit_ledger_transactions t
     LEFT JOIN (SELECT transaction_id, SUM(amount_cents) FILTER (WHERE direction='credit') AS one_side
                  FROM credit_ledger_entries GROUP BY transaction_id) s ON s.transaction_id = t.id
     WHERE s.one_side IS NULL OR t.amount_cents <> s.one_side`,
  );

  // (4) consumo casado com pagamentos-crédito por tenant (só linhas divergentes).
  const consumeVsPayment = await pool.query<{ tenant_id: string; consumido: string; pago_credito: string }>(
    `SELECT c.tenant_id,
            COALESCE(SUM(c.amount_cents) FILTER (WHERE c.entry_type='consume'), 0) AS consumido,
            (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p
              WHERE p.method='credit' AND p.tenant_id=c.tenant_id) AS pago_credito
       FROM credit_ledger_transactions c
      GROUP BY c.tenant_id
     HAVING COALESCE(SUM(c.amount_cents) FILTER (WHERE c.entry_type='consume'), 0)
            <> (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p
                 WHERE p.method='credit' AND p.tenant_id=c.tenant_id)`,
  );

  const report: ReconciliationReport = {
    unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
    negativeBalances: negative.rows.map((r) => r.tenant_id),
    headerLegMismatches: mismatch.rows.map((r) => r.id),
    consumeVsPaymentMismatches: consumeVsPayment.rows.map((r) => ({
      tenantId: r.tenant_id,
      consumido: Number(r.consumido),
      pagoCredito: Number(r.pago_credito),
    })),
    ok: false,
  };
  report.ok =
    report.unbalancedTransactions.length === 0 &&
    report.negativeBalances.length === 0 &&
    report.headerLegMismatches.length === 0 &&
    report.consumeVsPaymentMismatches.length === 0;

  if (!report.ok) {
    // Qualquer linha retornada é uma violação de invariante — alerta imediato e ruidoso.
    console.error("[credit-recon] VIOLAÇÃO DE INVARIANTE DO LEDGER DE CRÉDITO:", JSON.stringify(report));
  }
  return report;
}

/** Executa uma passada com guarda de reentrância — se uma já estiver em voo, pula esta. */
export async function tick(): Promise<void> {
  if (running) {
    console.warn("[credit-recon] passada anterior ainda em execução — pulando este tick");
    return;
  }
  running = true;
  try {
    await runCreditReconciliationOnce();
  } catch (err) {
    console.error("[credit-recon] erro:", err);
  } finally {
    running = false;
  }
}

export function startCreditReconciliationWorker(): void {
  if (timer) {
    console.warn("[credit-recon] worker já iniciado — ignorando start duplicado");
    return;
  }
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  console.info(`[credit-recon] iniciado (intervalo=${INTERVAL_MS / 1000 / 60}min)`);
  // Roda uma vez logo após o boot.
  setTimeout(() => { void tick(); }, 45_000);
}

export function stopCreditReconciliationWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
