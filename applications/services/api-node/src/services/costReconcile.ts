/**
 * costReconcile.ts — relatório de reconciliação das duas fontes de custo (C8').
 * Compara, por tenant e mês (UTC), USD pelo ledger do Guard (`llm_call_ledger.cost_usd`, gravado na hora)
 * × USD por `project_agent_metrics` reprecificado (tabela de `lib/modelPricing.ts`, ou preço plano
 * informado por parâmetro — nenhum preço é fixado aqui). SOMENTE LEITURA.
 */
import { priceCaseSql } from "../lib/modelPricing.js";

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ReconcileOptions {
  /** YYYY-MM; ausente = todos os meses presentes em alguma das fontes. */
  month?: string;
  tenantId?: string;
  /** Preço plano (USD por milhão de tokens) em vez da tabela por modelo. Só vale se ambos vierem. */
  flatInPerMTok?: number;
  flatOutPerMTok?: number;
}

export interface ReconcileRow {
  tenantId: string;
  month: string;
  ledgerUsd: number;
  ledgerCalls: number;
  metricsUsd: number;
  metricsRows: number;
  deltaUsd: number;
  /** (ledger - metrics) / metrics, em %. null quando metrics = 0. */
  deltaPct: number | null;
  /** full = ledger cobre o mês inteiro · partial = cobre parte · none = ledger não cobre o mês. */
  coverage: "full" | "partial" | "none";
}

export interface ReconcileReport {
  coverageStart: string | null;
  pricing: string;
  rows: ReconcileRow[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function metricsPriceSql(o: ReconcileOptions): { sql: string; label: string } {
  if (o.flatInPerMTok != null && o.flatOutPerMTok != null) {
    if (!(o.flatInPerMTok >= 0) || !(o.flatOutPerMTok >= 0)) throw new Error("preço plano inválido");
    return {
      sql: `(m.input_tokens / 1000000.0) * ${Number(o.flatInPerMTok)} + (m.output_tokens / 1000000.0) * ${Number(o.flatOutPerMTok)}`,
      label: `plano (in ${o.flatInPerMTok} / out ${o.flatOutPerMTok} USD por MTok, sem cache)`,
    };
  }
  return { sql: priceCaseSql("m."), label: "tabela lib/modelPricing.ts (por modelo, com cache)" };
}

export async function reconcileCostSources(db: Queryable, o: ReconcileOptions = {}): Promise<ReconcileReport> {
  if (o.month && !MONTH_RE.test(o.month)) throw new Error("--month deve ser YYYY-MM");
  const price = metricsPriceSql(o);
  const monthStart = o.month ? `${o.month}-01` : null;
  const cov = await db.query("SELECT MIN(created_at) AS first_at FROM llm_call_ledger");
  const firstAt = cov.rows[0]?.first_at ? new Date(cov.rows[0].first_at as string | Date) : null;
  const res = await db.query(
    `WITH l AS (
       SELECT tenant_id, to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
              SUM(cost_usd) AS usd, COUNT(*) AS n
         FROM llm_call_ledger
        WHERE tenant_id IS NOT NULL AND ($1::uuid IS NULL OR tenant_id = $1)
          AND ($2::date IS NULL OR (created_at >= $2::date AND created_at < $2::date + interval '1 month'))
        GROUP BY 1, 2),
     mt AS (
       SELECT p.tenant_id, to_char(date_trunc('month', m.created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
              SUM(${price.sql}) AS usd, COUNT(*) AS n
         FROM project_agent_metrics m JOIN projects p ON p.id = m.project_id
        WHERE p.tenant_id IS NOT NULL AND ($1::uuid IS NULL OR p.tenant_id = $1)
          AND ($2::date IS NULL OR (m.created_at >= $2::date AND m.created_at < $2::date + interval '1 month'))
        GROUP BY 1, 2)
     SELECT COALESCE(l.tenant_id, mt.tenant_id) AS tenant_id, COALESCE(l.month, mt.month) AS month,
            COALESCE(l.usd, 0) AS ledger_usd, COALESCE(l.n, 0) AS ledger_calls,
            COALESCE(mt.usd, 0) AS metrics_usd, COALESCE(mt.n, 0) AS metrics_rows
       FROM l FULL OUTER JOIN mt ON l.tenant_id = mt.tenant_id AND l.month = mt.month
      ORDER BY 2, 1`,
    [o.tenantId ?? null, monthStart],
  );
  const rows: ReconcileRow[] = res.rows.map((r) => {
    const month = String(r.month);
    const [y, mo] = month.split("-").map(Number);
    const start = Date.UTC(y, mo - 1, 1);
    const end = Date.UTC(y, mo, 1);
    const coverage: ReconcileRow["coverage"] = !firstAt ? "none"
      : firstAt.getTime() <= start ? "full" : firstAt.getTime() < end ? "partial" : "none";
    const ledgerUsd = Number(r.ledger_usd) || 0;
    const metricsUsd = Number(r.metrics_usd) || 0;
    return {
      tenantId: String(r.tenant_id), month, ledgerUsd, ledgerCalls: Number(r.ledger_calls) || 0,
      metricsUsd, metricsRows: Number(r.metrics_rows) || 0, deltaUsd: ledgerUsd - metricsUsd,
      deltaPct: metricsUsd > 0 ? ((ledgerUsd - metricsUsd) / metricsUsd) * 100 : null, coverage,
    };
  });
  return { coverageStart: firstAt ? firstAt.toISOString() : null, pricing: price.label, rows };
}

export function formatReport(rep: ReconcileReport): string {
  const out: string[] = [];
  out.push(`Cobertura do ledger: ${rep.coverageStart ?? "VAZIO (nenhuma linha)"}`);
  out.push(`Preço de project_agent_metrics: ${rep.pricing}`);
  out.push("tenant                                mês      ledger_usd  chamadas  metrics_usd  linhas  delta_usd    delta%   cobertura");
  for (const r of rep.rows) {
    out.push([
      r.tenantId.padEnd(36), r.month, r.ledgerUsd.toFixed(4).padStart(12), String(r.ledgerCalls).padStart(9),
      r.metricsUsd.toFixed(4).padStart(12), String(r.metricsRows).padStart(7), r.deltaUsd.toFixed(4).padStart(10),
      (r.deltaPct == null ? "n/d" : r.deltaPct.toFixed(1) + "%").padStart(9), r.coverage.padStart(10),
    ].join(" "));
  }
  const div = rep.rows.filter((r) => Math.abs(r.deltaUsd) >= 0.0001);
  out.push(`Linhas: ${rep.rows.length} · divergentes: ${div.length} · cobertura full/partial/none: ` +
    ["full", "partial", "none"].map((c) => rep.rows.filter((r) => r.coverage === c).length).join("/"));
  return out.join("\n");
}
