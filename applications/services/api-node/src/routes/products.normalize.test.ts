/**
 * products.normalize.test.ts — POST /api/products/:id/normalize depois do achado do Jean (2026-09-11).
 *
 * O que MUDOU e precisa ficar provado: documentar deixou de ser privilégio da Bancada. A regra antiga
 * (`lifecycle_status !== 'draft'` ⇒ 409) fazia com que 13 dos 15 produtos de prod nunca pudessem ter
 * RFC/ADR — era o bug que o Jean viu ("no produto … não temos RFC/ADR"). No lugar dela entrou a
 * ÚNICA guarda que o adversarial aceitou: run em voo (a escrita re-carimba `extra.spec_hash` e o
 * runner abortaria a execução com `spec_validation_failed`).
 *
 * Prova-se também o payload `promotion` do GET de um produto — é ele que a tela renderiza em vez de
 * reimplementar a regra (era assim que as três telas divergiam).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROD_ID = "33333333-3333-4333-8333-333333333333";
const PROJ_ID = "44444444-4444-4444-8444-444444444444";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1", role: "tenant_admin", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
const fakeQuery = async (sql: string, params: unknown[] = []) => {
  captured.push({ sql, params });
  return queryHandler(sql, params);
};
vi.mock("../db/client.js", () => ({
  pool: { query: fakeQuery, connect: async () => ({ query: fakeQuery, release: () => {} }) },
}));
vi.mock("../services/runnerDispatch.js", () => ({ dispatchProjectRun: async () => ({ dispatched: false }) }));
vi.mock("../services/productLifecycle.js", () => ({ recomputeProductLifecycle: async () => ({ changed: false }) }));
vi.mock("../services/promotionPlanner.js", () => ({
  PromotionPlanError: class extends Error {},
  buildPromotionPlan: async () => ({ items: [], notes: "", warnings: [], edgesSource: "agent", modelUsed: "m", inputTokens: 0, outputTokens: 0 }),
  debitPromotionPlannerUsage: async () => {},
}));

// A chamada de LLM é isolada: o que se testa é a ORQUESTRAÇÃO (quem passa pela guarda, quem não).
const normalizeOk = async () => ({
  status: "normalized" as const,
  normalizedHash: "hash-novo",
  result: {
    productId: PROD_ID, summary: "ok", anchorProjectId: PROJ_ID,
    written: [{ projectId: PROJ_ID, path: "docs/rfc/RFC-0001-x.md", action: "created" as const }],
    skippedProjects: [], warnings: [], truncated: [], rfcProblems: [],
    normalizedHash: "hash-novo", modelUsed: "claude-opus-5", inputTokens: 1, outputTokens: 2,
  },
});
const normalizeSpy = vi.fn(normalizeOk);
/** `normalized` do produto, controlável por teste (o disco é mockado). */
let productNormalized = false;
// Parâmetros DECLARADOS: sem eles o TS infere `calls` como tupla vazia e `calls[0][1]` não compila.
const debitSpy = vi.fn(async (..._args: unknown[]) => true);
/** Mesma forma da classe real: `details` opcional e `usage` carimbado pelo serviço. */
class FakeNormalizationError extends Error {
  usage?: { projectId: string; inputTokens: number; outputTokens: number; model: string | null };
  constructor(public code: string, msg: string, public details: Record<string, unknown> = {}) { super(msg); }
}
vi.mock("../services/productNormalizer.js", () => ({
  normalizeProduct: (...a: unknown[]) => normalizeSpy(...(a as [])),
  computeProductSpecHash: async () => "hash-atual",
  loadProductProjects: async () => [],
  isProductNormalized: async () => ({ normalized: productNormalized, storedHash: "h", currentHash: "h" }),
  debitNormalizerUsage: (...a: unknown[]) => debitSpy(...(a as [])),
  NormalizationError: FakeNormalizationError,
}));

/**
 * Roteia as consultas do normalize de produto.
 * `runInFlight` = projetos do produto com run aberta (`finished_at IS NULL`).
 */
function normalizeHandler(opts: { lifecycle?: string; isInbox?: boolean; runInFlight?: Array<{ id: string; title: string }> } = {}) {
  const { lifecycle = "draft", isInbox = false, runInFlight = [] } = opts;
  return (sql: string): { rows: unknown[]; rowCount?: number } => {
    if (sql.includes("FROM products WHERE id")) {
      return { rows: [{
        id: PROD_ID, tenant_id: TENANT, name: "VNX LastMile", description: null,
        system_id: "nvx-lastmile", lifecycle_status: lifecycle, is_inbox: isInbox, normalized_hash: null,
      }] };
    }
    if (sql.includes("FROM pipeline_runs")) return { rows: runInFlight, rowCount: runInFlight.length };
    return { rows: [], rowCount: 0 };
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  captured.length = 0;
  normalizeSpy.mockReset();
  normalizeSpy.mockImplementation(normalizeOk);
  debitSpy.mockClear();
  productNormalized = false;
  currentUser = { id: "u1", role: "tenant_admin", tenantId: TENANT };
});

describe("POST /api/products/:id/normalize — documentar não é privilégio da Bancada", () => {
  it("produto na Bancada (draft) normaliza", async () => {
    queryHandler = normalizeHandler();
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    expect(res.statusCode).toBe(200);
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["accepted", "running", "ingesting", "stalled_waiting_human"])(
    "produto JÁ na Fábrica (%s) também normaliza — era o parque inteiro sem RFC/ADR",
    async (lifecycle) => {
      queryHandler = normalizeHandler({ lifecycle });
      const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
      expect(res.statusCode).toBe(200);
      expect(normalizeSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("run EM VOO → 409 RUN_IN_FLIGHT, com os projetos nomeados e SEM gastar token", async () => {
    queryHandler = normalizeHandler({
      lifecycle: "running",
      runInFlight: [{ id: PROJ_ID, title: "Backend de rotas" }],
    });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("RUN_IN_FLIGHT");
    expect(body.message).toContain("Backend de rotas");
    expect(body.projects).toEqual([{ projectId: PROJ_ID, title: "Backend de rotas" }]);
    expect(normalizeSpy).not.toHaveBeenCalled();
  });

  it("a guarda de run em voo olha por PROJETO do produto, não pelo lifecycle", async () => {
    queryHandler = normalizeHandler({ lifecycle: "running" });
    await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    const q = captured.find((c) => c.sql.includes("FROM pipeline_runs"));
    expect(q?.sql).toContain("r.finished_at IS NULL");
    expect(q?.sql).toContain("p.product_id = $1");
    expect(q?.params[0]).toBe(PROD_ID);
  });

  it("recusa DEPOIS de chamar o modelo ainda debita o token gasto (o corte no teto de saída)", async () => {
    queryHandler = normalizeHandler();
    const err = new FakeNormalizationError(
      "NORMALIZER_BAD_RESPONSE", "A resposta do normalizador foi cortada no teto de saída (32000 de 32000 tokens).",
    );
    err.usage = { projectId: PROJ_ID, inputTokens: 9000, outputTokens: 32000, model: "claude-opus-5" };
    normalizeSpy.mockRejectedValueOnce(err);
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe("NORMALIZER_BAD_RESPONSE");
    expect(debitSpy).toHaveBeenCalledTimes(1);
    expect(debitSpy.mock.calls[0][1]).toMatchObject({
      productId: PROD_ID, projectId: PROJ_ID, inputTokens: 9000, outputTokens: 32000, model: "claude-opus-5",
    });
  });

  it("recusa ANTES de chamar o modelo não debita nada (ausente ≠ zero)", async () => {
    queryHandler = normalizeHandler();
    normalizeSpy.mockRejectedValueOnce(new FakeNormalizationError("NO_PROJECTS", "Nenhum projeto neste produto."));
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    expect(res.statusCode).toBe(422);
    expect(debitSpy).not.toHaveBeenCalled();
  });

  it("INBOX continua não sendo normalizável (os rascunhos não têm relação entre si)", async () => {
    queryHandler = normalizeHandler({ isInbox: true });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/normalize` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INBOX_NOT_NORMALIZABLE");
    expect(normalizeSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/products/:id — devolve o VEREDITO, não só o carimbo", () => {
  function getHandler(lifecycle: string, normalizedHash: string | null) {
    return (sql: string): { rows: unknown[]; rowCount?: number } => {
      if (sql.includes("SELECT * FROM products WHERE id")) {
        return { rows: [{
          id: PROD_ID, tenant_id: TENANT, name: "VNX LastMile", system_id: "nvx-lastmile",
          lifecycle_status: lifecycle, normalized_hash: normalizedHash,
        }] };
      }
      return { rows: [] };
    };
  }

  it("produto `running` → canPromote=false por NOT_ON_WORKBENCH (o caso que o Jean viu)", async () => {
    productNormalized = true;
    queryHandler = getHandler("running", "hash");
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.promotion).toMatchObject({ canPromote: false, reason: "NOT_ON_WORKBENCH" });
    expect(body.promotion.message).toContain("running");
  });

  it("produto na Bancada sem carimbo → NOT_NORMALIZED (normalizar destrava)", async () => {
    queryHandler = getHandler("draft", null);
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    const body = JSON.parse(res.body);
    expect(body.promotion).toMatchObject({ canPromote: false, reason: "NOT_NORMALIZED", normalized: false });
    expect(body.normalized).toBe(false);
  });

  it("produto na Bancada e documentado → canPromote=true", async () => {
    productNormalized = true;
    queryHandler = getHandler("draft", "hash");
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    expect(JSON.parse(res.body).promotion).toMatchObject({ canPromote: true, reason: null });
  });
});
