/**
 * products.propose-persist.test.ts — RFC-0004 T1.6b: a proposta do Splitter é PERSISTIDA.
 *
 * Cobre o que o Map em memória não dava: binding de tenant no poll (fecha o IDOR do GET
 * antigo), jobId legado (paj-...) → 404, mapeamento de 'interrupted' → error+flag,
 * rate-limit da ideia crua e o caminho AUTORITATIVO do ingest via proposalId.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROP_ID = "55555555-5555-4555-8555-555555555555";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null; email?: string } = {
  id: "u1", role: "user", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

// query handler compartilhado (pool.query e pool.connect().query passam por aqui).
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => queryHandler(sql, params),
    connect: async () => ({ query: async (sql: string, params: unknown[] = []) => queryHandler(sql, params), release: () => {} }),
  },
}));

vi.mock("./specs.js", () => ({ extractProductZip: () => null }));
vi.mock("../services/productProposals.js", () => ({ runProposeJob: () => {}, PROPOSAL_DEADLINE_MIN: 15 }));

const decomposeSpy = vi.fn(async (_pool: unknown, _params: { zip: { manifestText: string } }) => ({ productId: "prod-1", productName: "P", projects: [], waves: [], triggersCreated: 0, dispatched: [] as string[] }));
vi.mock("../services/productDecomposer.js", () => ({ decomposeProduct: (pool: unknown, params: { zip: { manifestText: string } }) => decomposeSpy(pool, params) }));

let app: FastifyInstance;
beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  process.env.API_AGENTS_URL = "http://agents.local";
  currentUser = { id: "u1", role: "user", tenantId: TENANT };
  queryHandler = () => ({ rows: [] });
  decomposeSpy.mockClear();
});

const LONG_DOC = "Uma ideia de produto com bastante texto para ultrapassar o mínimo de quarenta caracteres exigidos.";

describe("POST /api/products/propose — tenant + rate-limit", () => {
  it("sem tenant → 403", async () => {
    currentUser = { id: "u1", role: "user", tenantId: null };
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: LONG_DOC } });
    expect(res.statusCode).toBe(403);
  });

  it("4 propostas na última hora → 429", async () => {
    queryHandler = (sql) => {
      if (sql.includes("count(*)")) return { rows: [{ n: 4 }] };
      return { rows: [{ id: PROP_ID }] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: LONG_DOC } });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe("RATE_LIMITED");
  });

  it("abaixo do limite → 202 com jobId = id da linha", async () => {
    queryHandler = (sql) => {
      if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
      if (sql.includes("INSERT INTO product_proposals")) return { rows: [{ id: PROP_ID }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: LONG_DOC } });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).jobId).toBe(PROP_ID);
  });
});

describe("GET /api/products/propose/:jobId — binding + estados", () => {
  it("jobId legado (paj-...) não-UUID → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products/propose/paj-123-abc" });
    expect(res.statusCode).toBe(404);
  });

  it("proposta de outro tenant → 404 (IDOR fechado, não 403)", async () => {
    queryHandler = () => ({ rows: [{ id: PROP_ID, tenant_id: OTHER, status: "running", payload: null, warnings: [], error: null, origin_project_id: null, created_at: new Date().toISOString() }] });
    const res = await app.inject({ method: "GET", url: `/api/products/propose/${PROP_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it("interrupted → status error + interrupted:true", async () => {
    queryHandler = () => ({ rows: [{ id: PROP_ID, tenant_id: TENANT, status: "interrupted", payload: null, warnings: [], error: "reinício", origin_project_id: null, created_at: new Date().toISOString() }] });
    const res = await app.inject({ method: "GET", url: `/api/products/propose/${PROP_ID}` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.status).toBe("error");
    expect(b.interrupted).toBe(true);
  });

  it("done → devolve manifest/specs/originProjectId do payload", async () => {
    queryHandler = () => ({ rows: [{ id: PROP_ID, tenant_id: TENANT, status: "done", payload: { manifest: { product: { name: "X" } }, specs: { "a.md": "..." }, waves: [["a"]], projects: [] }, warnings: ["w"], error: null, origin_project_id: "orig-1", created_at: new Date().toISOString() }] });
    const res = await app.inject({ method: "GET", url: `/api/products/propose/${PROP_ID}` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.status).toBe("done");
    expect(b.manifest.product.name).toBe("X");
    expect(b.originProjectId).toBe("orig-1");
    expect(b.warnings).toEqual(["w"]);
  });

  it("done com payload purgado (>7d) → error+interrupted:true (expirada)", async () => {
    queryHandler = () => ({ rows: [{ id: PROP_ID, tenant_id: TENANT, status: "done", payload: null, warnings: [], error: null, origin_project_id: null, created_at: new Date().toISOString() }] });
    const res = await app.inject({ method: "GET", url: `/api/products/propose/${PROP_ID}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).interrupted).toBe(true);
  });
});

describe("POST /api/products/ingest-proposal — proposalId autoritativo", () => {
  it("proposalId de outro tenant → 404", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM product_proposals WHERE id=")) return { rows: [{ tenant_id: OTHER, status: "done", payload: { manifest: {}, specs: {} }, origin_project_id: null, consumed_product_id: null }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: { proposalId: PROP_ID } });
    expect(res.statusCode).toBe(404);
    expect(decomposeSpy).not.toHaveBeenCalled();
  });

  it("proposalId não pronta (running) → 409 PROPOSAL_NOT_READY", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM product_proposals WHERE id=")) return { rows: [{ tenant_id: TENANT, status: "running", payload: null, origin_project_id: null, consumed_product_id: null }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: { proposalId: PROP_ID } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("PROPOSAL_NOT_READY");
  });

  it("proposalId já consumida → 200 idempotente (aponta o produto criado, não redecompõe)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM product_proposals WHERE id=")) return { rows: [{ tenant_id: TENANT, status: "done", payload: null, origin_project_id: null, consumed_product_id: "prod-existente" }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: { proposalId: PROP_ID } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).productId).toBe("prod-existente");
    expect(decomposeSpy).not.toHaveBeenCalled();
  });

  it("proposalId done → usa payload autoritativo e decompõe (ignora manifest do body)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM product_proposals WHERE id=")) return { rows: [{ tenant_id: TENANT, status: "done", payload: { manifest: { product: { name: "AUTH" } }, specs: { "a.md": "x" } }, origin_project_id: null, consumed_product_id: null }] };
      return { rows: [], rowCount: 1 };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: { proposalId: PROP_ID, manifest: { product: { name: "FAKE" } }, specs: { "evil.md": "y" } } });
    expect(res.statusCode).toBe(201);
    // o manifest passado ao decompose vem da linha (AUTH), não do body (FAKE).
    const zipArg = decomposeSpy.mock.calls[0][1];
    expect(zipArg.zip.manifestText).toContain("AUTH");
    expect(zipArg.zip.manifestText).not.toContain("FAKE");
  });
});
