/**
 * dashboard.test.ts — PR-0 do épico Spec/Bancada (Onda 5): GET /api/dashboard/summary.
 *
 * Cobre o que não tinha teste (achado do mapeamento §1.2):
 *  • RBAC: tenant vê só o seu; admin sem ?tenantId é global; ?tenantId IGNORADO p/ não-admin;
 *    svc:"runner" → 403;
 *  • PR-0: a query de "tarefa atual" usa WAITING_REVIEW (não IN_REVIEW — que não existe no CHECK).
 * Padrão de mock = dialogue.test.ts / products.decompose.test.ts (auth injeta user; db mockado).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

let currentUser: Record<string, unknown> = { id: "u1", email: "a@x", role: "zentriz_admin", tenantId: null };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => { (req as { user: unknown }).user = currentUser; },
}));

const queryMock = vi.fn(async (_sql: string, _p?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("../db/client.js", () => ({
  pool: { query: (s: string, p?: unknown[]) => queryMock(s, p) },
  connectionString: "",
}));

import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

let app: FastifyInstance;

beforeEach(async () => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{}] });
  currentUser = { id: "u1", email: "a@x", role: "zentriz_admin", tenantId: null };
  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});

describe("GET /api/dashboard/summary — RBAC + PR-0", () => {
  it("svc:runner → 403", async () => {
    currentUser = { id: "r", email: "r@x", role: "user", svc: "runner", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    await app.close();
  });

  it("tenant_admin vê só o seu tenant (filtro por tenant_id, admin nulo)", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    expect(res.statusCode).toBe(200);
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT_A]);
    expect(res.json().admin).toBeNull();
    await app.close();
  });

  it("?tenantId é IGNORADO para não-admin (anti-escalonamento)", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    const res = await app.inject({ method: "GET", url: `/api/dashboard/summary?tenantId=${TENANT_B}` });
    expect(res.statusCode).toBe(200);
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT_A]);
    await app.close();
  });

  it("zentriz_admin sem ?tenantId → global (sem filtro) + seção admin presente", async () => {
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    expect(res.statusCode).toBe(200);
    expect(queryMock.mock.calls[0][1]).toEqual([]); // main query sem params → sem tenantFilter
    expect(queryMock.mock.calls.length).toBe(2); // main + bloco admin de tenants
    expect(res.json().admin).not.toBeNull();
    await app.close();
  });

  it("zentriz_admin com ?tenantId válido → escopa àquele tenant", async () => {
    currentUser = { id: "a", email: "a@x", role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "GET", url: `/api/dashboard/summary?tenantId=${TENANT_B}` });
    expect(res.statusCode).toBe(200);
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT_B]);
    await app.close();
  });

  it("PR-0: a query de 'tarefa atual' usa WAITING_REVIEW (não IN_REVIEW)", async () => {
    currentUser = { id: "u", email: "u@x", role: "tenant_admin", tenantId: TENANT_A };
    await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("WAITING_REVIEW");
    expect(sql).not.toContain("IN_REVIEW");
    await app.close();
  });
});
