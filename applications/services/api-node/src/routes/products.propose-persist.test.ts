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
const cancelProposalSpy = vi.fn(async (_pool: unknown, _jobId: string, _by: string | null) => 1);
vi.mock("../services/productProposals.js", () => ({
  runProposeJob: () => {},
  PROPOSAL_DEADLINE_MIN: 15,
  cancelProposal: (pool: unknown, jobId: string, by: string | null) => cancelProposalSpy(pool, jobId, by),
}));

const decomposeSpy = vi.fn(async (_pool: unknown, _params: { zip: { manifestText: string } }) => ({ productId: "prod-1", productName: "P", projects: [], waves: [], triggersCreated: 0, dispatched: [] as string[] }));
vi.mock("../services/productDecomposer.js", () => ({ decomposeProduct: (pool: unknown, params: { zip: { manifestText: string } }) => decomposeSpy(pool, params) }));

// Onda 4 (PR-1/PR-2): gate de orçamento. Default ok:true; um teste força ok:false.
const budgetSpy = vi.fn(async (_pool: unknown, _tenantId: string) => ({ ok: true }) as { ok: boolean; spentUsd?: number; budgetUsd?: number });
vi.mock("../services/tenantCostCap.js", () => ({
  checkTenantBudget: (pool: unknown, tenantId: string) => budgetSpy(pool, tenantId),
  budgetExceededMessage: (spent: number, budget: number) => `Orçamento excedido: US$ ${spent} de US$ ${budget}.`,
}));

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
  cancelProposalSpy.mockClear();
  cancelProposalSpy.mockResolvedValue(1);
  budgetSpy.mockClear();
  budgetSpy.mockResolvedValue({ ok: true });
  delete process.env.PROPOSAL_BUDGET_GATE;
  delete process.env.PROPOSAL_MAX_CHARS;
  delete process.env.SPEC_UPLOAD_DECOMPOSE;
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

  it("documento acima do teto (PROPOSAL_MAX_CHARS) → 413 DOCUMENT_TOO_LARGE", async () => {
    const huge = "a".repeat(200_001);
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: huge } });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).code).toBe("DOCUMENT_TOO_LARGE");
  });

  it("gate de orçamento ON + tenant estourado → 429 BUDGET_EXCEEDED", async () => {
    process.env.PROPOSAL_BUDGET_GATE = "on";
    budgetSpy.mockResolvedValue({ ok: false, spentUsd: 12, budgetUsd: 10 });
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: LONG_DOC } });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe("BUDGET_EXCEEDED");
  });

  it("gate de orçamento OFF (default) → não consulta budget", async () => {
    queryHandler = (sql) => {
      if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
      if (sql.includes("INSERT INTO product_proposals")) return { rows: [{ id: PROP_ID }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/products/propose", payload: { document: LONG_DOC } });
    expect(res.statusCode).toBe(202);
    expect(budgetSpy).not.toHaveBeenCalled();
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

  it("done → devolve manifest/specs/originProjectId + usage/costUsd/source (PR-2)", async () => {
    queryHandler = () => ({ rows: [{ id: PROP_ID, tenant_id: TENANT, status: "done", payload: { manifest: { product: { name: "X" } }, specs: { "a.md": "..." }, waves: [["a"]], projects: [] }, warnings: ["w"], error: null, origin_project_id: "orig-1", created_at: new Date().toISOString(), input_tokens: 1_000_000, output_tokens: 1_000_000, model_used: "us.anthropic.claude-sonnet-4-6", model_id: "us.anthropic.claude-sonnet-4-6", source: "upload" }] });
    const res = await app.inject({ method: "GET", url: `/api/products/propose/${PROP_ID}` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.status).toBe("done");
    expect(b.manifest.product.name).toBe("X");
    expect(b.originProjectId).toBe("orig-1");
    expect(b.warnings).toEqual(["w"]);
    expect(b.source).toBe("upload");
    expect(b.usage).toEqual({ input_tokens: 1_000_000, output_tokens: 1_000_000, model_used: "us.anthropic.claude-sonnet-4-6" });
    // costUsd deriva do preço único (modelPricing) — deve ser > 0 com 1M+1M tokens.
    expect(typeof b.costUsd).toBe("number");
    expect(b.costUsd).toBeGreaterThan(0);
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

describe("GET /api/products/proposals — Onda 4 (PR-3): listagem tenant-scoped", () => {
  it("sem tenant (não-master) → items vazio + features (fail-closed)", async () => {
    currentUser = { id: "u1", role: "user", tenantId: null };
    const res = await app.inject({ method: "GET", url: "/api/products/proposals" });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.items).toEqual([]);
    expect(b.features).toEqual({ specUploadDecompose: false });
  });

  it("lista propostas do tenant com reviewReady/usage/costUsd + etaSeconds", async () => {
    queryHandler = (sql) => {
      if (sql.includes("percentile_cont")) return { rows: [{ eta: 123.7 }] };
      if (sql.includes("FROM product_proposals")) {
        return { rows: [
          { id: PROP_ID, status: "done", source: "upload", created_at: "2026-09-04T00:00:00Z", updated_at: "2026-09-04T00:02:00Z", origin_project_id: "orig-1", consumed_at: null, consumed_product_id: null, input_tokens: 1_000_000, output_tokens: 1_000_000, model_used: "us.anthropic.claude-sonnet-4-6", model_id: null, error: null },
        ] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: "/api/products/proposals" });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.etaSeconds).toBe(124);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].reviewReady).toBe(true);
    expect(b.items[0].consumed).toBe(false);
    expect(b.items[0].source).toBe("upload");
    expect(b.items[0].costUsd).toBeGreaterThan(0);
  });

  it("features.specUploadDecompose reflete SPEC_UPLOAD_DECOMPOSE=on", async () => {
    process.env.SPEC_UPLOAD_DECOMPOSE = "on";
    queryHandler = (sql) => (sql.includes("percentile_cont") ? { rows: [{ eta: null }] } : { rows: [] });
    const res = await app.inject({ method: "GET", url: "/api/products/proposals" });
    expect(JSON.parse(res.body).features.specUploadDecompose).toBe(true);
  });

  it("status inválido é ignorado (allow-list) — não injeta na query", async () => {
    let sawStatusFilter = false;
    queryHandler = (sql) => {
      if (sql.includes("percentile_cont")) return { rows: [{ eta: null }] };
      if (sql.includes("FROM product_proposals")) { sawStatusFilter = sql.includes("status = ANY"); return { rows: [] }; }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: "/api/products/proposals?status=DROP;--" });
    expect(res.statusCode).toBe(200);
    expect(sawStatusFilter).toBe(false);
  });
});

describe("POST /api/products/propose/:jobId/cancel — Onda 4 (PR-3)", () => {
  it("jobId não-UUID → 404", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products/propose/paj-abc/cancel" });
    expect(res.statusCode).toBe(404);
    expect(cancelProposalSpy).not.toHaveBeenCalled();
  });

  it("proposta de outro tenant → 404 (não vaza existência)", async () => {
    queryHandler = () => ({ rows: [{ tenant_id: OTHER, status: "running", consumed_at: null }] });
    const res = await app.inject({ method: "POST", url: `/api/products/propose/${PROP_ID}/cancel` });
    expect(res.statusCode).toBe(404);
    expect(cancelProposalSpy).not.toHaveBeenCalled();
  });

  it("proposta já terminal (done) → 409 ALREADY_TERMINAL", async () => {
    queryHandler = () => ({ rows: [{ tenant_id: TENANT, status: "done", consumed_at: null }] });
    const res = await app.inject({ method: "POST", url: `/api/products/propose/${PROP_ID}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("ALREADY_TERMINAL");
    expect(cancelProposalSpy).not.toHaveBeenCalled();
  });

  it("proposta consumida → 409 ALREADY_TERMINAL", async () => {
    queryHandler = () => ({ rows: [{ tenant_id: TENANT, status: "running", consumed_at: new Date().toISOString() }] });
    const res = await app.inject({ method: "POST", url: `/api/products/propose/${PROP_ID}/cancel` });
    expect(res.statusCode).toBe(409);
  });

  it("running do próprio tenant → 200 interrupted (chama cancelProposal)", async () => {
    queryHandler = () => ({ rows: [{ tenant_id: TENANT, status: "running", consumed_at: null }] });
    const res = await app.inject({ method: "POST", url: `/api/products/propose/${PROP_ID}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("interrupted");
    expect(cancelProposalSpy).toHaveBeenCalledWith(expect.anything(), PROP_ID, "u1");
  });

  it("corrida: cancelProposal devolve 0 → 409 (não 200 falso)", async () => {
    queryHandler = () => ({ rows: [{ tenant_id: TENANT, status: "running", consumed_at: null }] });
    cancelProposalSpy.mockResolvedValue(0);
    const res = await app.inject({ method: "POST", url: `/api/products/propose/${PROP_ID}/cancel` });
    expect(res.statusCode).toBe(409);
  });
});
