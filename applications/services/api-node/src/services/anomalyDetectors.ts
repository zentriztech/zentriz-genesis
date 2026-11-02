/**
 * anomalyDetectors.ts — detectores estatísticos PUROS (sem banco, sem rede, sem relógio, sem LLM).
 * Plano de evolução v2, tarefa 1.6 (docs 01 §4/#12/#14, 03 §2.2: EWMA/CUSUM/MAD).
 *
 * Entrada: chamadas de LLM (linhas do `llm_call_ledger`) e eventos de progresso (`project_agent_metrics`).
 * Saída: lista de alertas com hora, valor, base, limiar e escore. Determinístico: mesma entrada ⇒ mesma saída.
 * Nada aqui é importado pelo LLM Guard; o alerta INFORMA, nunca decide.
 */
import { createHash } from "node:crypto";
import type { AnomalyParams } from "../lib/anomalyAlerts.js";

export const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export interface CallRow {
  tsMs: number;
  tenantId: string | null;
  projectId: string | null;
  costUsd: number;
  tokens: number;
  promptHash: string | null;
}
export interface ProgressRow { tsMs: number; projectId: string }

export type Detector = "ewma" | "cusum" | "mad" | "repeat_payload" | "stalled_run";
export type Scope = "global" | "tenant" | "project";
export type Metric = "usd_per_hour" | "tokens_per_call" | "same_hash_calls" | "calls_without_progress";

export interface Anomaly {
  detector: Detector;
  metric: Metric;
  scope: Scope;
  /** Hash curto do id (nunca o id em claro). */
  scopeHash: string;
  /** Início do balde (hora) ou instante do evento a que o alerta se refere. */
  tsMs: number;
  value: number;
  baseline: number;
  threshold: number;
  score: number;
  severity: "warning" | "critical";
  detail: Record<string, string | number>;
}

/** Hash curto e estável do id (sem PII no alerta). */
export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/** Desvio absoluto mediano (bruto, sem o fator 1,4826). */
export function mad(xs: number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

type Series = Array<number | null>;

interface Baseline { med: number; sigma: number }

function baselineAt(values: Series, t: number, p: AnomalyParams, absFloor: number): Baseline | null {
  const hi = t - p.baselineLagHours; // exclusivo
  const lo = Math.max(0, hi - p.baselineHours);
  let pts: number[] = [];
  if (p.seasonal) {
    // Mesma hora do dia ±1 h nos dias anteriores (3 pontos por dia): MAD estável com poucos dias de histórico.
    for (let i = hi - 1; i >= lo; i--) {
      const d = (t - i) % 24;
      if ((d === 0 || d === 1 || d === 23) && values[i] != null) pts.push(values[i] as number);
    }
    if (pts.length < p.minSeasonalPoints) pts = [];
  }
  if (!pts.length) {
    for (let i = lo; i < hi; i++) if (values[i] != null) pts.push(values[i] as number);
    if (pts.length < p.minBaselineHours) return null;
  }
  const med = median(pts);
  const sigma = Math.max(1.4826 * mad(pts, med), p.relFloor * Math.abs(med), absFloor);
  return sigma > 0 ? { med, sigma } : null;
}

export interface SeriesSpec {
  metric: Metric;
  scope: Scope;
  scopeHash: string;
  /** Valor mínimo absoluto para disparar (piso de ruído). */
  minValue: number;
  /** Piso absoluto do sigma. */
  absFloor: number;
}

/**
 * Roda MAD robusto, EWMA e CUSUM (somente para CIMA: custo/uso abaixo do normal não é incidente de gasto)
 * em uma série horária. `values[i]` é o balde `startMs + i*HOUR_MS`; `null` = sem dado (ignorado).
 * Após um alerta, o mesmo detector fica em silêncio por `cooldownHours`.
 */
export function detectSeries(values: Series, startMs: number, spec: SeriesSpec, p: AnomalyParams): Anomaly[] {
  const out: Anomaly[] = [];
  const lastAlert: Record<string, number> = {};
  let ewma = 0;
  let cusum = 0;
  const ewmaSd = Math.sqrt(p.ewmaLambda / (2 - p.ewmaLambda));
  const ewmaLimit = p.ewmaL * ewmaSd;
  for (let t = 0; t < values.length; t++) {
    const x = values[t];
    if (x == null) continue;
    const b = baselineAt(values, t, p, spec.absFloor);
    if (!b) continue;
    const z = (x - b.med) / b.sigma;
    ewma = p.ewmaLambda * z + (1 - p.ewmaLambda) * ewma;
    cusum = Math.max(0, cusum + Math.min(z, p.zClip) - p.cusumK);
    const fire = (detector: Detector, score: number, threshold: number) => {
      const prev = lastAlert[detector];
      if (prev !== undefined && t - prev < p.cooldownHours) return;
      lastAlert[detector] = t;
      out.push({
        detector, metric: spec.metric, scope: spec.scope, scopeHash: spec.scopeHash, tsMs: startMs + t * HOUR_MS,
        value: x, baseline: b.med, threshold, score,
        severity: score >= 2 * threshold ? "critical" : "warning",
        detail: { sigma: round(b.sigma), z: round(z) },
      });
    };
    if (x >= spec.minValue) {
      if (z >= p.madZ) fire("mad", z, p.madZ);
      if (ewma >= ewmaLimit) fire("ewma", ewma, ewmaLimit);
      if (cusum >= p.cusumH) { fire("cusum", cusum, p.cusumH); cusum = 0; }
    }
  }
  return out;
}

/** Mesmo `prompt_hash` ≥ N vezes dentro da janela, por projeto (assinatura do incidente). */
export function detectRepeatedPayload(calls: CallRow[], scopeHash: string, p: AnomalyParams): Anomaly[] {
  const byHash = new Map<string, number[]>();
  for (const c of calls) {
    if (!c.promptHash) continue;
    const l = byHash.get(c.promptHash);
    if (l) l.push(c.tsMs); else byHash.set(c.promptHash, [c.tsMs]);
  }
  const win = p.repeatWindowMinutes * MIN_MS;
  const out: Anomaly[] = [];
  for (const [hash, tsList] of [...byHash.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    tsList.sort((a, b) => a - b);
    let lo = 0;
    let lastAlert = -Infinity;
    for (let hi = 0; hi < tsList.length; hi++) {
      while (tsList[hi] - tsList[lo] > win) lo++;
      const n = hi - lo + 1;
      if (n >= p.repeatMinCount && tsList[hi] - lastAlert >= p.cooldownHours * HOUR_MS) {
        lastAlert = tsList[hi];
        out.push({
          detector: "repeat_payload", metric: "same_hash_calls", scope: "project", scopeHash, tsMs: tsList[hi],
          value: n, baseline: 1, threshold: p.repeatMinCount, score: n, severity: "critical",
          detail: { payloadHash: hash.slice(0, 16), windowMinutes: p.repeatWindowMinutes },
        });
      }
    }
  }
  return out;
}

/** Muitas chamadas na janela sem nenhum progresso, em projeto que tinha progresso recente. */
export function detectStalledRun(calls: CallRow[], progressTs: number[], scopeHash: string, p: AnomalyParams): Anomaly[] {
  const cs = calls.map((c) => c.tsMs).sort((a, b) => a - b);
  const pr = [...progressTs].sort((a, b) => a - b);
  const win = p.stallWindowMinutes * MIN_MS;
  const prior = p.stallPriorProgressHours * HOUR_MS;
  const out: Anomaly[] = [];
  let lo = 0;
  let lastAlert = -Infinity;
  for (let hi = 0; hi < cs.length; hi++) {
    while (cs[hi] - cs[lo] > win) lo++;
    const n = hi - lo + 1;
    if (n < p.stallMinCalls) continue;
    const now = cs[hi];
    const inWin = pr.some((t) => t > now - win && t <= now);
    if (inWin) continue;
    const hadPrior = pr.some((t) => t <= now - win && t > now - prior);
    if (!hadPrior) continue;
    if (now - lastAlert < p.cooldownHours * HOUR_MS) continue;
    lastAlert = now;
    out.push({
      detector: "stalled_run", metric: "calls_without_progress", scope: "project", scopeHash, tsMs: now,
      value: n, baseline: 0, threshold: p.stallMinCalls, score: n, severity: "critical",
      detail: { windowMinutes: p.stallWindowMinutes, progressEventsInWindow: 0 },
    });
  }
  return out;
}

function round(x: number): number { return Math.round(x * 1e4) / 1e4; }

interface HourAgg { usd: number; tokens: number; n: number }

/** Séries horárias de um conjunto de chamadas: `[startMs, usd[], tokensPerCall[]]`. endMs exclusivo (hora fechada). */
export function hourlySeries(calls: CallRow[], endMs: number, p: AnomalyParams): { startMs: number; usd: number[]; tokensPerCall: Series } | null {
  if (!calls.length) return null;
  let first = Infinity;
  for (const c of calls) if (c.tsMs < first) first = c.tsMs;
  const startMs = Math.floor(first / HOUR_MS) * HOUR_MS;
  const n = Math.floor((endMs - startMs) / HOUR_MS);
  if (n <= 0) return null;
  const agg: HourAgg[] = Array.from({ length: n }, () => ({ usd: 0, tokens: 0, n: 0 }));
  for (const c of calls) {
    const i = Math.floor((c.tsMs - startMs) / HOUR_MS);
    if (i < 0 || i >= n) continue;
    agg[i].usd += c.costUsd; agg[i].tokens += c.tokens; agg[i].n += 1;
  }
  return {
    startMs,
    usd: agg.map((a) => a.usd),
    tokensPerCall: agg.map((a) => (a.n >= p.minCallsForTokenPoint ? a.tokens / a.n : null)),
  };
}

export interface AnalyzeInput { calls: CallRow[]; progress: ProgressRow[]; endMs: number }

/**
 * Análise completa: USD/hora (global, por tenant, por projeto), tokens/chamada (tenant e projeto),
 * payload repetido e run travada (por projeto). `endMs` é exclusivo e alinhado à hora (a hora corrente,
 * ainda incompleta, não entra). Resultado ordenado por (tsMs, detector, escopo): determinístico.
 */
export function analyze(input: AnalyzeInput, p: AnomalyParams): Anomaly[] {
  const calls = input.calls.filter((c) => c.tsMs < input.endMs);
  const out: Anomaly[] = [];
  const tenants = new Map<string, CallRow[]>();
  const projects = new Map<string, CallRow[]>();
  for (const c of calls) {
    if (c.tenantId) (tenants.get(c.tenantId) ?? tenants.set(c.tenantId, []).get(c.tenantId)!).push(c);
    if (c.projectId) (projects.get(c.projectId) ?? projects.set(c.projectId, []).get(c.projectId)!).push(c);
  }
  const run = (rows: CallRow[], scope: Scope, id: string) => {
    const s = hourlySeries(rows, input.endMs, p);
    if (!s) return;
    const h = scope === "global" ? "global" : hashId(id);
    out.push(...detectSeries(s.usd, s.startMs, { metric: "usd_per_hour", scope, scopeHash: h, minValue: p.minUsdPerHour, absFloor: p.usdSigmaFloor }, p));
    if (scope !== "global") {
      out.push(...detectSeries(s.tokensPerCall, s.startMs, { metric: "tokens_per_call", scope, scopeHash: h, minValue: p.minTokensPerCall, absFloor: 1 }, p));
    }
  };
  run(calls, "global", "global");
  for (const [id, rows] of [...tenants.entries()].sort()) run(rows, "tenant", id);
  const progByProject = new Map<string, number[]>();
  for (const r of input.progress) {
    if (r.tsMs >= input.endMs) continue;
    (progByProject.get(r.projectId) ?? progByProject.set(r.projectId, []).get(r.projectId)!).push(r.tsMs);
  }
  for (const [id, rows] of [...projects.entries()].sort()) {
    run(rows, "project", id);
    out.push(...detectRepeatedPayload(rows, hashId(id), p));
    out.push(...detectStalledRun(rows, progByProject.get(id) ?? [], hashId(id), p));
  }
  return out.sort((a, b) =>
    a.tsMs - b.tsMs || (a.detector < b.detector ? -1 : a.detector > b.detector ? 1 : 0) ||
    (a.scopeHash < b.scopeHash ? -1 : a.scopeHash > b.scopeHash ? 1 : 0) || (a.metric < b.metric ? -1 : 1));
}
