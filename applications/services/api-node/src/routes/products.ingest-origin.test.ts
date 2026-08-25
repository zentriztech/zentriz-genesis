/**
 * products.ingest-origin.test.ts — RFC-0003 B4: guard de POSSE do vínculo de origem
 * em POST /api/products/ingest-proposal.
 *
 * O originProjectId do corpo só vira products.origin_project_id se a spec for do MESMO
 * tenant do produto que nasce. Id de outro tenant (ou inexistente) → vínculo descartado
 * (null), mas a ingestão prossegue (origem é enriquecimento, não requisito). Trava a
 * correção da revisão adversarial (vazamento cross-tenant).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MY_SPEC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SPEC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = { id: "u1", role: "user", tenantId: TENANT, email: "u1@x.com" };
  },
}));

// Só a query de posse importa aqui: SELECT 1 ... WHERE id=$1 AND tenant_id=$2.
// Devolve linha só quando o id é MY_SPEC (spec do tenant do chamador).
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM projects WHERE id") && sql.includes("tenant_id")) {
        const [id, tenant] = params as string[];
        return id === MY_SPEC && tenant === TENANT ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));

vi.mock("../services/runnerDispatch.js", () => ({
  dispatchProjectRun: vi.fn(async () => ({ dispatched: false, reason: "test" })),
}));

// Captura o originProjectId que a rota repassa ao executor determinístico.
const decomposeSpy = vi.fn(async (..._a: unknown[]) => ({
  productId: "prod-1", productName: "P", projects: [], waves: [[]], triggersCreated: 0, dispatched: [],
}));
vi.mock("../services/productDecomposer.js", () => ({ decomposeProduct: (...a: unknown[]) => decomposeSpy(...a) }));

const originArg = (call: number): string | null =>
  (decomposeSpy.mock.calls[call][1] as { originProjectId: string | null }).originProjectId;

let app: FastifyInstance;
const payload = (originProjectId?: string) => ({
  manifest: { product: { name: "P" }, projects: [] },
  specs: { "a.md": "conteudo" },
  ...(originProjectId ? { originProjectId } : {}),
});

beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  decomposeSpy.mockClear();
});

describe("ingest-proposal — guard de posse do vínculo de origem (B4)", () => {
  it("origem do próprio tenant → preservada em originProjectId", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: payload(MY_SPEC) });
    expect(res.statusCode).toBe(201);
    expect(decomposeSpy).toHaveBeenCalledTimes(1);
    expect(originArg(0)).toBe(MY_SPEC);
  });

  it("origem de OUTRO tenant → descartada (null), mas ingestão prossegue", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: payload(OTHER_SPEC) });
    expect(res.statusCode).toBe(201);
    expect(originArg(0)).toBeNull();
  });

  it("sem origem → null (produto avulso), sem consultar posse", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products/ingest-proposal", payload: payload() });
    expect(res.statusCode).toBe(201);
    expect(originArg(0)).toBeNull();
  });
});
