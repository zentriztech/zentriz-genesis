/**
 * productsSpecTree.test.ts — redesign Bancada Onda 2: GET /api/products/:id/spec-tree.
 *
 * Cobre o endpoint que AGREGA os project_spec_files de todos os projetos de um produto
 * (metadados apenas — sem leitura de disco) para o editor de "pasta do produto":
 *   • UUID inválido → 400 INVALID_PRODUCT_ID;
 *   • produto de outro tenant (não-master) → 404 (não vaza existência);
 *   • caminho feliz → agrupa por projeto, deriva `editable` do status, ext sem ponto,
 *     path = rel_dir/filename;
 *   • produto sem specs → { projects: [] }.
 *
 * auth/db mockados; a rota é REAL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const PROJ_A = "44444444-4444-4444-8444-444444444444";
const PROJ_B = "55555555-5555-4555-8555-555555555555";

let currentUser: { id: string; role: string; tenantId: string | null } = {
  id: "u1", role: "user", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

let productRow: Record<string, unknown> | null = { id: PRODUCT, name: "Loja Verde", tenant_id: TENANT, is_inbox: false };
let specFileRows: Array<Record<string, unknown>> = [];
let realCount = 0; // total real devolvido pela query de count (só usada quando truncado)
const queryHandler = (sql: string) => {
  if (sql.includes("FROM products WHERE id")) return { rows: productRow ? [productRow] : [] };
  if (sql.includes("count(*)")) return { rows: [{ n: realCount }] };
  if (sql.includes("FROM project_spec_files")) return { rows: specFileRows };
  return { rows: [] };
};
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string) => queryHandler(sql),
    connect: async () => ({ query: async (sql: string) => queryHandler(sql), release: () => {} }),
  },
}));

let app: FastifyInstance;
beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  currentUser = { id: "u1", role: "user", tenantId: TENANT };
  productRow = { id: PRODUCT, name: "Loja Verde", tenant_id: TENANT, is_inbox: false };
  specFileRows = [];
  realCount = 0;
});

describe("GET /api/products/:id/spec-tree", () => {
  it("UUID inválido → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products/nao-uuid/spec-tree" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("INVALID_PRODUCT_ID");
  });

  it("produto de outro tenant (não-master) → 404", async () => {
    productRow = { id: PRODUCT, name: "Loja Verde", tenant_id: OTHER_TENANT, is_inbox: false };
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(404);
  });

  it("produto inexistente → 404", async () => {
    productRow = null;
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(404);
  });

  it("caminho feliz: agrupa por projeto, deriva editable e ext", async () => {
    specFileRows = [
      { project_id: PROJ_A, project_title: "API", project_status: "draft", filename: "01-api.md", rel_dir: "backend", is_primary: true, content_sha256: "sha-a1", created_at: new Date("2026-01-01T00:00:00Z") },
      { project_id: PROJ_A, project_title: "API", project_status: "draft", filename: "README.md", rel_dir: "", is_primary: false, content_sha256: "sha-a2", created_at: new Date("2026-01-01T00:00:00Z") },
      { project_id: PROJ_B, project_title: "Web", project_status: "running", filename: "spec.md", rel_dir: "", is_primary: true, content_sha256: "sha-b1", created_at: new Date("2026-01-02T00:00:00Z") },
    ];
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.productName).toBe("Loja Verde");
    expect(body.isInbox).toBe(false);
    expect(body.totalFiles).toBe(3);
    expect(body.loadedFiles).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.projects).toHaveLength(2);

    const a = body.projects.find((p: { projectId: string }) => p.projectId === PROJ_A);
    expect(a.title).toBe("API");
    expect(a.editable).toBe(true); // draft → editável
    expect(a.files).toHaveLength(2);
    expect(a.files.map((f: { path: string }) => f.path).sort()).toEqual(["README.md", "backend/01-api.md"]);
    const apiFile = a.files.find((f: { path: string }) => f.path === "backend/01-api.md");
    expect(apiFile.ext).toBe("md"); // sem ponto
    expect(apiFile.isPrimary).toBe(true);
    expect(apiFile.contentSha256).toBe("sha-a1");

    const b = body.projects.find((p: { projectId: string }) => p.projectId === PROJ_B);
    expect(b.editable).toBe(false); // running → bloqueado para edição
  });

  it("lista truncada → totalFiles é o total REAL (não o teto) e loadedFiles = teto", async () => {
    // 2001 linhas (> MAX_FILES=2000) forçam truncamento; a query de count devolve o total real.
    specFileRows = Array.from({ length: 2001 }, (_, i) => ({
      project_id: PROJ_A, project_title: "API", project_status: "draft",
      filename: `f${i}.md`, rel_dir: "", is_primary: i === 0, content_sha256: `sha-${i}`,
      created_at: new Date("2026-01-01T00:00:00Z"),
    }));
    realCount = 3500;
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
    expect(body.loadedFiles).toBe(2000); // teto carregado
    expect(body.totalFiles).toBe(3500); // total REAL via count — não "2000 de 2000"
  });

  it("produto sem specs → projects vazio", async () => {
    specFileRows = [];
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.projects).toEqual([]);
    expect(body.totalFiles).toBe(0);
  });

  it("master abre produto de qualquer tenant", async () => {
    currentUser = { id: "admin", role: "zentriz_admin", tenantId: null };
    productRow = { id: PRODUCT, name: "Loja Verde", tenant_id: OTHER_TENANT, is_inbox: false };
    const res = await app.inject({ method: "GET", url: `/api/products/${PRODUCT}/spec-tree` });
    expect(res.statusCode).toBe(200);
  });
});
