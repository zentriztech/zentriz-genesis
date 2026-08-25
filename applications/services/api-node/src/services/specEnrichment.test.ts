import { describe, it, expect } from "vitest";
import {
  buildEstimator,
  computeReadiness,
  enrichSpecs,
  fetchDepSignals,
  type HistoryBucket,
  type SpecForEnrichment,
  type Queryable,
} from "./specEnrichment.js";

const spec = (over: Partial<SpecForEnrichment> = {}): SpecForEnrichment => ({
  id: "11111111-1111-1111-1111-111111111111",
  title: "Portal do cliente",
  status: "draft",
  extra: { project_type: "frontend" },
  complexity_hint: "medium",
  ...over,
});

describe("buildEstimator (E3)", () => {
  const buckets: HistoryBucket[] = [
    { complexity: "medium", sampleSize: 4, avgDurationSec: 2400, avgCostUsd: 6.5 },
    { complexity: "high", sampleSize: 0, avgDurationSec: 0, avgCostUsd: 0 },
  ];

  it("usa histórico quando há amostra", () => {
    const est = buildEstimator(buckets)("medium");
    expect(est.basis).toBe("history");
    expect(est.durationSec).toBe(2400);
    expect(est.costUsd).toBe(6.5);
    expect(est.sampleSize).toBe(4);
  });

  it("cai no default quando o bucket não tem amostra", () => {
    const est = buildEstimator(buckets)("high");
    expect(est.basis).toBe("default");
    expect(est.sampleSize).toBe(0);
    expect(est.durationSec).toBeGreaterThan(0);
  });

  it("normaliza complexidade desconhecida para 'medium'", () => {
    const est = buildEstimator([])("banana");
    expect(est.complexity).toBe("medium");
    expect(est.basis).toBe("default");
  });

  it("trata complexity null como medium", () => {
    const est = buildEstimator([])(null);
    expect(est.complexity).toBe("medium");
  });
});

describe("computeReadiness (E2)", () => {
  const est = buildEstimator([{ complexity: "medium", sampleSize: 3, avgDurationSec: 100, avgCostUsd: 1 }]);

  it("spec completa sem deps → ready, score 100", () => {
    const r = computeReadiness(spec(), { total: 0, accepted: 0 }, est("medium"));
    expect(r.level).toBe("ready");
    expect(r.score).toBe(100);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("título placeholder reprova o check de título", () => {
    const r = computeReadiness(spec({ title: "Nova SPEC" }), { total: 0, accepted: 0 }, est("medium"));
    expect(r.checks.find((c) => c.key === "title")?.ok).toBe(false);
    expect(r.level).toBe("not_ready");
  });

  it("sem project_type reprova tech e derruba para not_ready", () => {
    const r = computeReadiness(spec({ extra: {} }), { total: 0, accepted: 0 }, est("medium"));
    expect(r.checks.find((c) => c.key === "tech")?.ok).toBe(false);
    expect(r.level).toBe("not_ready");
  });

  it("deps pendentes → almost (título+tech ok, deps não)", () => {
    const r = computeReadiness(spec(), { total: 3, accepted: 1 }, est("medium"));
    expect(r.checks.find((c) => c.key === "deps")?.ok).toBe(false);
    expect(r.level).toBe("almost");
    expect(r.checks.find((c) => c.key === "deps")?.hint).toContain("2 de 3");
  });

  it("todas as deps aceitas → deps ok", () => {
    const r = computeReadiness(spec(), { total: 2, accepted: 2 }, est("medium"));
    expect(r.checks.find((c) => c.key === "deps")?.ok).toBe(true);
    expect(r.level).toBe("ready");
  });

  it("estimativa sem histórico reprova o check de estimativa (informativo, não gate)", () => {
    const noHist = buildEstimator([]);
    const r = computeReadiness(spec(), { total: 0, accepted: 0 }, noHist("medium"));
    expect(r.checks.find((c) => c.key === "estimate")?.ok).toBe(false);
    // ainda ready — estimativa é informativa, não bloqueia promoção
    expect(r.level).toBe("ready");
    expect(r.score).toBe(75);
  });
});

describe("enrichSpecs (orquestrador)", () => {
  it("anexa readiness + estimate por spec e agrega deps/histórico", async () => {
    const specs = [spec({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }), spec({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "" })];
    const fake: Queryable = {
      query: async (sql: string) => {
        if (sql.includes("project_triggers")) {
          return { rows: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", total: 2, accepted: 2 }] };
        }
        if (sql.includes("pipeline_runs")) {
          return { rows: [{ complexity: "medium", sample_size: 5, avg_duration_sec: 1800, avg_cost_usd: 4 }] };
        }
        return { rows: [] };
      },
    };
    const out = await enrichSpecs(fake, specs);
    expect(out).toHaveLength(2);
    // spec A: deps 2/2 aceitas + título ok → ready
    expect(out[0].readiness.level).toBe("ready");
    expect(out[0].estimate.basis).toBe("history");
    expect(out[0].estimate.durationSec).toBe(1800);
    // spec B: sem título (vazio) → not_ready; sem entry em deps → total 0
    expect(out[1].readiness.checks.find((c) => c.key === "title")?.ok).toBe(false);
    expect(out[1].readiness.level).toBe("not_ready");
  });

  it("conta predecessor como pronto por completed OU accepted (mesma regra do dependencyGate)", async () => {
    let capturedSql = "";
    const fake: Queryable = {
      query: async (sql: string) => {
        capturedSql = sql;
        return { rows: [] };
      },
    };
    await fetchDepSignals(fake, ["11111111-1111-1111-1111-111111111111"]);
    // Regressão: contar só 'accepted' mostraria falsos pendentes para predecessor completed.
    expect(capturedSql).toContain("IN ('completed', 'accepted')");
  });

  it("lista vazia não roda SQL de deps", async () => {
    let calls = 0;
    const fake: Queryable = {
      query: async (sql: string) => {
        calls++;
        if (sql.includes("pipeline_runs")) return { rows: [] };
        return { rows: [] };
      },
    };
    const out = await enrichSpecs(fake, []);
    expect(out).toHaveLength(0);
    // só o histórico roda (deps é curto-circuitado por specIds.length === 0)
    expect(calls).toBe(1);
  });
});
