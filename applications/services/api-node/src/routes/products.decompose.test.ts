/**
 * products.decompose.test.ts — RFC-0003 B4: POST /api/projects/:id/decompose.
 *
 * Decompor uma spec JÁ salva na Bancada em uma proposta de produto: guardas de autoria/
 * ownership/estado, multi-md do disco, 503 sem agents, e o vínculo de origem (originProjectId)
 * ecoado na resposta para ser gravado no /ingest-proposal.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const SPEC_ID = "33333333-3333-4333-8333-333333333333";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1", role: "user", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => queryHandler(sql, params),
      release: () => {},
    }),
  },
}));

// Isola a rede: o job async do Product Architect não é exercido aqui (só a orquestração).
vi.mock("./specs.js", () => ({
  extractProductZip: () => null,
  httpPost: async () => JSON.stringify({ jobId: "agents-1" }),
  httpGet: async () => JSON.stringify({ status: "running" }),
}));

const readFileSpy = vi.fn(async (_p: string) => "Documento de spec com conteúdo suficiente para passar do mínimo de quarenta caracteres exigidos.");
vi.mock("node:fs/promises", () => ({ readFile: (p: string) => readFileSpy(p) }));

let app: FastifyInstance;

// Roteador default: spec pré-fábrica do próprio tenant, sem produto, com 1 arquivo .md.
function defaultHandler(over: { tenant?: string; createdBy?: string; status?: string; productId?: string | null; mdFiles?: number } = {}) {
  const { tenant = TENANT, createdBy = "u1", status = "spec_submitted", productId = null, mdFiles = 1 } = over;
  return (sql: string) => {
    if (sql.includes("FROM projects WHERE id")) {
      return { rows: [{ id: SPEC_ID, tenant_id: tenant, created_by: createdBy, title: "Minha Spec", status, product_id: productId }] };
    }
    if (sql.includes("FROM project_spec_files")) {
      return { rows: Array.from({ length: mdFiles }, (_v, i) => ({ filename: `spec${i}.md`, file_path: `/uploads/${SPEC_ID}/spec${i}.md` })) };
    }
    return { rows: [] };
  };
}

beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  process.env.API_AGENTS_URL = "http://agents.local";
  currentUser = { id: "u1", role: "user", tenantId: TENANT };
  queryHandler = defaultHandler();
  readFileSpy.mockClear();
  readFileSpy.mockResolvedValue("Documento de spec com conteúdo suficiente para passar do mínimo de quarenta caracteres exigidos.");
});

describe("POST /api/projects/:id/decompose — B4", () => {
  it("spec da Bancada do próprio tenant → 202 com jobId e originProjectId", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("pending");
    expect(body.originProjectId).toBe(SPEC_ID);
    expect(typeof body.jobId).toBe("string");
  });

  it("multi-md: concatena todos os .md do disco (readFile por arquivo)", async () => {
    queryHandler = defaultHandler({ mdFiles: 3 });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(readFileSpy).toHaveBeenCalledTimes(3);
  });

  it("master (zentriz_admin) é vetado — decompor é autoria → 403", async () => {
    currentUser = { id: "adm", role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("sem serviço de agentes configurado → 503", async () => {
    delete process.env.API_AGENTS_URL;
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("id não-UUID → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/abc/decompose", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("spec inexistente → 404", async () => {
    queryHandler = () => ({ rows: [] });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("spec de outro tenant (e não criada pelo usuário) → 403", async () => {
    queryHandler = defaultHandler({ tenant: OTHER_TENANT, createdBy: "outro" });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("spec já pertence a um produto → 409 ALREADY_IN_PRODUCT", async () => {
    queryHandler = defaultHandler({ productId: OTHER_TENANT });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("ALREADY_IN_PRODUCT");
  });

  it("projeto já na fábrica (não é spec) → 409 NOT_A_SPEC", async () => {
    queryHandler = defaultHandler({ status: "cto_charter" });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NOT_A_SPEC");
  });

  it("spec sem arquivos markdown → 422 NO_SPEC_FILES", async () => {
    queryHandler = defaultHandler({ mdFiles: 0 });
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe("NO_SPEC_FILES");
  });

  it("conteúdo insuficiente (todos os arquivos vazios/sumidos) → 422 SPEC_TOO_SHORT", async () => {
    readFileSpy.mockResolvedValue("   ");
    const res = await app.inject({ method: "POST", url: `/api/projects/${SPEC_ID}/decompose`, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe("SPEC_TOO_SHORT");
  });
});
