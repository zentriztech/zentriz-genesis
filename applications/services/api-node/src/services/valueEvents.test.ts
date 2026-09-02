/**
 * valueEvents.test.ts — value meter MVP interno (migration 068).
 * Cobre: emissão best-effort (NUNCA lança), defaults do INSERT e shape do
 * relatório GET /api/reports/value (via getValueReport com pool mockado).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { emitValueEvent, getValueReport } from "./valueEvents.js";
import type { Queryable } from "./tenantCostCap.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitValueEvent — best-effort", () => {
  it("erro do banco NÃO propaga (só console.warn)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: Queryable = { query: async () => { throw new Error("value_events does not exist"); } };
    await expect(
      emitValueEvent(broken, { tenantId: TENANT, eventType: "project_delivered" }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("db sem query (pool mockado incompleto) também não propaga", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notADb = {} as Queryable;
    await expect(
      emitValueEvent(notADb, { eventType: "deploy_completed" }),
    ).resolves.toBeUndefined();
  });

  it("INSERT com defaults: source=genesis, quantity=1, unit=count, metadata={}", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const db: Queryable = {
      query: async (sql, params) => { captured.push({ sql, params: params ?? [] }); return { rows: [] }; },
    };
    await emitValueEvent(db, { tenantId: TENANT, projectId: "p1", eventType: "project_delivered" });
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("INSERT INTO value_events");
    expect(captured[0].params).toEqual([TENANT, "p1", "project_delivered", "genesis", 1, "count", "{}"]);
  });
});

describe("getValueReport — shape do relatório", () => {
  function makeDb(eventRows: Record<string, unknown>[], metricsUsd = "0", ledgerUsd = "0"): Queryable {
    return {
      query: async (sql: string) => {
        if (sql.includes("FROM value_events")) return { rows: eventRows };
        if (sql.includes("pipeline_cost_ledger")) return { rows: [{ usd: ledgerUsd }] };
        if (sql.includes("project_agent_metrics")) return { rows: [{ usd: metricsUsd }] };
        return { rows: [] };
      },
    };
  }

  it("contagens por event_type + custo do mês + cost_per_delivery", async () => {
    const db = makeDb(
      [
        { event_type: "project_delivered", event_count: 2, total_quantity: "2" },
        { event_type: "deploy_completed", event_count: 3, total_quantity: "3" },
      ],
      "10",
    );
    const r = await getValueReport(db, TENANT, "2026-08");
    expect(r.month).toBe("2026-08");
    expect(r.tenantId).toBe(TENANT);
    expect(r.events.project_delivered).toEqual({ count: 2, quantity: 2 });
    expect(r.events.deploy_completed).toEqual({ count: 3, quantity: 3 });
    expect(r.llmCostUsd).toBe(10);
    expect(r.costPerDelivery).toBe(5);
  });

  it("sem entregas no mês → cost_per_delivery null", async () => {
    const r = await getValueReport(makeDb([], "10"), TENANT, "2026-08");
    expect(r.events).toEqual({});
    expect(r.costPerDelivery).toBeNull();
  });

  it("month ausente → usa o mês corrente (YYYY-MM)", async () => {
    const r = await getValueReport(makeDb([]), TENANT);
    expect(r.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});
