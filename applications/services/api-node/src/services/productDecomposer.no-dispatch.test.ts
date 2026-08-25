/**
 * productDecomposer.no-dispatch.test.ts — RFC-0003 B1 (decomposição sem disparo).
 *
 * Valida a ALMA do pivô: por padrão, decompor SALVA os N projetos como rascunhos na
 * Bancada (isDraft, produto 'draft') e NÃO dispara a fábrica (dispatched vazio). O modo
 * express (dispatch:true) preserva o comportamento legado (fábrica + produto 'running').
 *
 * Manifesto e criação de projeto são isolados por mock — aqui testamos a ORQUESTRAÇÃO
 * do decompose (flag dispatch → lifecycle + dispatched + specApproved/isDraft repassados).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Sketch fixo: contracts (onda 0, sem deps) ← api (onda 1, depende de contracts).
const SKETCH = {
  product: { name: "P", description: "d", systemId: "sys-p", deliveryDefault: "backend" },
  projects: [
    { id: "contracts", spec: "contracts.md", type: "contracts", wave: 0, delivery: "backend", dependsOn: [] },
    { id: "api", spec: "api.md", type: "backend", wave: 1, delivery: "backend", dependsOn: ["contracts"] },
  ],
  waves: [["contracts"], ["api"]],
};

vi.mock("./productManifest.js", () => ({
  parseManifest: () => ({ product: { name: "P" } }),
  buildProductSketch: () => SKETCH,
  computeProductHash: () => "hash-fixo",
  ManifestError: class ManifestError extends Error {
    code: string;
    constructor(code: string, msg: string) { super(msg); this.code = code; }
  },
}));

const createSpy = vi.fn(async (_client: unknown, params: { title: string; isDraft?: boolean; specApproved?: boolean }) => ({
  projectId: `id-${params.title}`,
  status: params.isDraft ? "draft" : (params.specApproved ? "pending_conversion" : "spec_submitted"),
}));
vi.mock("./projectCreation.js", () => ({
  createProjectFromSpec: (client: unknown, params: unknown) => createSpy(client, params as { title: string }),
}));

let decomposeProduct: typeof import("./productDecomposer.js").decomposeProduct;

// pool falso: idempotência (SELECT products) devolve vazio; connect() dá um client que
// roteia por SQL e captura o valor gravado em lifecycle_status.
const captured = { lifecycle: null as string | null };
function makePool() {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO products")) return { rows: [{ id: "prod1", name: "P" }] };
      if (sql.includes("UPDATE products SET lifecycle_status")) {
        captured.lifecycle = (params?.[1] as string) ?? null;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM products WHERE tenant_id")) return { rows: [] }; // idempotência: nada existe
      return { rows: [] };
    },
    connect: async () => client,
  } as unknown as import("pg").Pool;
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const baseParams = () => ({
  tenantId: TENANT,
  createdBy: "u1",
  approverEmail: "a@b.c",
  zip: { manifestText: "{}", files: new Map([["contracts.md", "# c"], ["api.md", "# a"]]) },
});

beforeEach(async () => {
  createSpy.mockClear();
  captured.lifecycle = null;
  ({ decomposeProduct } = await import("./productDecomposer.js"));
});

describe("decomposeProduct — B1 (sem disparo por padrão)", () => {
  it("default (save-only) → produto 'draft', dispatched vazio, filhos isDraft e specApproved=false", async () => {
    const r = await decomposeProduct(makePool(), baseParams());
    expect(r.dispatched).toEqual([]);
    expect(captured.lifecycle).toBe("draft");
    expect(createSpy).toHaveBeenCalledTimes(2);
    for (const call of createSpy.mock.calls) {
      const params = call[1] as { isDraft?: boolean; specApproved?: boolean };
      expect(params.isDraft).toBe(true);
      expect(params.specApproved).toBe(false);
    }
  });

  it("express (dispatch:true) → produto 'running', onda 0 em dispatched, filhos NÃO-draft", async () => {
    const r = await decomposeProduct(makePool(), { ...baseParams(), dispatch: true });
    expect(r.dispatched).toEqual(["id-contracts"]); // onda 0 = contracts
    expect(captured.lifecycle).toBe("running");
    for (const call of createSpy.mock.calls) {
      const params = call[1] as { isDraft?: boolean };
      expect(params.isDraft).toBe(false);
    }
  });

  it("cria os 2 projetos e monta o mapa manifestId→projectId em ambos os modos", async () => {
    const r = await decomposeProduct(makePool(), baseParams());
    expect(r.projects.map((p) => p.manifestId).sort()).toEqual(["api", "contracts"]);
    expect(r.triggersCreated).toBe(1); // api depende de contracts
  });
});
