/**
 * products.test.ts — B3 (RFC-0003): escopo por tenant do master em /api/products.
 *
 * Regressão coberta: a conta de gestão (zentriz_admin, tenantId=null) recebia sempre []
 * em GET /api/products e 404 em GET/PATCH /api/products/:id porque as queries fixavam
 * tenant_id = user.tenantId (null → ''). O fix honra ?tenantId no LIST (espelhando
 * /api/projects e /api/specs) e autoriza o :id por papel.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PROD_ID = "33333333-3333-4333-8333-333333333333";

// Papel/tenant do usuário corrente, controláveis por teste.
let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1",
  role: "zentriz_admin",
  tenantId: null,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

// Fake pool: captura (sql, params) e devolve linhas conforme o handler configurável.
const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        return queryHandler(sql, params);
      },
      release: () => {},
    }),
  },
}));

// B2 (promote): o disparo de raízes é isolado por mock — validamos a ORQUESTRAÇÃO.
const dispatchSpy = vi.fn(async (_pool: unknown, projectId: string) => ({ dispatched: true, reason: "", projectId }));
vi.mock("../services/runnerDispatch.js", () => ({
  dispatchProjectRun: (poolArg: unknown, projectId: string) => dispatchSpy(poolArg, projectId),
}));
const flushImmediate = () => new Promise((r) => setImmediate(r));

let app: FastifyInstance;

beforeEach(async () => {
  const { productRoutes } = await import("./products.js");
  app = Fastify();
  await app.register(productRoutes);
  await app.ready();
  captured.length = 0;
  queryHandler = () => ({ rows: [] });
  currentUser = { id: "u1", role: "zentriz_admin", tenantId: null };
  dispatchSpy.mockClear();
});

describe("GET /api/products — escopo por tenant (B3)", () => {
  it("master COM ?tenantId válido escopa a listagem a esse tenant", async () => {
    queryHandler = () => ({ rows: [{ id: PROD_ID, name: "P", project_count: 2 }] });
    const res = await app.inject({ method: "GET", url: `/api/products?tenantId=${TENANT}` });
    expect(res.statusCode).toBe(200);
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    expect(listQuery?.sql).toContain("$1::uuid IS NULL OR p.tenant_id = $1");
    expect(listQuery?.params[0]).toBe(TENANT);
  });

  it("master SEM tenant vê todos os tenants (param null)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.statusCode).toBe(200);
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    expect(listQuery?.params[0]).toBeNull();
  });

  it("master com ?tenantId inválido (não-UUID) ignora o filtro (param null, sem 500)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products?tenantId=not-a-uuid" });
    expect(res.statusCode).toBe(200);
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    expect(listQuery?.params[0]).toBeNull();
  });

  it("não-master sem tenant → [] sem tocar o banco", async () => {
    currentUser = { id: "u2", role: "user", tenantId: null };
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("não-master com tenant usa branch fixo no próprio tenant", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    await app.inject({ method: "GET", url: `/api/products?tenantId=${OTHER_TENANT}` });
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    // Ignora ?tenantId de outrem — escopa no próprio tenant.
    expect(listQuery?.params[0]).toBe(TENANT);
    expect(listQuery?.sql).toContain("WHERE p.tenant_id = $1");
  });

  it("§4.15: sem ?includeInbox o INBOX é ocultado (param false) e solo vazio some (HAVING)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.statusCode).toBe(200);
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    expect(listQuery?.sql).toContain("p.is_inbox = false OR $2::boolean = true");
    expect(listQuery?.sql).toContain("HAVING (p.solo_app = false OR COUNT(proj.id) > 0)");
    expect(listQuery?.params[1]).toBe(false);
  });

  it("§4.15: ?includeInbox=1 passa true → INBOX entra na listagem (Bancada/select de spec)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products?includeInbox=1" });
    expect(res.statusCode).toBe(200);
    const listQuery = captured.find((q) => q.sql.includes("FROM products"));
    expect(listQuery?.params[1]).toBe(true);
  });
});

describe("GET /api/products/:id — autorização por papel (B3)", () => {
  it("id não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products/abc" });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("master abre produto de qualquer tenant", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT * FROM products WHERE id")) return { rows: [{ id: PROD_ID, tenant_id: OTHER_TENANT }] };
      return { rows: [] }; // query de projetos
    };
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    expect(res.statusCode).toBe(200);
  });

  it("não-master não abre produto de outro tenant → 404", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    queryHandler = (sql) => {
      if (sql.includes("SELECT * FROM products WHERE id")) return { rows: [{ id: PROD_ID, tenant_id: OTHER_TENANT }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it("produto inexistente → 404", async () => {
    queryHandler = () => ({ rows: [] });
    const res = await app.inject({ method: "GET", url: `/api/products/${PROD_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/products/:id — autorização por papel (B3)", () => {
  it("não-master de outro tenant → 403", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, is_inbox FROM products WHERE id")) return { rows: [{ tenant_id: OTHER_TENANT, is_inbox: false }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "PATCH", url: `/api/products/${PROD_ID}`, payload: { name: "novo" } });
    expect(res.statusCode).toBe(403);
  });

  it("master edita produto de qualquer tenant", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, is_inbox FROM products WHERE id")) return { rows: [{ tenant_id: OTHER_TENANT, is_inbox: false }] };
      if (sql.startsWith("UPDATE products") || sql.includes("UPDATE products SET")) return { rows: [{ id: PROD_ID, name: "novo" }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "PATCH", url: `/api/products/${PROD_ID}`, payload: { name: "novo" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/products/:id/promote — B2 (promover da Bancada)", () => {
  const R1 = "44444444-4444-4444-8444-444444444444";
  const R2 = "55555555-5555-4555-8555-555555555555";

  // Roteia as 3 queries do promote: SELECT produto, SELECT raízes, UPDATE lifecycle.
  function promoteHandler(opts: { tenant?: string | null; lifecycle?: string; roots?: string[]; updRowCount?: number }) {
    const { tenant = TENANT, lifecycle = "draft", roots = [R1, R2], updRowCount = 1 } = opts;
    return (sql: string) => {
      if (sql.includes("lifecycle_status, is_inbox FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: tenant, lifecycle_status: lifecycle, is_inbox: false }] };
      }
      if (sql.includes("p.status = 'draft'")) return { rows: roots.map((id) => ({ id })) };
      if (sql.includes("UPDATE products SET lifecycle_status = 'running'")) return { rows: [], rowCount: updRowCount } as { rows: unknown[]; rowCount: number };
      return { rows: [] };
    };
  }

  it("master promove produto draft → 202, dispara as raízes (dispatch-only)", async () => {
    queryHandler = promoteHandler({ tenant: OTHER_TENANT });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.lifecycleStatus).toBe("running");
    expect(body.promoted).toEqual([R1, R2]);
    await flushImmediate();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy.mock.calls.map((c) => c[1])).toEqual([R1, R2]);
    // NUNCA re-decompõe (G1): sem chamada a decomposeProduct.
    expect(captured.some((q) => q.sql.includes("INSERT INTO products"))).toBe(false);
  });

  it("produto fora da Bancada (running) → 409 NOT_ON_WORKBENCH, não dispara", async () => {
    queryHandler = promoteHandler({ lifecycle: "running" });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NOT_ON_WORKBENCH");
    await flushImmediate();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("sem raízes em rascunho → 409 NO_PROMOTABLE_ROOTS", async () => {
    queryHandler = promoteHandler({ roots: [] });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NO_PROMOTABLE_ROOTS");
  });

  it("dupla promoção concorrente (UPDATE rowCount 0) → 409 ALREADY_PROMOTED", async () => {
    queryHandler = promoteHandler({ updRowCount: 0 });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("ALREADY_PROMOTED");
    await flushImmediate();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("id não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products/abc/promote" });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("não-master não promove produto de outro tenant → 404", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    queryHandler = promoteHandler({ tenant: OTHER_TENANT });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(404);
  });

  it("produto inexistente → 404", async () => {
    queryHandler = () => ({ rows: [] });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(404);
  });
});

describe("link produto↔projeto — validação de id (B3)", () => {
  it("POST com productId não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "POST", url: `/api/products/abc/projects/${PROD_ID}` });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("DELETE com projectId não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}/projects/xyz` });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });
});

describe("DELETE /api/products/:id — hard delete (sem projetos) vs soft archive (com projetos)", () => {
  const deleteHandler =
    (opts: { tenant?: string | null; status?: string; projectCount: number; running?: string[] }) =>
    (sql: string) => {
      if (sql.includes("SELECT id, name, tenant_id, status, is_inbox FROM products"))
        return { rows: [{ id: PROD_ID, name: "P", tenant_id: opts.tenant ?? null, status: opts.status ?? "active", is_inbox: false }] };
      if (sql.includes("status = 'running'"))
        return { rows: (opts.running ?? []).map((t, i) => ({ id: `r${i}`, title: t })) };
      if (sql.includes("COUNT(*) AS n FROM projects"))
        return { rows: [{ n: String(opts.projectCount) }] };
      return { rows: [] }; // DELETE / UPDATE
    };
  const touchedWrite = () =>
    captured.some((q) => /DELETE FROM products|SET status = 'archived'/.test(q.sql));

  it("id não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/products/abc", payload: { confirmId: "abc" } });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("confirmId errado → 400 CONFIRM_MISMATCH sem apagar nem arquivar", async () => {
    queryHandler = deleteHandler({ projectCount: 0 });
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("CONFIRM_MISMATCH");
    expect(touchedWrite()).toBe(false);
  });

  it("sem projetos + confirmId correto → HARD DELETE real", async () => {
    queryHandler = deleteHandler({ projectCount: 0 });
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe("deleted");
    expect(captured.some((q) => q.sql.includes("DELETE FROM products WHERE id"))).toBe(true);
  });

  it("com projetos SEM acknowledge → 400 ACK_REQUIRED (não arquiva)", async () => {
    queryHandler = deleteHandler({ projectCount: 3 });
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("ACK_REQUIRED");
    expect(touchedWrite()).toBe(false);
  });

  it("com projetos + acknowledge → SOFT archive (nunca apaga)", async () => {
    queryHandler = deleteHandler({ projectCount: 3 });
    const res = await app.inject({
      method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID, acknowledge: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe("archived");
    expect(captured.some((q) => q.sql.includes("SET status = 'archived'"))).toBe(true);
    expect(captured.some((q) => q.sql.includes("DELETE FROM products"))).toBe(false);
  });

  it("filho em execução → 409 sem apagar/arquivar", async () => {
    queryHandler = deleteHandler({ projectCount: 3, running: ["Proj A"] });
    const res = await app.inject({
      method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID, acknowledge: true },
    });
    expect(res.statusCode).toBe(409);
    expect(touchedWrite()).toBe(false);
  });

  it("não-master de outro tenant → 403", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    queryHandler = deleteHandler({ tenant: OTHER_TENANT, projectCount: 0 });
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID } });
    expect(res.statusCode).toBe(403);
  });
});
