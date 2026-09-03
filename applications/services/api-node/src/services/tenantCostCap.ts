/**
 * tenantCostCap.ts — Cost cap MENSAL de LLM por TENANT (migration 068).
 *
 * Fecha o risco de denial-of-wallet: até aqui só existia gate POR PROJETO
 * (T18, MAX_USD_PER_PROJECT no runner) — um tenant podia disparar N projetos
 * e multiplicar o gasto sem teto agregado.
 *
 * Precedência do teto: tenants.monthly_llm_budget_usd > plans.monthly_llm_budget_usd
 * > env TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT (unset/0/inválido = sem cap).
 * NULL em tenant E plano + env ausente ⇒ SEM CAP (fail-safe: comportamento atual).
 *
 * Fonte de gasto (RFC-0004 D4 — fonte ÚNICA): project_agent_metrics (migration 003),
 * alimentada via POST /agent-metrics; custo estimado com a tabela única de preços por
 * modelo (lib/modelPricing.ts). A antiga pipeline_cost_ledger (027) era dead table
 * (zero INSERTs desde sempre) e foi dropada na migration 073.
 */

import { priceCaseSql } from "../lib/modelPricing.js";

/** Interface mínima de acesso ao banco (aceita Pool ou PoolClient; facilita mock em teste). */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export type TenantBudgetCheck =
  | { ok: true }
  | { ok: false; spentUsd: number; budgetUsd: number };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Primeiro dia do mês (YYYY-MM-01). Default: mês corrente em UTC (containers rodam em UTC). */
function monthStartDate(month?: string): string {
  if (month && MONTH_RE.test(month)) return `${month}-01`;
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Preço por modelo — FONTE ÚNICA em lib/modelPricing.ts (RFC-0004 F6/T2.2). */
const MODEL_PRICE_CASE_SQL = priceCaseSql("m.");

/**
 * Gasto de LLM (USD) do TENANT no mês (`month` em YYYY-MM; default mês corrente).
 * MAX(ledger 027, estimativa por project_agent_metrics) — ver racional no topo do arquivo.
 * Pode lançar em erro de infra — quem precisa de fail-open usa checkTenantBudget.
 */
export async function getTenantMonthSpendUsd(
  db: Queryable,
  tenantId: string,
  month?: string,
): Promise<number> {
  const start = monthStartDate(month);
  const metrics = await db.query(
    `SELECT COALESCE(SUM(${MODEL_PRICE_CASE_SQL}), 0) AS usd
       FROM project_agent_metrics m
       JOIN projects p ON p.id = m.project_id
      WHERE p.tenant_id = $1
        AND m.created_at >= $2::date
        AND m.created_at <  ($2::date + interval '1 month')`,
    [tenantId, start],
  );
  return Number(metrics.rows[0]?.usd ?? 0) || 0;
}

/**
 * Gasto de LLM (USD) de UM projeto (todo o histórico — o gate T18 é por projeto, não por mês).
 * Fonte única: project_agent_metrics (D4).
 */
export async function getProjectSpendUsd(db: Queryable, projectId: string): Promise<number> {
  const metrics = await db.query(
    `SELECT COALESCE(SUM(${MODEL_PRICE_CASE_SQL}), 0) AS usd
       FROM project_agent_metrics m
      WHERE m.project_id = $1`,
    [projectId],
  );
  return Number(metrics.rows[0]?.usd ?? 0) || 0;
}

/**
 * Resolve o teto mensal efetivo do tenant (precedência tenant > plano > env).
 * `null` = SEM CAP. Um valor explícito 0 em tenant/plano É um cap (kill-switch:
 * bloqueia qualquer novo run); já no env, 0/unset/inválido = sem cap (fail-safe).
 * Pode lançar em erro de infra — checkTenantBudget faz o fail-open.
 */
export async function resolveTenantMonthlyBudgetUsd(
  db: Queryable,
  tenantId: string,
): Promise<number | null> {
  const res = await db.query(
    `SELECT t.monthly_llm_budget_usd AS tenant_budget,
            p.monthly_llm_budget_usd AS plan_budget
       FROM tenants t
       LEFT JOIN plans p ON p.id = t.plan_id
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = res.rows[0];
  if (!row) return null; // tenant não encontrado ⇒ sem cap (não é papel deste gate barrar)
  if (row.tenant_budget != null) return Number(row.tenant_budget);
  if (row.plan_budget != null) return Number(row.plan_budget);
  const envRaw = (process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT ?? "").trim();
  const envVal = Number(envRaw);
  if (envRaw && Number.isFinite(envVal) && envVal > 0) return envVal;
  return null;
}

/**
 * Gate de orçamento do tenant. NUNCA lança.
 *
 * FAIL-OPEN DELIBERADO em erro de infra (espelha o racional do kill-switch H3 em
 * middleware/auth.ts): cobrança/telemetria de custo não pode derrubar produção —
 * se o banco/consulta falhar, o run segue (o gate T18 por projeto e o rate-limit
 * do /run continuam de pé como defesas independentes).
 */
export async function checkTenantBudget(
  db: Queryable,
  tenantId: string,
): Promise<TenantBudgetCheck> {
  try {
    const budgetUsd = await resolveTenantMonthlyBudgetUsd(db, tenantId);
    if (budgetUsd == null) return { ok: true }; // sem cap configurado = comportamento atual
    const spentUsd = await getTenantMonthSpendUsd(db, tenantId);
    if (spentUsd >= budgetUsd) return { ok: false, spentUsd, budgetUsd };
    return { ok: true };
  } catch (err) {
    console.warn("[tenantCostCap] checkTenantBudget fail-open (erro de infra não bloqueia):", err);
    return { ok: true };
  }
}

/** Mensagem acionável (PT-BR) para o bloqueio TENANT_LLM_BUDGET_EXCEEDED. */
export function budgetExceededMessage(spentUsd: number, budgetUsd: number): string {
  return (
    `Orçamento mensal de LLM do tenant excedido: gasto de US$ ${spentUsd.toFixed(2)} ` +
    `com teto de US$ ${budgetUsd.toFixed(2)} neste mês. Novas execuções da fábrica ficam ` +
    `bloqueadas até a virada do mês. Para aumentar o teto, peça ao administrador Zentriz ` +
    `para ajustar monthly_llm_budget_usd do tenant (ou do plano).`
  );
}
