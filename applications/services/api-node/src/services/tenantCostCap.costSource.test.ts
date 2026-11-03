/**
 * C8' — fonte única de custo (flag COST_SOURCE_LEDGER) e visibilidade do fail-open do cap do tenant.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  checkTenantBudget, getCostCapStats, getTenantMonthSpendUsd, getTenantMonthSpendFromLedger, resetCostCapStats,
  type Queryable,
} from "./tenantCostCap.js";

const T = "11111111-1111-4111-8111-111111111111";

interface Calls { sql: string; params?: unknown[] }
function makeDb(o: { first?: string | null; ledger?: string; metrics?: string; budget?: string | null; failAll?: boolean; failLedger?: boolean }) {
  const calls: Calls[] = [];
  const db: Queryable = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (o.failAll) throw new Error("db down");
      if (sql.includes("INSERT INTO llm_guard_events")) return { rows: [] };
      if (sql.includes("FROM tenants t")) return { rows: [{ tenant_budget: o.budget ?? null, plan_budget: null }] };
      if (sql.includes("MIN(created_at)")) {
        if (o.failLedger) throw new Error("ledger down");
        return { rows: [{ first_at: o.first ?? null }] };
      }
      if (sql.includes("FROM llm_call_ledger")) return { rows: [{ usd: o.ledger ?? "0" }] };
      if (sql.includes("project_agent_metrics")) return { rows: [{ usd: o.metrics ?? "0" }] };
      return { rows: [] };
    },
  };
  return { db, calls };
}

const saved = process.env.COST_SOURCE_LEDGER;
beforeEach(() => { resetCostCapStats(); });
afterEach(() => {
  if (saved === undefined) delete process.env.COST_SOURCE_LEDGER; else process.env.COST_SOURCE_LEDGER = saved;
  delete process.env.TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT;
  vi.restoreAllMocks();
});

describe("COST_SOURCE_LEDGER=off (padrão) — byte-idêntico", () => {
  it("usa só project_agent_metrics, com o SQL e os parâmetros anteriores", async () => {
    delete process.env.COST_SOURCE_LEDGER;
    const { db, calls } = makeDb({ metrics: "7.5", ledger: "99" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(7.5);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM project_agent_metrics m");
    expect(calls[0].sql).toContain("m.created_at <  ($2::date + interval '1 month')");
    expect(calls[0].params).toEqual([T, "2026-10-01"]);
    expect(calls.some((c) => c.sql.includes("llm_call_ledger"))).toBe(false);
  });
  it("valor inválido da flag ⇒ off", async () => {
    process.env.COST_SOURCE_LEDGER = "sim";
    const { db, calls } = makeDb({ metrics: "1" });
    await getTenantMonthSpendUsd(db, T, "2026-10");
    expect(calls.some((c) => c.sql.includes("llm_call_ledger"))).toBe(false);
  });
});

describe("COST_SOURCE_LEDGER=on — regra de transição", () => {
  beforeEach(() => { process.env.COST_SOURCE_LEDGER = "on"; });

  it("ledger cobre o mês inteiro (cobertura <= início do mês) ⇒ só ledger, sem consultar metrics", async () => {
    const { db, calls } = makeDb({ first: "2026-10-01T00:00:00Z", ledger: "12.5", metrics: "999" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-11")).toBe(12.5);
    expect(calls.some((c) => c.sql.includes("project_agent_metrics"))).toBe(false);
    const q = calls.find((c) => c.sql.includes("FROM llm_call_ledger") && !c.sql.includes("MIN("))!;
    expect(q.params).toEqual([T, "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  });

  it("cobertura começa no meio do mês ⇒ metrics antes + ledger depois, sem sobreposição", async () => {
    const { db, calls } = makeDb({ first: "2026-10-10T12:00:00Z", ledger: "4", metrics: "3" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(7);
    const led = calls.find((c) => c.sql.includes("FROM llm_call_ledger") && !c.sql.includes("MIN("))!;
    const met = calls.find((c) => c.sql.includes("project_agent_metrics"))!;
    expect(led.params).toEqual([T, "2026-10-10T12:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(met.params).toEqual([T, "2026-10-01T00:00:00.000Z", "2026-10-10T12:00:00.000Z"]);
  });

  it("mês anterior à cobertura ⇒ só metrics (histórico não regride)", async () => {
    const { db, calls } = makeDb({ first: "2026-10-01T00:00:00Z", ledger: "50", metrics: "8.25" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-08")).toBe(8.25);
    expect(calls.some((c) => c.sql.includes("FROM llm_call_ledger") && !c.sql.includes("MIN("))).toBe(false);
  });

  it("ledger vazio ⇒ só metrics", async () => {
    const { db } = makeDb({ first: null, ledger: "50", metrics: "2" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(2);
  });

  it("erro do ledger em `on` propaga (quem decide o fail-open é checkTenantBudget)", async () => {
    const { db } = makeDb({ failLedger: true });
    await expect(getTenantMonthSpendUsd(db, T, "2026-10")).rejects.toThrow("ledger down");
  });

  it("detalhe: devolve as parcelas e o início da cobertura", async () => {
    const { db } = makeDb({ first: "2026-10-10T12:00:00Z", ledger: "4", metrics: "3" });
    const r = await getTenantMonthSpendFromLedger(db, T, "2026-10");
    expect(r).toMatchObject({ usd: 7, ledgerUsd: 4, metricsPreCoverageUsd: 3, coverageStart: "2026-10-10T12:00:00.000Z" });
  });

  it("o cap do tenant barra pelo ledger (gasto do ledger >= teto)", async () => {
    const { db } = makeDb({ first: "2026-01-01T00:00:00Z", ledger: "30", metrics: "1", budget: "20" });
    const r = await checkTenantBudget(db, T);
    expect(r).toMatchObject({ ok: false, spentUsd: 30, budgetUsd: 20 });
  });
});

describe("COST_SOURCE_LEDGER=shadow", () => {
  beforeEach(() => { process.env.COST_SOURCE_LEDGER = "shadow"; });

  it("devolve metrics e registra a divergência estruturada", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = makeDb({ first: "2026-01-01T00:00:00Z", ledger: "10", metrics: "6" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(6);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("cost_source_divergence"))!;
    expect(JSON.parse(line)).toMatchObject({ evt: "cost_source_divergence", tenantId: T, metricsUsd: 6, ledgerHybridUsd: 10, deltaUsd: 4 });
    expect(getCostCapStats().divergences).toBe(1);
  });

  it("sem divergência não registra nada", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = makeDb({ first: "2026-01-01T00:00:00Z", ledger: "5", metrics: "5" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falha do ledger em shadow NÃO muda o resultado nem lança", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = makeDb({ failLedger: true, metrics: "3" });
    expect(await getTenantMonthSpendUsd(db, T, "2026-10")).toBe(3);
    expect(getCostCapStats().shadowErrors).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe("cap mensal — fail-open VISÍVEL em erro de infra", () => {
  it("segue ok:true, conta, loga estruturado e tenta gravar o evento", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = makeDb({ failAll: true });
    expect(await checkTenantBudget(db, T)).toEqual({ ok: true });
    expect(await checkTenantBudget(db, T)).toEqual({ ok: true });
    expect(getCostCapStats().failOpen).toBe(2);
    const line = JSON.parse(String(err.mock.calls[1][0]));
    expect(line).toMatchObject({ evt: "tenant_cap_fail_open", tenantId: T, count: 2 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO llm_guard_events") && c.sql.includes("tenant_cap_fail_open"))).toBe(true);
  });

  it("grava o evento quando só a consulta de gasto falha (banco de eventos ok)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = makeDb({ budget: "10", failLedger: true });
    process.env.COST_SOURCE_LEDGER = "on";
    expect(await checkTenantBudget(db, T)).toEqual({ ok: true });
    const ev = calls.find((c) => c.sql.includes("INSERT INTO llm_guard_events"))!;
    expect(JSON.parse(String(ev.params![0]))).toMatchObject({ tenantId: T, err: "ledger down" });
  });
});
