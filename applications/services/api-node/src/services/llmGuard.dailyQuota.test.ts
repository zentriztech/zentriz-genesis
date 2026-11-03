/**
 * C8' — cota diária de tokens do tenant (flag DAILY_TOKEN_QUOTA) no preflight do Guard.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { checkDailyTokenQuota, preflight, type Queryable } from "./llmGuard.js";

const PID = "00000000-0000-0000-0000-0000000000aa";
const TEN = "22222222-2222-4222-8222-222222222222";

function db(s: { quota?: number | null; used?: number; recentEvent?: boolean; fail?: boolean; spentUsd?: number }) {
  const events: Array<{ sql: string; params?: unknown[] }> = [];
  const seen: string[] = [];
  const q: Queryable & { events: typeof events; seen: string[] } = {
    events, seen,
    async query(sql: string, params?: unknown[]) {
      seen.push(sql);
      if (/FROM llm_guard_settings/.test(sql) && /SELECT key, value/.test(sql)) return { rows: [{ key: "kill_switch", value: "off" }] };
      if (/AS unattributed_day/.test(sql)) return { rows: [{ hour: 0, day: 0, unattributed_day: 0 }] };
      if (/JOIN projects o ON o.id = COALESCE/.test(sql)) {
        return { rows: [{ id: PID, title: "P", tenant_id: TEN, created_by: null, status: "draft", budget_usd: 10,
          budget_alert_step_pct: 20, budget_paused_at: null, budget_paused_reason: null }] };
      }
      if (/percentile_cont/.test(sql)) return { rows: [{ med: 0 }] };
      if (/FROM llm_call_ledger WHERE budget_project_id/.test(sql)) return { rows: [{ total: s.spentUsd ?? 0, calls: 1 }] };
      if (/FROM tenant_llm_configs/.test(sql)) {
        if (s.fail) throw new Error("db down");
        return { rows: s.quota === undefined ? [] : [{ daily_token_quota: s.quota }] };
      }
      if (/SUM\(input_tokens \+ output_tokens\)/.test(sql)) return { rows: [{ tokens: s.used ?? 0 }] };
      if (/FROM llm_guard_events WHERE kind/.test(sql)) return { rows: s.recentEvent ? [{ "?column?": 1 }] : [] };
      if (/INSERT INTO llm_guard_events/.test(sql)) { events.push({ sql, params }); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    },
  };
  return q;
}
const call = { projectId: PID, model: "claude-haiku-4-5", estInputTokens: 100, maxOutputTokens: 100 };
const saved = process.env.DAILY_TOKEN_QUOTA;
afterEach(() => {
  if (saved === undefined) delete process.env.DAILY_TOKEN_QUOTA; else process.env.DAILY_TOKEN_QUOTA = saved;
  vi.restoreAllMocks();
});

describe("DAILY_TOKEN_QUOTA=off (padrão)", () => {
  it("não consulta nada novo e libera como antes", async () => {
    delete process.env.DAILY_TOKEN_QUOTA;
    const d = db({ quota: 10, used: 999 });
    const r = await preflight(d, call);
    expect(r).toMatchObject({ allow: true });
    expect(d.seen.some((s) => /tenant_llm_configs|input_tokens \+ output_tokens/.test(s))).toBe(false);
  });
});

describe("DAILY_TOKEN_QUOTA=on", () => {
  it("cota esgotada nega pelo caminho do Guard (código GLOBAL_DAILY_CAP), registra o evento e NÃO pausa o projeto", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    const d = db({ quota: 1000, used: 1000 });
    const r = await preflight(d, call);
    expect(r).toMatchObject({ allow: false, code: "GLOBAL_DAILY_CAP", budgetProjectId: PID });
    expect((r as { message: string }).message).toContain("Cota diária");
    expect(d.events).toHaveLength(1);
    expect(d.events[0].sql).toContain("INSERT INTO llm_guard_events");
    expect(d.events[0].params![0]).toBe("daily_token_quota_denied");
    expect(d.seen.some((s) => /budget_paused_at = now\(\)|kill_switch/.test(s) && /UPDATE|INSERT INTO llm_guard_settings/.test(s))).toBe(false);
  });
  it("abaixo da cota libera", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    expect(await preflight(db({ quota: 1000, used: 999 }), call)).toMatchObject({ allow: true });
  });
  it("sem cota (NULL, 0 ou sem linha) libera", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    for (const quota of [null, 0, undefined]) {
      expect(await preflight(db({ quota, used: 5 }), call)).toMatchObject({ allow: true });
    }
  });
  it("evento deduplicado por hora e tenant", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    const d = db({ quota: 1, used: 5, recentEvent: true });
    expect(await preflight(d, call)).toMatchObject({ allow: false });
    expect(d.events).toHaveLength(0);
  });
  it("erro de infra em `on` ⇒ fail-closed do Guard (GUARD_ERROR)", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await preflight(db({ fail: true }), call)).toMatchObject({ allow: false, code: "GUARD_ERROR" });
  });
  it("a negativa de orçamento continua tendo precedência (BUDGET_INSUFFICIENT)", async () => {
    process.env.DAILY_TOKEN_QUOTA = "on";
    const r = await preflight(db({ quota: 1, used: 5, spentUsd: 10 }), call);
    expect(r).toMatchObject({ allow: false, code: "BUDGET_INSUFFICIENT" });
  });
});

describe("DAILY_TOKEN_QUOTA=shadow", () => {
  it("só registra o que bloquearia; a chamada passa", async () => {
    process.env.DAILY_TOKEN_QUOTA = "shadow";
    const d = db({ quota: 1000, used: 2000 });
    expect(await preflight(d, call)).toMatchObject({ allow: true });
    expect(d.events).toHaveLength(1);
    expect(d.events[0].params![0]).toBe("daily_token_quota_shadow");
  });
  it("erro de infra em shadow não muda a decisão", async () => {
    process.env.DAILY_TOKEN_QUOTA = "shadow";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await preflight(db({ fail: true }), call)).toMatchObject({ allow: true });
  });
});

describe("checkDailyTokenQuota — direto", () => {
  it("tenant ausente (chamada sem dono) ⇒ não se aplica", async () => {
    expect(await checkDailyTokenQuota(db({ quota: 1, used: 9 }), null, null, "on")).toBeNull();
  });
});
