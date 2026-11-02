/**
 * anomalyScenarios.ts — cenários SINTÉTICOS determinísticos (PRNG com semente) e modelo simplificado do
 * corte do LLM Guard, para a ferramenta de replay e os testes da tarefa 1.6.
 *
 * ATENÇÃO: os números são sintéticos. Servem para comparar detectores entre si e contra o corte do Guard,
 * não para afirmar taxas de produção. Nada aqui toca banco ou rede.
 */
import { HOUR_MS, type CallRow, type ProgressRow } from "./anomalyDetectors.js";

/** mulberry32: PRNG determinístico. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
function poisson(r: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

export const T0_MS = Date.UTC(2026, 0, 5, 0, 0, 0); // segunda-feira 00:00 UTC (sintético)

export interface ProjectProfile {
  tenantId: string;
  projectId: string;
  /** Chamadas por hora no pico do dia útil. */
  peakCallsPerHour: number;
  meanCostUsd: number;
  meanTokens: number;
  /** Fração das horas de trabalho em que o projeto de fato está ativo (dia a dia). */
  progressPerHour: number;
}

export interface Scenario {
  name: string;
  description: string;
  days: number;
  calls: CallRow[];
  progress: ProgressRow[];
  /** Instante em que a anomalia COMEÇA (null = cenário normal). */
  onsetMs: number | null;
  /** Orçamento (USD) do projeto afetado, para o modelo do corte por orçamento. */
  affectedProjectId: string | null;
  affectedBudgetUsd: number | null;
}

/** Ciclo diário (pico ~14h UTC, vale à noite) e queda de fim de semana. */
function load(ms: number, noiseR: () => number): number {
  const h = ((ms - T0_MS) / HOUR_MS) % 24;
  const dow = Math.floor((ms - T0_MS) / (24 * HOUR_MS)) % 7;
  const day = 0.15 + 0.85 * Math.max(0, Math.sin(((h - 8) / 12) * Math.PI));
  const week = dow >= 5 ? 0.35 : 1;
  const slow = 1 + 0.1 * gauss(noiseR); // variação de intensidade hora a hora
  return day * week * Math.max(0.5, slow);
}

export const DEFAULT_PROFILES: ProjectProfile[] = [
  { tenantId: "tenant-a", projectId: "proj-a1", peakCallsPerHour: 14, meanCostUsd: 0.16, meanTokens: 9000, progressPerHour: 1.8 },
  { tenantId: "tenant-a", projectId: "proj-a2", peakCallsPerHour: 8, meanCostUsd: 0.12, meanTokens: 7000, progressPerHour: 1 },
  { tenantId: "tenant-b", projectId: "proj-b1", peakCallsPerHour: 20, meanCostUsd: 0.2, meanTokens: 11000, progressPerHour: 2.5 },
  { tenantId: "tenant-b", projectId: "proj-b2", peakCallsPerHour: 6, meanCostUsd: 0.1, meanTokens: 6000, progressPerHour: 0.8 },
  { tenantId: "tenant-c", projectId: "proj-c1", peakCallsPerHour: 12, meanCostUsd: 0.15, meanTokens: 8000, progressPerHour: 1.8 },
];

interface GenOpts {
  days: number;
  seed: number;
  profiles?: ProjectProfile[];
  /** Probabilidade de uma chamada ser repetida (retry legítimo) logo em seguida, com o mesmo hash. */
  retryProb?: number;
}

/** Tráfego normal (ruído, ciclo diário, fim de semana, retries ocasionais). */
export function genNormal(o: GenOpts): { calls: CallRow[]; progress: ProgressRow[] } {
  const r = rng(o.seed);
  const calls: CallRow[] = [];
  const progress: ProgressRow[] = [];
  let hashSeq = 0;
  for (const pf of o.profiles ?? DEFAULT_PROFILES) {
    for (let h = 0; h < o.days * 24; h++) {
      const base = T0_MS + h * HOUR_MS;
      const lam = pf.peakCallsPerHour * load(base, r);
      const n = poisson(r, lam);
      for (let i = 0; i < n; i++) {
        const ts = base + Math.floor(r() * HOUR_MS);
        const cost = pf.meanCostUsd * Math.exp(0.6 * gauss(r) - 0.18);
        const tokens = Math.round(pf.meanTokens * Math.exp(0.5 * gauss(r) - 0.125));
        const hash = `${pf.projectId}-h${hashSeq++}`;
        calls.push({ tsMs: ts, tenantId: pf.tenantId, projectId: pf.projectId, costUsd: cost, tokens, promptHash: hash });
        if (r() < (o.retryProb ?? 0.02)) {
          calls.push({ tsMs: ts + 20_000, tenantId: pf.tenantId, projectId: pf.projectId, costUsd: cost, tokens, promptHash: hash });
          if (r() < 0.1) calls.push({ tsMs: ts + 45_000, tenantId: pf.tenantId, projectId: pf.projectId, costUsd: cost, tokens, promptHash: hash });
        }
      }
      const np = poisson(r, pf.progressPerHour * load(base, r));
      for (let i = 0; i < np; i++) progress.push({ tsMs: base + Math.floor(r() * HOUR_MS), projectId: pf.projectId });
    }
  }
  calls.sort((a, b) => a.tsMs - b.tsMs);
  progress.sort((a, b) => a.tsMs - b.tsMs);
  return { calls, progress };
}

const LOOP_COST = 0.9; // ≈ 114.920 tokens de entrada em modelo de topo (ordem de grandeza do incidente)
const LOOP_TOKENS = 114_920;

function withAnomaly(name: string, description: string, o: GenOpts, onsetDay: number, mk: (onsetMs: number, endMs: number, r: () => number) => { calls: CallRow[]; removeProgress?: boolean }, budget: number | null): Scenario {
  const base = genNormal(o);
  const onsetMs = T0_MS + onsetDay * 24 * HOUR_MS;
  const endMs = T0_MS + o.days * 24 * HOUR_MS;
  const extra = mk(onsetMs, endMs, rng(o.seed + 7919));
  const progress = extra.removeProgress ? base.progress.filter((p) => !(p.projectId === "proj-b1" && p.tsMs >= onsetMs)) : base.progress;
  return {
    name, description, days: o.days,
    calls: [...base.calls, ...extra.calls].sort((a, b) => a.tsMs - b.tsMs),
    progress, onsetMs, affectedProjectId: "proj-b1", affectedBudgetUsd: budget,
  };
}

export function buildScenarios(seed = 20260402): Scenario[] {
  const days = 35;
  const o: GenOpts = { days, seed };
  const normal: Scenario = {
    name: "normal_ruido", description: "tráfego normal com ciclo diário, fim de semana, ruído e retries ocasionais",
    days, ...genNormal(o), onsetMs: null, affectedProjectId: null, affectedBudgetUsd: null,
  };
  const ramp = withAnomaly("custo_gradual", "um projeto sobe de ~0 até +US$ 30/h ao longo de 10 dias a partir do dia 14 (hashes distintos)", o, 14, (onset, end, r) => {
    const calls: CallRow[] = [];
    for (let ms = onset; ms < end; ms += 60_000) {
      const frac = Math.min(1, (ms - onset) / (10 * 24 * HOUR_MS));
      if (r() < frac) calls.push({ tsMs: ms, tenantId: "tenant-b", projectId: "proj-b1", costUsd: 0.5, tokens: 60_000, promptHash: `ramp-${Math.floor(ms / 60_000)}` });
    }
    return { calls };
  }, 2500);
  const spike = withAnomaly("pico", "pico de 2 horas com ~15x o normal em um projeto no dia 14 (hashes distintos)", o, 14, (onset, _end, r) => {
    const calls: CallRow[] = [];
    for (let ms = onset + 10 * HOUR_MS; ms < onset + 12 * HOUR_MS; ms += 4_000) {
      calls.push({ tsMs: ms + Math.floor(r() * 1000), tenantId: "tenant-b", projectId: "proj-b1", costUsd: 0.25, tokens: 40_000, promptHash: `spike-${ms}` });
    }
    return { calls };
  }, 2500);
  const loop = withAnomaly("loop_mesmo_hash", "1 chamada/min com payload byte-idêntico (assinatura do incidente de 30/09) a partir do dia 14", o, 14, (onset, end) => {
    const calls: CallRow[] = [];
    for (let ms = onset; ms < end; ms += 60_000) {
      calls.push({ tsMs: ms, tenantId: "tenant-b", projectId: "proj-b1", costUsd: LOOP_COST, tokens: LOOP_TOKENS, promptHash: "loop-identico" });
    }
    return { calls };
  }, 2500);
  const stalled = withAnomaly("run_travada", "projeto passa a fazer ~30 chamadas/h variadas sem nenhum progresso a partir do dia 14", o, 14, (onset, end, r) => {
    const calls: CallRow[] = [];
    for (let h = 0; ; h++) {
      const base = onset + h * HOUR_MS;
      if (base >= end) break;
      for (let i = 0; i < 30; i++) calls.push({ tsMs: base + Math.floor(r() * HOUR_MS), tenantId: "tenant-b", projectId: "proj-b1", costUsd: 0.2, tokens: 9000, promptHash: `stall-${h}-${i}` });
    }
    return { calls, removeProgress: true };
  }, 2500);
  return [normal, ramp, spike, loop, stalled];
}

/** Parâmetros do corte do Guard usados na comparação (espelham `SETTING_DEFAULTS` de llmGuard.ts). */
export interface GuardModel { globalMaxUsdPerHour: number; globalMaxUsdPerDay: number; repeatMaxPer6h: number }
export const GUARD_DEFAULTS: GuardModel = { globalMaxUsdPerHour: 40, globalMaxUsdPerDay: 250, repeatMaxPer6h: 4 };

/**
 * Primeiro instante em que o corte do Guard (modelo simplificado: teto global/hora, teto global/24h,
 * mesmo hash N vezes em 6 h e orçamento do projeto afetado) teria negado uma chamada. `null` = nunca.
 * É uma simulação sobre o histórico, não o Guard real (que é fail-closed e independente).
 */
export function guardFirstCut(s: Scenario, g: GuardModel = GUARD_DEFAULTS): { atMs: number; rule: string } | null {
  const calls = s.calls;
  let hourSum = 0, daySum = 0, lh = 0, ld = 0, budgetSum = 0;
  const seen = new Map<string, number[]>();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    while (calls[lh].tsMs <= c.tsMs - HOUR_MS) { hourSum -= calls[lh].costUsd; lh++; }
    while (calls[ld].tsMs <= c.tsMs - 24 * HOUR_MS) { daySum -= calls[ld].costUsd; ld++; }
    // Decisão de preflight ANTES de registrar esta chamada.
    if (hourSum >= g.globalMaxUsdPerHour) return { atMs: c.tsMs, rule: "teto global/hora" };
    if (daySum >= g.globalMaxUsdPerDay) return { atMs: c.tsMs, rule: "teto global/24h" };
    if (c.promptHash) {
      const l = seen.get(c.promptHash) ?? [];
      const recent = l.filter((t) => t > c.tsMs - 6 * HOUR_MS);
      if (recent.length >= g.repeatMaxPer6h) return { atMs: c.tsMs, rule: "payload repetido (6h)" };
      recent.push(c.tsMs);
      seen.set(c.promptHash, recent);
    }
    if (s.affectedBudgetUsd != null && c.projectId === s.affectedProjectId) {
      if (budgetSum + c.costUsd > s.affectedBudgetUsd) return { atMs: c.tsMs, rule: "orçamento do projeto" };
      budgetSum += c.costUsd;
    }
    hourSum += c.costUsd; daySum += c.costUsd;
  }
  return null;
}
