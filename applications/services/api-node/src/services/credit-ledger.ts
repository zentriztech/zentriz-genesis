/**
 * credit-ledger.ts — Serviço do ledger de crédito de cortesia (RFC-0002 / Plano de Créditos).
 *
 * Ledger de dupla entrada, append-only: o saldo é DERIVADO da soma das pernas
 * (view tenant_credit_balance), nunca um campo mutável. A CONCESSÃO (grant) e o ESTORNO
 * (reversal) são injeção manual server-side via psql (sem API — ver §1.4 do plano). Este
 * módulo expõe apenas LEITURA de saldo (getBalance) e o CONSUMO acoplado ao ciclo
 * (consumeEligibleCharges), disparado após o loop de generate-month.
 *
 * SQL isolado aqui (hexagonal). Guards de append-only/zero-sum vivem em 065b (triggers, psql).
 */
import { pool } from "../db/client.js";
import { bustTenantStatus } from "./tenantStatusCache.js";
// Import cruzado com finance.ts: usado só em call-time (runtime), nunca na inicialização do
// módulo — o ciclo ESM resolve porque os bindings já estão populados quando estas funções rodam.
import { recalcChargeStatus, maybeActivateTenant, audit } from "../routes/finance.js";

/**
 * getBalance — saldo de crédito disponível (centavos) do tenant. 0 se não houver lançamentos.
 * Derivado da view tenant_credit_balance (Σcredit − Σdebit na conta tenant_credit).
 */
export async function getBalance(tenantId: string): Promise<number> {
  const r = await pool.query(
    `SELECT balance_cents FROM tenant_credit_balance WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.balance_cents ?? 0;
}

// Charges de assinatura da competência ainda com saldo devedor, de tenants COM crédito.
// Seleção por EXISTÊNCIA da charge (não pelo RETURNING de um INSERT): cobre charges de
// onboarding (signup) e criação manual, e inclui tenants 'suspended' (habilita reativação).
const ELIGIBLE_CONSUME_SQL = `
  SELECT c.id AS charge_id, c.tenant_id, c.amount_cents,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.charge_id = c.id), 0) AS paid_cents,
         b.balance_cents
  FROM charges c
  JOIN tenant_credit_balance b ON b.tenant_id = c.tenant_id
  WHERE c.kind = 'subscription'
    AND c.competence_month = $1
    AND c.status IN ('open','partially_paid','overdue')
    AND b.balance_cents > 0`;

export interface ConsumeResult {
  competence: string;
  eligible: number;
  consumed: number; // nº de charges efetivamente abatidas (aplicou > 0)
  appliedCents: number; // total de crédito aplicado no ciclo
  activatedTenants: string[];
}

/**
 * consumeEligibleCharges — passo de CONSUMO por existência (§4 do plano). Roda após o loop
 * de geração de generate-month, na mesma competência. Para cada charge de assinatura em
 * aberto de um tenant com saldo, abate por crédito dentro de sua própria transação com
 * advisory lock por tenant (mesma chave de grant/reversal → serializa cálculo de saldo).
 * Idempotente por competência (uq_credit_tx_consume_competence + uq_payments_method_external).
 * Retorna o resumo do ciclo; o cache de status é invalidado APÓS o commit.
 */
export async function consumeEligibleCharges(competence: string): Promise<ConsumeResult> {
  const activatedTenants = new Set<string>();
  let consumed = 0;
  let appliedTotal = 0;

  const eligible = await pool.query(ELIGIBLE_CONSUME_SQL, [competence]);
  for (const row of eligible.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Mesma chave de lock de grant/reversal (§3): serializa todo cálculo/gravação de saldo.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [row.tenant_id]);
      // Re-ler saldo e pago DENTRO da tx (sob lock) — não confiar no snapshot da seleção.
      const bal = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0)::int AS b
           FROM credit_ledger_entries WHERE account='tenant_credit' AND tenant_id=$1`,
        [row.tenant_id],
      );
      const paid = await client.query(
        `SELECT COALESCE(SUM(amount_cents),0)::int AS p FROM payments WHERE charge_id=$1`,
        [row.charge_id],
      );
      const outstanding = Number(row.amount_cents) - paid.rows[0].p;
      const applied = Math.min(bal.rows[0].b, outstanding);
      if (applied > 0) {
        const tx = await client.query(
          `INSERT INTO credit_ledger_transactions
             (tenant_id, entry_type, amount_cents, competence_month, charge_id, idempotency_key, memo, created_by)
           VALUES ($1,'consume',$2,$3,$4,$5,'Abatimento automatico de credito no ciclo',NULL)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
          [row.tenant_id, applied, competence, row.charge_id, `consume:${row.tenant_id}:${competence}`],
        );
        if (tx.rows[0]) {
          const txId = tx.rows[0].id;
          // Pernas: tenant_credit debit / billing_consumption credit (zero-sum validado no commit).
          await client.query(
            `INSERT INTO credit_ledger_entries (transaction_id, tenant_id, account, direction, amount_cents)
             VALUES ($1,$2,'tenant_credit','debit',$3),($1,$2,'billing_consumption','credit',$3)`,
            [txId, row.tenant_id, applied],
          );
          // uq_payments_method_external (054) é índice PARCIAL (WHERE external_id IS NOT NULL):
          // o predicado é OBRIGATÓRIO no ON CONFLICT, senão Postgres lança 42P10.
          await client.query(
            `INSERT INTO payments (charge_id, tenant_id, amount_cents, method, external_id, reference, created_by)
             VALUES ($1,$2,$3,'credit',$4,'credit-auto',NULL)
             ON CONFLICT (method, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
            [row.charge_id, row.tenant_id, applied, `credit:${row.tenant_id}:${competence}`],
          );
          const rc = await recalcChargeStatus(client, row.charge_id);
          if (rc?.status === "paid") {
            const act = await maybeActivateTenant(client, row.tenant_id, null);
            if (act) activatedTenants.add(row.tenant_id);
          }
          await audit(client, "credit_ledger", txId, "consume", null, {
            competence,
            applied,
            chargeId: row.charge_id,
          });
          consumed++;
          appliedTotal += applied;
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  // Invalida cache de status SÓ após o COMMIT (padrão finance.ts / financeBillingWorker).
  for (const tId of activatedTenants) bustTenantStatus(tId);

  return {
    competence,
    eligible: eligible.rows.length,
    consumed,
    appliedCents: appliedTotal,
    activatedTenants: [...activatedTenants],
  };
}
