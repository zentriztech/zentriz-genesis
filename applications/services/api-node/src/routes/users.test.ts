/**
 * users.test.ts — §4.19 / §6.3 (migration 064): DELETE /api/users/:id não órfã produtos.
 *
 * products.created_by é NOT NULL e referencia users(id). Ao deletar um usuário que "possui"
 * produtos (inbox, solo, comuns), o endpoint REATRIBUI esses produtos a outro admin ativo do
 * mesmo tenant antes do DELETE. Só quando ele é o ÚLTIMO usuário dono de produtos retorna
 * 409 LAST_USER_OWNS_PRODUCTS (nunca deixa produto sem dono). Mudança de comportamento
 * registrada na matriz de riscos (antes o CASCADE apagava produtos de admins sem projetos).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const HEIR = "33333333-3333-4333-8333-333333333333";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "caller",
  role: "zentriz_admin",
  tenantId: null,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

// Fake pool: expõe pool.query (usado direto) E pool.connect (transação do DELETE).
const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
const run = async (sql: string, params: unknown[] = []) => {
  captured.push({ sql, params });
  return queryHandler(sql, params);
};
vi.mock("../db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => run(sql, params),
    connect: async () => ({
      query: (sql: string, params: unknown[] = []) => run(sql, params),
      release: () => {},
    }),
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { userRoutes } = await import("./users.js");
  app = Fastify();
  await app.register(userRoutes);
  await app.ready();
  captured.length = 0;
  queryHandler = () => ({ rows: [] });
  currentUser = { id: "caller", role: "zentriz_admin", tenantId: null };
});

describe("DELETE /api/users/:id — não órfã produtos (§4.19)", () => {
  it("dono de produtos com herdeiro → reatribui e deleta (204)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT id, tenant_id FROM users WHERE id")) return { rows: [{ id: TARGET, tenant_id: TENANT }] };
      if (sql.includes("FROM projects WHERE created_by")) return { rows: [] }; // sem projetos próprios
      if (sql.includes("SELECT 1 FROM products WHERE created_by")) return { rows: [{ "?column?": 1 }] }; // possui produtos
      if (sql.includes("WHERE tenant_id = $1 AND id <> $2 AND status = 'active'")) return { rows: [{ id: HEIR }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/users/${TARGET}` });
    expect(res.statusCode).toBe(204);
    const upd = captured.find((q) => q.sql.includes("UPDATE products SET created_by"));
    expect(upd).toBeDefined();
    expect(upd?.params[0]).toBe(HEIR); // novo dono
    expect(upd?.params[1]).toBe(TARGET); // dono antigo
    expect(captured.some((q) => q.sql.includes("DELETE FROM users WHERE id"))).toBe(true);
    expect(captured.some((q) => q.sql.trim() === "COMMIT")).toBe(true);
  });

  it("dono de produtos SEM herdeiro (último do tenant) → 409 LAST_USER_OWNS_PRODUCTS, sem deletar", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT id, tenant_id FROM users WHERE id")) return { rows: [{ id: TARGET, tenant_id: TENANT }] };
      if (sql.includes("FROM projects WHERE created_by")) return { rows: [] };
      if (sql.includes("SELECT 1 FROM products WHERE created_by")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("WHERE tenant_id = $1 AND id <> $2 AND status = 'active'")) return { rows: [] }; // sem herdeiro
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/users/${TARGET}` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LAST_USER_OWNS_PRODUCTS");
    expect(captured.some((q) => q.sql.includes("UPDATE products SET created_by"))).toBe(false);
    expect(captured.some((q) => q.sql.includes("DELETE FROM users WHERE id"))).toBe(false);
    expect(captured.some((q) => q.sql.trim() === "ROLLBACK")).toBe(true);
  });

  it("sem produtos → deleta direto (204), sem reatribuição", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT id, tenant_id FROM users WHERE id")) return { rows: [{ id: TARGET, tenant_id: TENANT }] };
      if (sql.includes("FROM projects WHERE created_by")) return { rows: [] };
      if (sql.includes("SELECT 1 FROM products WHERE created_by")) return { rows: [] }; // não possui produtos
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/users/${TARGET}` });
    expect(res.statusCode).toBe(204);
    expect(captured.some((q) => q.sql.includes("UPDATE products SET created_by"))).toBe(false);
    expect(captured.some((q) => q.sql.includes("DELETE FROM users WHERE id"))).toBe(true);
  });

  it("deletar o próprio usuário → 409 CONFLICT (guarda anterior preservada)", async () => {
    currentUser = { id: TARGET, role: "zentriz_admin", tenantId: null };
    const res = await app.inject({ method: "DELETE", url: `/api/users/${TARGET}` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("CONFLICT");
    expect(captured).toHaveLength(0);
  });
});
