import { describe, it, expect } from "vitest";
import {
  buildEstimator,
  computeReadiness,
  enrichSpecs,
  fetchDepSignals,
  fetchGapCounts,
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
    // só o histórico roda (deps E gaps são curto-circuitados por specIds.length === 0)
    expect(calls).toBe(1);
  });

  // ── Onda 3 (c) + RFC-0005: gapCount = findings ATIVOS da última validação; ignorados à parte ──
  it("anexa gapCount (ativos) e gapCountIgnored da última validação; sem run → null", async () => {
    const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { findingFingerprint } = await import("./findingTriage.js");
    const fA1 = { file: "spec.md", line: null, severity: "warning", title: "Falta X", rationale: "", source: "stage_b", category: "missing_nfr", anchor: "x" } as const;
    const fA2 = { file: "spec.md", line: null, severity: "warning", title: "Falta Y", rationale: "", source: "stage_b", category: "missing_nfr", anchor: "y" } as const;
    const fake: Queryable = {
      query: async (sql: string) => {
        if (sql.includes("spec_validation_runs")) {
          return { rows: [{ id: A, findings: [fA1, fA2] }] };
        }
        if (sql.includes("spec_finding_triage")) {
          return { rows: [{ id: "t1", project_id: A, fingerprint: findingFingerprint(fA1), state: "ignored", reason_code: "accepted_risk", reason: "", severity_at: "warning", finding_snapshot: {}, spec_hash_at: "", actor_user_id: null, actor_role: "user", expires_at: null, inherited_from: null, recurrence_count: 0, created_at: "2026-09-04" }] };
        }
        if (sql.includes("pipeline_runs")) return { rows: [] };
        return { rows: [] };
      },
    };
    const out = await enrichSpecs(fake, [spec({ id: A }), spec({ id: B })]);
    expect(out[0].gapCount).toBe(1);          // A tem 2 findings, 1 ignorado → 1 ativo
    expect(out[0].gapCountIgnored).toBe(1);
    expect(out[1].gapCount).toBeNull();       // B nunca validada
    expect(out[1].gapCountIgnored).toBe(0);
  });

  it("fetchGapCounts degrada para mapa vazio quando o SQL falha", async () => {
    const fake: Queryable = {
      query: async () => { throw new Error("relation spec_validation_runs does not exist"); },
    };
    const map = await fetchGapCounts(fake, ["11111111-1111-1111-1111-111111111111"]);
    expect(map.size).toBe(0);
  });

  it("fetchGapCounts trata findings não-array como 0 GAPs", async () => {
    const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const fake: Queryable = {
      query: async () => ({ rows: [{ id: A, findings: null }] }),
    };
    const map = await fetchGapCounts(fake, [A]);
    expect(map.get(A)).toEqual({ active: 0, ignored: 0, refuted: 0 });
  });
});
