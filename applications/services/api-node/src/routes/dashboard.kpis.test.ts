/**
 * dashboard.kpis.test.ts — Onda 5 (épico Spec/Bancada): GET /api/dashboard/kpis.
 *
 * Cobre a auditoria adversarial:
 *  • RBAC (G1): runner 403; scope=admin só zentriz_admin; ?tenantId ignorado p/ não-admin;
 *  • cache por chave (G3): 2º hit = HIT sem re-consultar; chave não vaza escopo entre tenants;
 *  • flag DASHBOARD_KPIS=off → { enabled:false };
 *  • lead time "—" (null) com < 3 amostras;
 *  • grep-guard: toda query de escopo tenant contém `tenant_id = $1`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

let currentUser: Record<string, unknown> = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT_A };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const queryMock = vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [{}] as Record<string, unknown>[] }));
vi.mock("../db/client.js", () => ({
  pool: { query: (s: string, p?: unknown[]) => queryMock(s, p) },
  connectionString: "",
}));

import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes, _clearKpisCache } from "./dashboard.js";

// Roteador de SQL por substring para o escopo TENANT (dados plausíveis).
function tenantHandler(over: { leadSamples?: number; leadMedian?: number | null; budget?: number | null } = {}) {
  const { leadSamples = 5, leadMedian = 1200, budget = 50 } = over;
  return async (sql: string) => {
    if (sql.includes("AS on_bench")) {
      return { rows: [{
        on_bench: 3, in_factory: 2, blocked: 1, delivered_30d: 5, delivered_prev_30d: 3,
        failed_30d: 1, accepted_mtd: 4, lead_time_median_sec: leadMedian, lead_time_samples: leadSamples,
      }] };
    }
    if (sql.includes("FROM project_tasks")) return { rows: [{ done: 8, total: 10 }] };
    if (sql.includes("FROM product_proposals")) return { rows: [{ running: 1, ready: 2 }] };
    if (sql.includes("GROUP BY m.model")) return { rows: [{ model: "sonnet", usd: "3.5000" }] };
    if (sql.includes("FROM project_dialogue")) {
      return { rows: [{ summary_human: "atenção", from_agent: "pm", event_type: "step", severity: "warning", created_at: "2026-09-04T00:00:00Z", project_id: "p1", title: "Projeto X" }] };
    }
    if (sql.includes("FROM project_agent_metrics m") && sql.includes("JOIN projects p")) return { rows: [{ usd: "12.5000" }] }; // getTenantMonthSpendUsd
    if (sql.includes("monthly_llm_budget_usd")) return { rows: [{ tenant_budget: budget, plan_budget: null }] };
    return { rows: [{}] };
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{}] });
  _clearKpisCache();
  process.env.DASHBOARD_KPIS = "on";
  currentUser = { id: "u1", email: "a@x", role: "tenant_admin", tenantId: TENANT_A };
  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});

describe("GET /api/dashboard/kpis — RBAC (G1)", () => {
  it("svc:runner → 403", async () => {
    currentUser = { id: "r", email: "r@x", role: "user", svc: "runner", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=admin" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("scope=admin com tenant_admin → 403 (não 404)", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=admin" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    await app.close();
  });

  it("scope=admin com zentriz_admin → 200 escopo admin", async () => {
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=admin" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ enabled: true, scope: "admin" });
    expect(body.kpis).toHaveProperty("tenantsActive");
    await app.close();
  });

  it("scope=tenant tenant_admin → só o próprio tenant (param $1 = próprio)", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    queryMock.mockImplementation(tenantHandler());
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(TENANT_A);
    // toda query de escopo tenant recebeu TENANT_A como $1
    for (const call of queryMock.mock.calls) {
      if (Array.isArray(call[1]) && call[1].length) expect(call[1][0]).toBe(TENANT_A);
    }
    await app.close();
  });

  it("scope=tenant: ?tenantId IGNORADO para não-admin", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    queryMock.mockImplementation(tenantHandler());
    const res = await app.inject({ method: "GET", url: `/api/dashboard/kpis?scope=tenant&tenantId=${TENANT_B}` });
    expect(res.json().tenantId).toBe(TENANT_A);
    await app.close();
  });

  it("scope=tenant: zentriz_admin com ?tenantId → escopa àquele tenant", async () => {
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    queryMock.mockImplementation(tenantHandler());
    const res = await app.inject({ method: "GET", url: `/api/dashboard/kpis?scope=tenant&tenantId=${TENANT_B}` });
    expect(res.json().tenantId).toBe(TENANT_B);
    await app.close();
  });

  it("scope=tenant: zentriz_admin SEM ?tenantId → { tenant: null }", async () => {
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, scope: "tenant", tenant: null });
    await app.close();
  });
});

describe("GET /api/dashboard/kpis — flag", () => {
  it("DASHBOARD_KPIS=off → { enabled:false }", async () => {
    process.env.DASHBOARD_KPIS = "off";
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, features: { dashboardKpis: false } });
    await app.close();
  });
});

describe("GET /api/dashboard/kpis — cache por chave (G3)", () => {
  it("2º hit do mesmo tenant = HIT e NÃO re-consulta", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    queryMock.mockImplementation(tenantHandler());
    const r1 = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(r1.headers["x-cache"]).toBe("MISS");
    expect(r1.headers["x-elapsed-ms"]).toBeDefined();
    const callsAfterFirst = queryMock.mock.calls.length;
    const r2 = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(r2.headers["x-cache"]).toBe("HIT");
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst); // nenhuma consulta nova
    expect(r2.json()).toEqual(r1.json());
    await app.close();
  });

  it("chave NÃO vaza escopo entre tenants (B não recebe o cache de A)", async () => {
    queryMock.mockImplementation(tenantHandler());
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    await app.inject({ method: "GET", url: `/api/dashboard/kpis?scope=tenant&tenantId=${TENANT_A}` });
    const rB = await app.inject({ method: "GET", url: `/api/dashboard/kpis?scope=tenant&tenantId=${TENANT_B}` });
    expect(rB.headers["x-cache"]).toBe("MISS"); // chave distinta → não serve o cache de A
    expect(rB.json().tenantId).toBe(TENANT_B);
    await app.close();
  });
});

describe("GET /api/dashboard/kpis — lead time (T5)", () => {
  it("< 3 amostras → leadTimeMedianSec null ('—')", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    queryMock.mockImplementation(tenantHandler({ leadSamples: 2, leadMedian: 999 }));
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    expect(res.json().kpis.leadTimeMedianSec).toBeNull();
    await app.close();
  });

  it("≥ 3 amostras → leadTimeMedianSec numérico + campos derivados", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    queryMock.mockImplementation(tenantHandler({ leadSamples: 5, leadMedian: 1200 }));
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpis?scope=tenant" });
    const body = res.json();
    expect(body.kpis.leadTimeMedianSec).toBe(1200);
    expect(body.kpis.onBench).toBe(3);
    expect(body.kpis.failureRate30d).toBeCloseTo(1 / 6); // failed 1 / (accepted 5 + failed 1)
    expect(body.cost.monthUsd).toBe(12.5);
    expect(body.cost.budgetUsd).toBe(50);
    expect(body.cost.costPerDeliveryUsd).toBeCloseTo(12.5 / 4); // MTD ÷ acceptedMtd(4)
    expect(body.cost.topModels).toEqual([{ model: "sonnet", usd: 3.5 }]);
    expect(body.messages).toHaveLength(1);
    await app.close();
  });
});

describe("GET /api/dashboard/kpis — grep-guard SQL de escopo tenant", () => {
  it("toda query de escopo tenant em buildTenantKpis contém 'tenant_id = $1'", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dashboard.ts"), "utf-8");
    const start = src.indexOf("async function buildTenantKpis");
    const end = src.indexOf("async function buildAdminKpis");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const sqls = [...body.matchAll(/pool\.query\(\s*`([\s\S]*?)`/g)].map((m) => m[1]);
    expect(sqls.length).toBeGreaterThanOrEqual(5);
    for (const sql of sqls) {
      expect(sql.includes("tenant_id = $1"), `query sem 'tenant_id = $1':\n${sql.slice(0, 140)}`).toBe(true);
    }
  });
});
