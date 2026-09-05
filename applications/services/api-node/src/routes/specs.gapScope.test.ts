/**
 * specs.gapScope.test.ts — PR-4 (F2): rotas do mapa GAPs ↔ ARQUIVOS.
 *
 * O que protege:
 *  • GET /api/specs/:id/gap-scope é GRÁTIS — devolve o mapa/fila sem NUNCA chamar modelo
 *    (um GET que gasta dinheiro é um GET que ninguém pode chamar de dentro da UI);
 *  • POST /api/specs/:id/gap-routes é a ação explícita que roteia o que sobrou, e sem agents
 *    configurado ela NÃO inventa rota (devolve `routing.skipped` com o motivo);
 *  • as duas fecham para token de serviço (runner) e para projeto de outro tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJ = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

let currentUser: { id: string; role: string; tenantId: string | null; svc?: string } = { id: USER_ID, role: "user", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

const FINDINGS = [
  { file: "backend/01-api.md", line: 5, severity: "blocker", title: "Falta authz", rationale: "", source: "stage_b", category: "security_gap", anchor: "FR-01" },
  { file: "backend/01-api.md", line: 9, severity: "warning", title: "Sem paginação", rationale: "", source: "stage_b", category: "missing_nfr", anchor: "FR-02" },
  { file: "frontend/01-web.md", line: null, severity: "warning", title: "Sem critérios de aceite", rationale: "", source: "stage_b", category: "no_acceptance_criteria", anchor: "FR-03" },
  { file: "", line: null, severity: "warning", title: "Global do Stage A", rationale: "", source: "stage_a", category: "structural", anchor: "regra-1" },
];

const captured: string[] = [];
const handler = (sql: string) => {
  const s = sql.replace(/\s+/g, " ");
  captured.push(s);
  if (s.includes("SELECT finding_routes")) return { rows: [{}] };
  if (s.includes("FROM project_spec_files")) {
    return { rows: [
      { filename: "00-indice.md", rel_dir: null, file_path: "/shared/uploads/p/00-indice.md", is_primary: true },
      { filename: "01-api.md", rel_dir: "backend", file_path: "/shared/uploads/p/backend/01-api.md", is_primary: false },
      { filename: "01-web.md", rel_dir: "frontend", file_path: "/shared/uploads/p/frontend/01-web.md", is_primary: false },
    ] };
  }
  if (s.includes("FROM spec_validation_runs")) return { rows: [{ id: "run-1", created_at: new Date().toISOString(), status: "failed", findings: FINDINGS }] };
  if (s.includes("FROM projects")) return { rows: [{ id: PROJ, tenant_id: TENANT, created_by: USER_ID, status: "on_bench", title: "tms" }] };
  return { rows: [] };
};
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string) => handler(sql),
    connect: async () => ({ query: async (sql: string) => handler(sql), release: () => {} }),
  },
}));

let app: FastifyInstance;
beforeEach(async () => {
  const { specRoutes } = await import("./specs.js");
  app = Fastify();
  await app.register(specRoutes);
  await app.ready();
  currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
  captured.length = 0;
  delete process.env.API_AGENTS_URL;
});
afterEach(() => { delete process.env.API_AGENTS_URL; });

describe("GET /api/specs/:id/gap-scope", () => {
  it("devolve GAPs ativos por arquivo, fila priorizada e o que ficou sem arquivo — sem gastar LLM", async () => {
    const res = await app.inject({ method: "GET", url: `/api/specs/${PROJ}/gap-scope` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.fileCount).toBe(3);
    expect(b.totalActive).toBe(4);
    expect(b.unrouted).toBe(1);                       // o global do Stage A (rota ainda não decidida)
    expect(b.files.find((f: { path: string }) => f.path === "backend/01-api.md")).toMatchObject({ active: 2, blockers: 1, warnings: 1, routed: 0 });
    expect(b.files.find((f: { path: string }) => f.path === "00-indice.md")).toMatchObject({ active: 0, isPrimary: true });
    // blocker primeiro → é o arquivo que o laço autônomo (PR-5) pega antes
    expect(b.queue).toEqual(["backend/01-api.md", "frontend/01-web.md"]);
    // guarda: um GET não dispara roteamento (nada de UPDATE na run)
    expect(captured.some((s) => s.includes("UPDATE spec_validation_runs"))).toBe(false);
  });

  it("token de serviço (runner) → 403; projeto de outro tenant → 404", async () => {
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT, svc: "runner" };
    expect((await app.inject({ method: "GET", url: `/api/specs/${PROJ}/gap-scope` })).statusCode).toBe(403);

    currentUser = { id: USER_ID, role: "user", tenantId: OTHER };
    expect((await app.inject({ method: "GET", url: `/api/specs/${PROJ}/gap-scope` })).statusCode).toBe(404);
  });
});

describe("POST /api/specs/:id/gap-routes", () => {
  it("sem agents configurado: devolve o mapa + routing.skipped e NÃO inventa rota", async () => {
    const res = await app.inject({ method: "POST", url: `/api/specs/${PROJ}/gap-routes` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.routing).toMatchObject({ skipped: true, routed: 0 });
    expect(b.unrouted).toBe(1);
    expect(captured.some((s) => s.includes("UPDATE spec_validation_runs"))).toBe(false);
  });

  it("token de serviço (runner) → 403 (roteamento é ação paga do dono da spec)", async () => {
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT, svc: "runner" };
    expect((await app.inject({ method: "POST", url: `/api/specs/${PROJ}/gap-routes` })).statusCode).toBe(403);
  });
});
