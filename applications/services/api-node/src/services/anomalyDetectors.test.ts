/**
 * Plano de evolução v2, tarefa 1.6 — detectores estatísticos puros e cenários sintéticos determinísticos.
 * Não há banco, rede, relógio nem LLM. Os limites de falso positivo abaixo são GUARDAS DE REGRESSÃO do
 * código atual, não o limite aceitável (esse é fixado no pré-registro, tarefa 0.6).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ANOMALY_PARAMS as P, anomalyMode, resolveAnomalyParams } from "../lib/anomalyAlerts.js";
import { analyze, detectRepeatedPayload, detectSeries, hashId, HOUR_MS, mad, median, type Anomaly, type CallRow } from "./anomalyDetectors.js";
import { buildScenarios, genNormal, guardFirstCut, rng, T0_MS } from "./anomalyScenarios.js";

const endOf = (calls: CallRow[]) => Math.ceil((calls[calls.length - 1].tsMs + 1) / HOUR_MS) * HOUR_MS;
const scenario = (name: string) => buildScenarios().find((s) => s.name === name)!;
const run = (name: string): { alerts: Anomaly[]; onset: number } => {
  const s = scenario(name);
  return { alerts: analyze({ calls: s.calls, progress: s.progress, endMs: endOf(s.calls) }, P), onset: s.onsetMs! };
};
const affected = new Set([hashId("proj-b1"), hashId("tenant-b"), "global"]);
const first = (alerts: Anomaly[], onset: number, pred: (a: Anomaly) => boolean) =>
  alerts.find((a) => a.tsMs >= onset && affected.has(a.scopeHash) && pred(a));

describe("flag ANOMALY_ALERTS e parâmetros", () => {
  it("padrão off; inválido ⇒ off; shadow/on reconhecidos", () => {
    expect(anomalyMode({})).toBe("off");
    expect(anomalyMode({ ANOMALY_ALERTS: "banana" } as never)).toBe("off");
    expect(anomalyMode({ ANOMALY_ALERTS: " Shadow " } as never)).toBe("shadow");
    expect(anomalyMode({ ANOMALY_ALERTS: "on" } as never)).toBe("on");
  });
  it("parâmetros: padrões conservadores, env sobrescreve, valor inválido é ignorado", () => {
    expect(resolveAnomalyParams({})).toEqual(P);
    const o = resolveAnomalyParams({ ANOMALY_MAD_Z: "9", ANOMALY_SEASONAL: "false", ANOMALY_PROGRESS_STATUSES: "DONE", ANOMALY_CUSUM_H: "abc" } as never);
    expect(o.madZ).toBe(9);
    expect(o.seasonal).toBe(false);
    expect(o.progressStatuses).toEqual(["DONE"]);
    expect(o.cusumH).toBe(P.cusumH);
    expect(P.progressStatuses).toEqual(["QA_PASS", "DONE"]); // padrão não foi mutado
  });
});

describe("estatística básica e privacidade", () => {
  it("mediana e MAD", () => {
    expect(median([1, 2, 3, 4, 100])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
  it("hashId é estável, curto e não contém o id", () => {
    const id = "00000000-0000-0000-0000-0000000000aa";
    expect(hashId(id)).toBe(hashId(id));
    expect(hashId(id)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashId(id)).not.toContain("aa");
  });
  it("alertas não carregam id em claro (só hash)", () => {
    const { alerts } = run("loop_mesmo_hash");
    expect(alerts.length).toBeGreaterThan(0);
    const blob = JSON.stringify(alerts);
    for (const raw of ["proj-b1", "tenant-b"]) expect(blob).not.toContain(raw);
  });
});

describe("detectores de série (EWMA / CUSUM / MAD)", () => {
  const p = { ...P, seasonal: false };
  const spec = { metric: "usd_per_hour" as const, scope: "project" as const, scopeHash: "h", minValue: 3, absFloor: 1 };
  const flat = (n: number, v: number) => Array.from({ length: n }, (_, i) => v + (i % 3) * 0.2);

  it("série estável não alerta", () => {
    expect(detectSeries(flat(300, 5), 0, spec, p)).toEqual([]);
  });
  it("degrau alto dispara MAD, EWMA e CUSUM; cooldown evita repetição", () => {
    const v = [...flat(200, 5), ...Array(8).fill(40)];
    const a = detectSeries(v, 0, spec, p);
    for (const d of ["mad", "ewma", "cusum"]) expect(a.some((x) => x.detector === d)).toBe(true);
    for (const d of ["mad", "ewma", "cusum"]) expect(a.filter((x) => x.detector === d).length).toBe(1);
  });
  it("queda (custo abaixo do normal) nunca alerta: o alvo é gasto", () => {
    expect(detectSeries([...flat(200, 20), ...Array(10).fill(0)], 0, spec, p)).toEqual([]);
  });
  it("piso mínimo: salto pequeno em valores baixos não alerta", () => {
    expect(detectSeries([...flat(200, 0.1), 2, 2, 2, 2], 0, spec, p)).toEqual([]);
  });
  it("buracos (null) são ignorados", () => {
    const v: Array<number | null> = [...flat(200, 5), null, null, null];
    expect(() => detectSeries(v, 0, spec, p)).not.toThrow();
  });
});

describe("payload repetido", () => {
  const mk = (n: number, gapMs: number, hash = "h1"): CallRow[] =>
    Array.from({ length: n }, (_, i) => ({ tsMs: 1_000_000 + i * gapMs, tenantId: "t", projectId: "p", costUsd: 1, tokens: 1, promptHash: hash }));
  it("N vezes na janela alerta uma vez (com cooldown)", () => {
    const a = detectRepeatedPayload(mk(60, 60_000), "ph", P);
    expect(a.length).toBe(1);
    expect(a[0].detector).toBe("repeat_payload");
    expect(a[0].severity).toBe("critical");
  });
  it("abaixo do mínimo, espalhado fora da janela ou sem hash: nada", () => {
    expect(detectRepeatedPayload(mk(P.repeatMinCount - 1, 60_000), "ph", P)).toEqual([]);
    expect(detectRepeatedPayload(mk(10, 10 * 60_000), "ph", P)).toEqual([]);
    expect(detectRepeatedPayload(mk(30, 1000).map((c) => ({ ...c, promptHash: null })), "ph", P)).toEqual([]);
  });
});

describe("cenários sintéticos (replay)", () => {
  it("gerador é determinístico", () => {
    expect(genNormal({ days: 3, seed: 5 })).toEqual(genNormal({ days: 3, seed: 5 }));
    expect(rng(1)()).toBe(rng(1)());
    const a = buildScenarios(); const b = buildScenarios();
    expect(a.map((s) => s.calls.length)).toEqual(b.map((s) => s.calls.length));
  });
  it("análise é determinística (mesma entrada, mesma saída)", () => {
    const s = scenario("pico");
    const i = { calls: s.calls, progress: s.progress, endMs: endOf(s.calls) };
    expect(analyze(i, P)).toEqual(analyze(i, P));
  });
  it("tráfego normal: sem alertas na semente do cenário (guarda de regressão)", () => {
    expect(run("normal_ruido").alerts.length).toBe(0);
  });
  it("falsos positivos em tráfego normal: taxa medida em 20 sementes fica abaixo da guarda de regressão", () => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const g = genNormal({ days: 35, seed: 1000 + i });
      total += analyze({ calls: g.calls, progress: g.progress, endMs: T0_MS + 35 * 24 * HOUR_MS }, P).length;
    }
    // Medido hoje: ~0,4 alerta por semente de 35 dias. A guarda (3/semente) só pega regressão grosseira.
    expect(total / 20).toBeLessThan(3);
  });
  it("pico: MAD e EWMA em USD/hora alertam até 2 h depois do início do pico", () => {
    const { alerts, onset } = run("pico");
    const limit = onset + 12 * HOUR_MS + 2 * HOUR_MS;
    for (const d of ["mad", "ewma"]) {
      const a = first(alerts, onset, (x) => x.detector === d && x.metric === "usd_per_hour");
      expect(a, d).toBeTruthy();
      expect(a!.tsMs).toBeLessThanOrEqual(limit);
    }
  });
  it("custo gradual: EWMA e CUSUM em USD/hora alertam antes do corte simulado do Guard", () => {
    const s = scenario("custo_gradual");
    const { alerts, onset } = run("custo_gradual");
    const cut = guardFirstCut(s)!;
    expect(cut).toBeTruthy();
    for (const d of ["ewma", "cusum"]) {
      const a = first(alerts, onset, (x) => x.detector === d && x.metric === "usd_per_hour");
      expect(a, d).toBeTruthy();
      expect(a!.tsMs + HOUR_MS).toBeLessThan(cut.atMs);
    }
  });
  it("loop de mesmo hash: repeat_payload alerta em minutos", () => {
    const { alerts, onset } = run("loop_mesmo_hash");
    const a = first(alerts, onset, (x) => x.detector === "repeat_payload");
    expect(a).toBeTruthy();
    expect(a!.tsMs - onset).toBeLessThanOrEqual(30 * 60_000);
  });
  it("run travada: stalled_run alerta em poucas horas", () => {
    const { alerts, onset } = run("run_travada");
    const a = first(alerts, onset, (x) => x.detector === "stalled_run");
    expect(a).toBeTruthy();
    expect(a!.tsMs - onset).toBeLessThanOrEqual(6 * HOUR_MS);
  });
  it("modelo do Guard: tráfego normal nunca é cortado; loop é cortado pelo hash repetido", () => {
    expect(guardFirstCut(scenario("normal_ruido"))).toBeNull();
    expect(guardFirstCut(scenario("loop_mesmo_hash"))!.rule).toMatch(/payload repetido/);
  });
});
