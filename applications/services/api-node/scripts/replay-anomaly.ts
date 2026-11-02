/**
 * Replay dos detectores de anomalia de custo/uso de LLM (plano 1.6) — compara QUANDO cada detector teria
 * alertado com QUANDO o corte do LLM Guard teria agido. Não escreve em banco nem usa rede (exceto --db, leitura).
 *
 *   cd applications/services/api-node
 *   npx tsx scripts/replay-anomaly.ts                       # cenários sintéticos + falsos positivos
 *   npx tsx scripts/replay-anomaly.ts --fp-seeds 200        # nº de sementes do relatório de falsos positivos
 *   npx tsx scripts/replay-anomaly.ts --history h.json      # arquivo: {"calls":[{ts,tenantId,projectId,costUsd,tokens,promptHash}],"progress":[{ts,projectId}]}
 *   DATABASE_URL=... npx tsx scripts/replay-anomaly.ts --db --days 60   # lê llm_call_ledger (somente SELECT)
 *   ANOMALY_MAD_Z=8 npx tsx scripts/replay-anomaly.ts       # qualquer parâmetro pode ser sobrescrito por ANOMALY_*
 *
 * Em --history/--db imprime cada alerta (hora, detector, escopo em hash, valor/base). Nos sintéticos imprime
 * a latência (horas) do início da anomalia até o 1º alerta de cada detector e o corte simulado do Guard.
 */
import { readFileSync } from "node:fs";
import { resolveAnomalyParams, type AnomalyParams } from "../src/lib/anomalyAlerts.js";
import { analyze, hashId, HOUR_MS, type Anomaly, type CallRow, type ProgressRow } from "../src/services/anomalyDetectors.js";
import { buildScenarios, genNormal, guardFirstCut, T0_MS } from "../src/services/anomalyScenarios.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const P: AnomalyParams = resolveAnomalyParams();
const DETECTORS = ["mad", "ewma", "cusum", "repeat_payload", "stalled_run"] as const;

const fmtT = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
const fmtLat = (ms: number, onset: number) => { const h = (ms - onset) / HOUR_MS; return h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`; };
const endOf = (calls: CallRow[]) => Math.ceil((calls[calls.length - 1].tsMs + 1) / HOUR_MS) * HOUR_MS;

function printAlerts(alerts: Anomaly[]) {
  for (const a of alerts) {
    console.log(`${fmtT(a.tsMs)}  ${a.detector.padEnd(14)} ${a.metric.padEnd(22)} ${a.scope}:${a.scopeHash}  valor=${a.value.toFixed(2)} base=${a.baseline.toFixed(2)} limiar=${a.threshold.toFixed(2)} escore=${a.score.toFixed(2)} ${a.severity}`);
  }
}

async function fromFile(path: string) {
  const j = JSON.parse(readFileSync(path, "utf8")) as { calls: Array<Record<string, unknown>>; progress?: Array<Record<string, unknown>> };
  const calls: CallRow[] = j.calls.map((c) => ({ tsMs: Date.parse(String(c.ts)), tenantId: (c.tenantId as string) ?? null, projectId: (c.projectId as string) ?? null,
    costUsd: Number(c.costUsd ?? 0), tokens: Number(c.tokens ?? 0), promptHash: (c.promptHash as string) ?? null })).sort((a, b) => a.tsMs - b.tsMs);
  const progress: ProgressRow[] = (j.progress ?? []).map((r) => ({ tsMs: Date.parse(String(r.ts)), projectId: String(r.projectId) }));
  return { calls, progress };
}

async function fromDb(days: number) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { loadAnomalyInputs } = await import("../src/services/llmAnomaly.js");
    const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    return await loadAnomalyInputs(pool, end - days * 24 * HOUR_MS, end, P);
  } finally { await pool.end(); }
}

function scenarioReport() {
  console.log("== Cenários sintéticos (35 dias, anomalia no dia 14; latência = início da anomalia até o 1º alerta) ==");
  for (const s of buildScenarios()) {
    const alerts = analyze({ calls: s.calls, progress: s.progress, endMs: endOf(s.calls) }, P);
    console.log(`\n[${s.name}] ${s.description}`);
    console.log(`  chamadas=${s.calls.length}`);
    const affected = new Set([hashId("proj-b1"), hashId("tenant-b"), "global"]);
    if (s.onsetMs == null) {
      const by: Record<string, number> = {};
      for (const a of alerts) by[a.detector] = (by[a.detector] ?? 0) + 1;
      console.log(`  alertas (todos são falsos positivos): total=${alerts.length} ${JSON.stringify(by)}`);
      continue;
    }
    // Detectores de série (mad/ewma/cusum) só decidem ao FECHAR a hora: latência = fim do balde.
    const at = (a: Anomaly) => a.tsMs + (a.detector === "repeat_payload" || a.detector === "stalled_run" ? 0 : HOUR_MS);
    const show = (a: Anomaly | undefined) => (a ? `${fmtT(at(a))} (+${fmtLat(at(a), s.onsetMs!)}) ${a.scope}:${a.metric}` : "não alertou");
    for (const d of DETECTORS) {
      const mine = alerts.filter((a) => a.tsMs >= s.onsetMs! && affected.has(a.scopeHash) && a.detector === d);
      console.log(`  ${d.padEnd(14)} qualquer métrica: ${show(mine[0])}`);
      if (d === "mad" || d === "ewma" || d === "cusum") console.log(`  ${"".padEnd(14)} só usd_per_hour:  ${show(mine.find((a) => a.metric === "usd_per_hour"))}`);
    }
    const early = alerts.filter((a) => a.tsMs < s.onsetMs!);
    console.log(`  alertas ANTES do início (falsos positivos no mesmo cenário): ${early.length}`);
    const cut = guardFirstCut(s);
    console.log(`  corte simulado do Guard: ${cut ? `${fmtT(cut.atMs)} (+${fmtLat(cut.atMs, s.onsetMs)}) por ${cut.rule}` : "não cortaria no período"}`);
  }
}

function falsePositiveReport(seeds: number) {
  console.log(`\n== Falsos positivos em tráfego normal sintético (${seeds} sementes x 35 dias, 5 projetos / 3 tenants) ==`);
  const totals: Record<string, number> = {};
  let withAny = 0;
  let seriesWeeks = 0;
  for (let i = 0; i < seeds; i++) {
    const g = genNormal({ days: 35, seed: 1000 + i });
    const alerts = analyze({ calls: g.calls, progress: g.progress, endMs: T0_MS + 35 * 24 * HOUR_MS }, P);
    if (alerts.length) withAny++;
    for (const a of alerts) totals[a.detector] = (totals[a.detector] ?? 0) + 1;
    seriesWeeks += (1 + 3 + 5) * 5; // (global + tenants + projetos) x 5 semanas
  }
  const all = Object.values(totals).reduce((x, y) => x + y, 0);
  console.log(`  alertas totais=${all} por detector=${JSON.stringify(totals)}`);
  console.log(`  taxa: ${(all / seeds).toFixed(3)} alertas por 35 dias de plataforma; ${(all / (seeds * 5)).toFixed(3)} por semana de plataforma; ${(all / seriesWeeks).toFixed(5)} por série-semana`);
  console.log(`  fração de sementes com >=1 alerta: ${(withAny / seeds * 100).toFixed(1)}% (${withAny}/${seeds})`);
  console.log("  (limite aceitável NÃO fixado aqui: é do pré-registro; esta é só a taxa medida em dados sintéticos)");
}

async function main() {
  console.log(`parâmetros: ${JSON.stringify(P)}`);
  if (flag("--history") || flag("--db")) {
    const { calls, progress } = flag("--db") ? await fromDb(Number(opt("--days", "60"))) : await fromFile(opt("--history", ""));
    if (!calls.length) { console.log("sem chamadas no histórico"); return; }
    const alerts = analyze({ calls, progress, endMs: endOf(calls) }, P);
    console.log(`chamadas=${calls.length} alertas=${alerts.length}`);
    printAlerts(alerts);
    return;
  }
  scenarioReport();
  falsePositiveReport(Number(opt("--fp-seeds", "100")));
}
main().catch((e) => { console.error(e); process.exit(1); });
