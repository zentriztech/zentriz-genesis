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
 * Fonte de gasto (flag COST_SOURCE_LEDGER, C8' — ver lib/costSource.ts):
 *   off (padrão)  project_agent_metrics (migration 003), alimentada via POST /agent-metrics; custo
 *                 estimado com a tabela única de preços por modelo (lib/modelPricing.ts).
 *   shadow        calcula as duas fontes, usa project_agent_metrics e registra a divergência.
 *   on            ledger do Guard (llm_call_ledger, migration 131) onde houver cobertura.
 * REGRA DE TRANSIÇÃO (on): o ledger só existe desde a migration 131 (produção: 01/10/2026), então
 * a cobertura começa em MIN(llm_call_ledger.created_at). No mês consultado, o intervalo
 * [início do mês, cobertura) vem de project_agent_metrics e [cobertura, fim do mês) do ledger,
 * sem sobreposição (nada é contado duas vezes). Sem nenhuma linha no ledger ⇒ só metrics.
 * A antiga pipeline_cost_ledger (027) era dead table e foi dropada na migration 073.
 *
 * FAIL-OPEN em erro de infra (checkTenantBudget) é DELIBERADO e agora VISÍVEL: log estruturado,
 * contador em memória e evento `tenant_cap_fail_open` em llm_guard_events. Mudar para fail-closed
 * é decisão de produto (não tomada aqui).
 */

import { priceCaseSql } from "../lib/modelPricing.js";
import { costSourceLedgerMode } from "../lib/costSource.js";

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

/** Contadores em memória (por processo) — observabilidade da C8'. */
const stats = { failOpen: 0, divergences: 0, shadowErrors: 0 };
export function getCostCapStats(): Readonly<typeof stats> { return { ...stats }; }
export function resetCostCapStats(): void { stats.failOpen = 0; stats.divergences = 0; stats.shadowErrors = 0; }

/** Limites UTC do mês (início inclusivo, fim exclusivo). */
function monthBounds(month?: string): { start: Date; end: Date } {
  const m = month && MONTH_RE.test(month) ? month : monthStartDate().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

/** Gasto do tenant por project_agent_metrics no mês (SQL anterior à C8', inalterado). */
async function tenantMonthSpendFromMetrics(db: Queryable, tenantId: string, month?: string): Promise<number> {
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

export interface LedgerSpend {
  usd: number;
  /** Fração do que veio do ledger vs metrics no mês (para auditoria). */
  ledgerUsd: number;
  metricsPreCoverageUsd: number;
  /** Início da cobertura do ledger (null = ledger vazio). */
  coverageStart: string | null;
}

/**
 * Gasto do tenant no mês pelo LEDGER do Guard, com a regra de transição documentada no topo:
 * metrics antes da cobertura, ledger a partir dela. Pode lançar em erro de infra.
 */
export async function getTenantMonthSpendFromLedger(db: Queryable, tenantId: string, month?: string): Promise<LedgerSpend> {
  const { start, end } = monthBounds(month);
  const cov = await db.query("SELECT MIN(created_at) AS first_at FROM llm_call_ledger");
  const firstRaw = cov.rows[0]?.first_at;
  const first = firstRaw ? new Date(firstRaw as string | Date) : null;
  const validFirst = first && !Number.isNaN(first.getTime()) ? first : null;
  // split: onde o ledger passa a valer dentro do mês (end = ledger não cobre nada deste mês).
  const split = !validFirst ? end : new Date(Math.min(Math.max(validFirst.getTime(), start.getTime()), end.getTime()));
  let ledgerUsd = 0;
  if (split.getTime() < end.getTime()) {
    const r = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd
         FROM llm_call_ledger
        WHERE tenant_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
      [tenantId, split.toISOString(), end.toISOString()],
    );
    ledgerUsd = Number(r.rows[0]?.usd ?? 0) || 0;
  }
  let metricsPre = 0;
  if (split.getTime() > start.getTime()) {
    const r = await db.query(
      `SELECT COALESCE(SUM(${MODEL_PRICE_CASE_SQL}), 0) AS usd
         FROM project_agent_metrics m
         JOIN projects p ON p.id = m.project_id
        WHERE p.tenant_id = $1
          AND m.created_at >= $2::timestamptz AND m.created_at < $3::timestamptz`,
      [tenantId, start.toISOString(), split.toISOString()],
    );
    metricsPre = Number(r.rows[0]?.usd ?? 0) || 0;
  }
  return { usd: ledgerUsd + metricsPre, ledgerUsd, metricsPreCoverageUsd: metricsPre, coverageStart: validFirst ? validFirst.toISOString() : null };
}

/**
 * Gasto de LLM (USD) do TENANT no mês (`month` em YYYY-MM; default mês corrente), conforme a flag
 * COST_SOURCE_LEDGER (ver topo). Pode lançar em erro de infra — quem precisa de fail-open usa
 * checkTenantBudget.
 */
export async function getTenantMonthSpendUsd(
  db: Queryable,
  tenantId: string,
  month?: string,
): Promise<number> {
  const mode = costSourceLedgerMode();
  if (mode === "off") return tenantMonthSpendFromMetrics(db, tenantId, month);
  if (mode === "on") return (await getTenantMonthSpendFromLedger(db, tenantId, month)).usd;
  // shadow: devolve metrics; a divergência é só registrada e nunca muda o resultado nem lança.
  const metricsUsd = await tenantMonthSpendFromMetrics(db, tenantId, month);
  try {
    const l = await getTenantMonthSpendFromLedger(db, tenantId, month);
    if (Math.abs(l.usd - metricsUsd) >= 0.0001) {
      stats.divergences++;
      console.warn(JSON.stringify({
        evt: "cost_source_divergence", tenantId, month: monthStartDate(month).slice(0, 7),
        metricsUsd: Number(metricsUsd.toFixed(4)), ledgerHybridUsd: Number(l.usd.toFixed(4)),
        deltaUsd: Number((l.usd - metricsUsd).toFixed(4)), coverageStart: l.coverageStart,
      }));
    }
  } catch (err) {
    stats.shadowErrors++;
    console.warn(JSON.stringify({ evt: "cost_source_shadow_error", tenantId, err: errMsg(err) }));
  }
  return metricsUsd;
}

function errMsg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 300); }

/**
 * Gasto de LLM (USD) de UM projeto (todo o histórico — o gate T18 é por projeto, não por mês).
 * Continua em project_agent_metrics (gate T18 por projeto; fora do escopo da C8', que cobre o tenant).
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
    // FAIL-OPEN deliberado, mas VISÍVEL (C8'): contador + log estruturado + evento auditável.
    stats.failOpen++;
    console.warn("[tenantCostCap] checkTenantBudget fail-open (erro de infra não bloqueia):", err);
    console.error(JSON.stringify({ evt: "tenant_cap_fail_open", tenantId, count: stats.failOpen, err: errMsg(err) }));
    try {
      await db.query(
        "INSERT INTO llm_guard_events (kind, project_id, detail) VALUES ('tenant_cap_fail_open', NULL, $1::jsonb)",
        [JSON.stringify({ tenantId, err: errMsg(err), processCount: stats.failOpen })],
      );
    } catch { /* o banco pode ser justamente o que falhou: o log acima já registra */ }
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
