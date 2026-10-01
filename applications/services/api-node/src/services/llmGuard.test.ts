import { describe, it, expect } from "vitest";
import { alertThresholds, minNextActivityUsd, preflight, type Queryable } from "./llmGuard.js";

const PID = "00000000-0000-0000-0000-0000000000aa";

/** Banco falso dirigido por estado: o suficiente para o preflight decidir. */
function db(state: {
  settings?: Record<string, string>; hourUsd?: number; dayUsd?: number; unattributedUsd?: number;
  repeats?: number; owner?: Record<string, unknown> | null; spentUsd?: number; medianUsd?: number;
}) {
  const writes: string[] = [];
  const q: Queryable & { writes: string[] } = {
    writes,
    async query(sql: string) {
      if (/FROM llm_guard_settings/.test(sql) && /SELECT key, value/.test(sql)) {
        return { rows: Object.entries(state.settings ?? { kill_switch: "off" }).map(([key, value]) => ({ key, value })) };
      }
      if (/SELECT value FROM llm_guard_settings/.test(sql)) return { rows: [{ value: state.settings?.kill_switch ?? "off" }] };
      if (/AS unattributed_day/.test(sql)) return { rows: [{ hour: state.hourUsd ?? 0, day: state.dayUsd ?? 0, unattributed_day: state.unattributedUsd ?? 0 }] };
      if (/WHERE prompt_hash = \$1/.test(sql)) return { rows: [{ n: state.repeats ?? 0 }] };
      if (/JOIN projects o ON o.id = COALESCE/.test(sql)) return { rows: state.owner ? [state.owner] : [] };
      if (/percentile_cont/.test(sql)) return { rows: [{ med: state.medianUsd ?? 0 }] };
      if (/FROM llm_call_ledger WHERE budget_project_id/.test(sql)) return { rows: [{ total: state.spentUsd ?? 0, calls: 1 }] };
      writes.push(sql);
      return { rows: [], rowCount: 1 };
    },
  };
  return q;
}

const owner = (o: Record<string, unknown> = {}) => ({
  id: PID, title: "P", tenant_id: null, created_by: null, status: "draft",
  budget_usd: 10, budget_alert_step_pct: 20, budget_paused_at: null, budget_paused_reason: null, ...o,
});

describe("alertThresholds — passo escolhido + 30/20/10/0% restantes obrigatórios", () => {
  it("passo 30 ⇒ 30, 60 + 70/80/90/100", () => expect(alertThresholds(30)).toEqual([30, 60, 70, 80, 90, 100]));
  it("passo 20 ⇒ sem duplicar o 80", () => expect(alertThresholds(20)).toEqual([20, 40, 60, 70, 80, 90, 100]));
  it("passo inválido ⇒ só os obrigatórios", () => expect(alertThresholds(15)).toEqual([70, 80, 90, 100]));
});

describe("minNextActivityUsd", () => {
  it("3 chamadas medianas, piso US$ 0,10", () => {
    expect(minNextActivityUsd({ medianCallUsd: 0.5 } as never)).toBeCloseTo(1.5);
    expect(minNextActivityUsd({ medianCallUsd: 0 } as never)).toBe(0.1);
  });
});

describe("preflight — fail-closed", () => {
  it("chave geral ligada nega tudo", async () => {
    const r = await preflight(db({ settings: { kill_switch: "on" } }), { projectId: PID });
    expect(r).toMatchObject({ allow: false, code: "KILL_SWITCH" });
  });
  it("teto global por hora nega e LIGA a chave geral", async () => {
    const d = db({ hourUsd: 41 });
    const r = await preflight(d, { projectId: PID });
    expect(r).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP" });
    expect(d.writes.some((w) => /INSERT INTO llm_guard_settings/.test(w))).toBe(true);
  });
  it("payload repetido (assinatura do incidente) é negado", async () => {
    const r = await preflight(db({ repeats: 4, owner: owner() }), { projectId: PID, promptHash: "abc" });
    expect(r).toMatchObject({ allow: false, code: "REPEAT_PAYLOAD" });
  });
  it("projeto sem orçamento é negado", async () => {
    const r = await preflight(db({ owner: owner({ budget_usd: null }) }), { projectId: PID });
    expect(r).toMatchObject({ allow: false, code: "BUDGET_MISSING" });
  });
  it("projeto pausado é negado", async () => {
    const r = await preflight(db({ owner: owner({ budget_paused_at: "2026-10-01" }) }), { projectId: PID });
    expect(r).toMatchObject({ allow: false, code: "BUDGET_PAUSED" });
  });
  it("chamada que não cabe no saldo PAUSA e nega", async () => {
    const d = db({ owner: owner({ budget_usd: 1 }), spentUsd: 0.99 });
    const r = await preflight(d, { projectId: PID, model: "claude-opus-5", estInputTokens: 100_000, maxOutputTokens: 8000 });
    expect(r).toMatchObject({ allow: false, code: "BUDGET_INSUFFICIENT" });
    expect(d.writes.some((w) => /SET budget_paused_at = now\(\)/.test(w))).toBe(true);
  });
  it("com saldo, libera e informa quanto resta", async () => {
    const r = await preflight(db({ owner: owner(), spentUsd: 2 }), { projectId: PID, model: "claude-haiku-4-5", estInputTokens: 1000, maxOutputTokens: 1000 });
    expect(r).toMatchObject({ allow: true, remainingUsd: 8 });
  });
  it("sem projeto: teto diário pequeno", async () => {
    const r = await preflight(db({ unattributedUsd: 5 }), {});
    expect(r).toMatchObject({ allow: false, code: "UNATTRIBUTED_DAILY_CAP" });
  });
  it("banco fora ⇒ NEGA (fail-closed)", async () => {
    const r = await preflight({ query: async () => { throw new Error("down"); } }, { projectId: PID });
    expect(r).toMatchObject({ allow: false, code: "GUARD_ERROR" });
  });
});
