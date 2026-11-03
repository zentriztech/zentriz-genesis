/**
 * Reconciliação das fontes de custo (C8'): USD pelo ledger do Guard × USD por project_agent_metrics, por tenant e mês.
 * SOMENTE LEITURA (SELECT). Preço de metrics = tabela lib/modelPricing.ts, ou plano via parâmetro.
 *
 *   cd applications/services/api-node
 *   DATABASE_URL=postgres://... npx tsx scripts/cost-source-reconcile.ts [--month 2026-10] [--tenant <uuid>]
 *        [--flat-in-per-mtok N --flat-out-per-mtok N] [--json]
 */
import pg from "pg";
import { formatReport, reconcileCostSources, type ReconcileOptions } from "../src/services/costReconcile.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const url = process.env.DATABASE_URL;
if (!url) { console.error("Defina DATABASE_URL (somente leitura)."); process.exit(2); }
const num = (v?: string): number | undefined => (v == null ? undefined : Number(v));
const opts: ReconcileOptions = {
  month: arg("month"), tenantId: arg("tenant"),
  flatInPerMTok: num(arg("flat-in-per-mtok")), flatOutPerMTok: num(arg("flat-out-per-mtok")),
};
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const rep = await reconcileCostSources(pool, opts);
  console.log(argv.includes("--json") ? JSON.stringify(rep, null, 2) : formatReport(rep));
} finally {
  await pool.end();
}
