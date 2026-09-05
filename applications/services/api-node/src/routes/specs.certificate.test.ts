/**
 * specs.certificate.test.ts — o Certificado Genesis Factory no payload de GET /api/specs.
 *
 * O que protege:
 *  • flag OFF (default) → payload byte-idêntico ao legado (nenhum campo novo, nenhuma query
 *    extra: ligar isto em prod não pode mudar nada até o Jean aprovar a tela);
 *  • flag ON → cada spec ganha `factoryCertificate`, calculado só para os ids que a query
 *    JÁ escopada por tenant devolveu (A8 — o selo nunca amplia o escopo da listagem);
 *  • falha no cálculo degrada para `factoryCertificate: null` — a listagem não quebra.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SPEC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPEC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = { id: "u1", role: "tenant_admin", tenantId: TENANT };
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        const s = sql.replace(/\s+/g, " ");
        if (s.includes("FROM projects p") && s.includes("p.status = ANY($1)")) {
          return { rows: [
            { id: SPEC_A, title: "tms", status: "draft", extra: {}, complexity_hint: "medium" },
            { id: SPEC_B, title: "identity", status: "draft", extra: {}, complexity_hint: "medium" },
          ] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  },
}));

// O enriquecimento (readiness/estimate) não é o objeto deste teste — devolve as specs cruas.
vi.mock("../services/specEnrichment.js", () => ({
  enrichSpecs: async (_c: unknown, specs: Array<Record<string, unknown>>) => specs,
}));

const certSpy = vi.fn(async (_db: unknown, ids: string[]) =>
  new Map(ids.map((id) => [id, { level: "certified", code: null, message: "ok" }])));
vi.mock("../services/factoryCertificate.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  computeFactoryCertificates: (db: unknown, ids: string[]) => certSpy(db, ids),
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { specRoutes } = await import("./specs.js");
  app = Fastify();
  await app.register(specRoutes);
  await app.ready();
  captured.length = 0;
  certSpy.mockClear();
});

afterEach(() => { delete process.env.FACTORY_CERTIFICATE; });

describe("GET /api/specs — Certificado Genesis Factory", () => {
  it("flag OFF (default): nenhum campo novo e nenhum cálculo de certificado", async () => {
    const res = await app.inject({ method: "GET", url: "/api/specs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty("factoryCertificate");
    expect(certSpy).not.toHaveBeenCalled();
  });

  it("flag ON: anexa o selo, e só para os ids que a listagem escopada devolveu (A8)", async () => {
    process.env.FACTORY_CERTIFICATE = "on";
    const res = await app.inject({ method: "GET", url: "/api/specs" });
    const body = res.json() as Array<Record<string, unknown>>;
    expect(certSpy).toHaveBeenCalledTimes(1);
    expect(certSpy.mock.calls[0][1]).toEqual([SPEC_A, SPEC_B]);
    expect(body.map((s) => (s.factoryCertificate as { level: string }).level)).toEqual(["certified", "certified"]);
    // O escopo veio da query da listagem (tenant do usuário), não de parâmetro do cliente.
    const listing = captured.find((q) => q.sql.includes("p.status = ANY($1)"));
    expect(listing?.params[1]).toBe(TENANT);
  });

  it("flag ON + falha no cálculo: `factoryCertificate: null` e listagem intacta", async () => {
    process.env.FACTORY_CERTIFICATE = "on";
    certSpy.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "GET", url: "/api/specs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0].factoryCertificate).toBeNull();
  });
});
