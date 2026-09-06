/**
 * products.test.ts — B3 (RFC-0003): escopo por tenant do master em /api/products.
 *
 * Regressão coberta: a conta de gestão (zentriz_admin, tenantId=null) recebia sempre []
 * em GET /api/products e 404 em GET/PATCH /api/products/:id porque as queries fixavam
 * tenant_id = user.tenantId (null → ''). O fix honra ?tenantId no LIST (espelhando
 * /api/projects e /api/specs) e autoriza o :id por papel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
// O fake só tinha `connect`: uma rota que use `pool.query` direto (como o promote, que não pode
// segurar um client do pool durante a chamada de LLM do planejador) batia em 500 no teste enquanto
// funcionava em produção — o `pg.Pool` real tem os dois. O fake agora espelha isso.
const fakeQuery = async (sql: string, params: unknown[] = []) => {
  captured.push({ sql, params });
  return queryHandler(sql, params);
};
vi.mock("../db/client.js", () => ({
  pool: {
    query: fakeQuery,
    connect: async () => ({ query: fakeQuery, release: () => {} }),
  },
}));

// B2 (promote): o disparo de raízes é isolado por mock — validamos a ORQUESTRAÇÃO.
const dispatchSpy = vi.fn(async (_pool: unknown, projectId: string) => ({ dispatched: true, reason: "", projectId }));
vi.mock("../services/runnerDispatch.js", () => ({
  dispatchProjectRun: (poolArg: unknown, projectId: string) => dispatchSpy(poolArg, projectId),
}));
const flushImmediate = () => new Promise((r) => setImmediate(r));

// Promoção do PRODUTO TODO (migração 097): a ORDEM é decisão de agente (chamada de LLM) — aqui o
// planejador é isolado por mock e validamos a ORQUESTRAÇÃO (o que é escrito, o que NÃO é disparado).
class FakePlanError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
interface FakePlanItem {
  projectId: string; title: string; position: number; wave: number; layer: string;
  dependsOn: string[]; rationale: string;
}
let plannerResult: (() => Promise<{
  items: FakePlanItem[]; notes: string; warnings: string[];
  edgesSource: "triggers" | "agent"; modelUsed: string; inputTokens: number; outputTokens: number;
}>) | null = null;
const plannerSpy = vi.fn(async () => {
  if (!plannerResult) throw new FakePlanError("NO_PROMOTABLE_PROJECTS", "sem projetos");
  return plannerResult();
});
vi.mock("../services/promotionPlanner.js", () => ({
  PromotionPlanError: FakePlanError,
  buildPromotionPlan: (...args: unknown[]) => plannerSpy(...(args as [])),
  debitPromotionPlannerUsage: async () => {},
}));
vi.mock("../services/productLifecycle.js", () => ({
  recomputeProductLifecycle: async () => ({ changed: false }),
}));

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

describe("POST /api/products/:id/promote — o PRODUTO TODO, na ORDEM, SEM iniciar (migração 097)", () => {
  const R1 = "44444444-4444-4444-8444-444444444444";
  const R2 = "55555555-5555-4555-8555-555555555555";

  // Plano de 2 ondas: R1 (banco, onda 1) → R2 (backend, onda 2, depende de R1).
  const twoWavePlan = () => ({
    items: [
      { projectId: R1, title: "DB", position: 1, wave: 1, layer: "banco", dependsOn: [], rationale: "sem predecessor" },
      { projectId: R2, title: "API", position: 1, wave: 2, layer: "backend", dependsOn: [R1], rationale: "consome o banco" },
    ] as FakePlanItem[],
    notes: "ordem por interdependência",
    warnings: [] as string[],
    edgesSource: "triggers" as const,
    modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    inputTokens: 1200,
    outputTokens: 300,
  });

  // Roteia as queries do promote: SELECT produto, UPDATE lifecycle, UPDATE dos projetos.
  function promoteHandler(opts: {
    tenant?: string | null; lifecycle?: string; updRowCount?: number; promotedIds?: string[];
    pendingWave?: Array<{ project_id: string; wave: number }>;
  }) {
    const {
      tenant = TENANT, lifecycle = "draft", updRowCount = 1, promotedIds = [R1, R2],
      pendingWave = [{ project_id: R1, wave: 1 }, { project_id: R2, wave: 2 }],
    } = opts;
    return (sql: string) => {
      if (sql.includes("lifecycle_status, is_inbox FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: tenant, name: "Produto X", lifecycle_status: lifecycle, is_inbox: false }] };
      }
      if (sql.includes("UPDATE products SET lifecycle_status = 'promoted'")) {
        return { rows: [], rowCount: updRowCount } as { rows: unknown[]; rowCount: number };
      }
      if (sql.includes("UPDATE projects SET status = 'promoted'")) {
        return { rows: promotedIds.map((id) => ({ id })) };
      }
      if (sql.includes("FROM product_promotion_items i JOIN projects p")) return { rows: pendingWave };
      return { rows: [] };
    };
  }

  beforeEach(() => { plannerResult = async () => twoWavePlan(); plannerSpy.mockClear(); });

  it("promove TODOS os projetos do plano e NÃO inicia nenhum (requisito do Jean)", async () => {
    queryHandler = promoteHandler({ tenant: OTHER_TENANT });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.lifecycleStatus).toBe("promoted");   // nunca "running": nada começou
    expect(body.started).toBe(false);
    expect(body.promoted).toEqual([R1, R2]);         // o produto TODO, não só as raízes
    expect(body.waves).toBe(2);
    expect(body.plan.map((i: FakePlanItem) => i.projectId)).toEqual([R1, R2]);
    await flushImmediate();
    expect(dispatchSpy).not.toHaveBeenCalled();      // ← "promovidos mas não iniciados"
    // O plano fica gravado (auditoria da ordem) e cada item também.
    expect(captured.some((q) => q.sql.includes("INSERT INTO product_promotions"))).toBe(true);
    expect(captured.filter((q) => q.sql.includes("INSERT INTO product_promotion_items"))).toHaveLength(2);
    expect(captured.some((q) => q.sql === "COMMIT")).toBe(true);
    // NUNCA re-decompõe (G1): sem criação de produto.
    expect(captured.some((q) => q.sql.includes("INSERT INTO products"))).toBe(false);
  });

  it("com {start:true} dispara SOMENTE a onda 1 (barreira entre ondas)", async () => {
    queryHandler = promoteHandler({});
    const res = await app.inject({
      method: "POST", url: `/api/products/${PROD_ID}/promote`, payload: { start: true },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).started).toBe(true);
    await flushImmediate();
    await flushImmediate();
    expect(dispatchSpy.mock.calls.map((c) => c[1])).toEqual([R1]); // R2 é da onda 2
  });

  it("planejador recusa (ciclo/id inválido/sem spec) → 422 e NADA muda de estado", async () => {
    queryHandler = promoteHandler({});
    plannerResult = null; // planejador lança PromotionPlanError
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe("NO_PROMOTABLE_PROJECTS");
    await flushImmediate();
    expect(captured.some((q) => /UPDATE products SET lifecycle_status|UPDATE projects SET status/.test(q.sql))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("produto fora da Bancada (running) → 409 NOT_ON_WORKBENCH, sem chamar o planejador", async () => {
    queryHandler = promoteHandler({ lifecycle: "running" });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NOT_ON_WORKBENCH");
    await flushImmediate();
    expect(plannerSpy).not.toHaveBeenCalled(); // não gasta LLM em produto fora da Bancada
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("dupla promoção concorrente (UPDATE rowCount 0) → 409 ALREADY_PROMOTED com ROLLBACK", async () => {
    queryHandler = promoteHandler({ updRowCount: 0 });
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("ALREADY_PROMOTED");
    expect(captured.some((q) => q.sql === "ROLLBACK")).toBe(true);
    expect(captured.some((q) => q.sql.includes("INSERT INTO product_promotions"))).toBe(false);
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

describe("POST /api/products/:id/start e /unpromote — início EXPLÍCITO e volta à Bancada", () => {
  const R1 = "44444444-4444-4444-8444-444444444444";
  const R2 = "55555555-5555-4555-8555-555555555555";
  const PROMO_ID = "99999999-9999-4999-8999-999999999999";

  it("/start sem plano vivo → 409 NOT_PROMOTED (não dispara nada)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("lifecycle_status, is_inbox FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: TENANT, lifecycle_status: "draft", is_inbox: false }] };
      }
      return { rows: [] }; // nenhuma promoção viva
    };
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/start` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NOT_PROMOTED");
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("/start dispara só a onda mais baixa ainda promovida e marca o plano como iniciado", async () => {
    queryHandler = (sql) => {
      if (sql.includes("lifecycle_status, is_inbox FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: TENANT, lifecycle_status: "promoted", is_inbox: false }] };
      }
      if (sql.includes("FROM product_promotions WHERE product_id")) return { rows: [{ id: PROMO_ID }] };
      if (sql.includes("FROM product_promotion_items i JOIN projects p")) {
        return { rows: [{ project_id: R1, wave: 1 }, { project_id: R2, wave: 2 }] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/start` });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.wave).toBe(1);
    expect(body.started).toEqual([R1]);
    expect(dispatchSpy.mock.calls.map((c) => c[1])).toEqual([R1]);
    expect(captured.some((q) => q.sql.includes("SET status = 'started'"))).toBe(true);
  });

  it("/unpromote com a fábrica já em andamento → 409 ALREADY_STARTED (nada volta a rascunho)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("lifecycle_status FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: TENANT, lifecycle_status: "promoted" }] };
      }
      if (sql.includes("COUNT(*) AS n FROM projects WHERE product_id")) {
        return { rows: [{ status: "promoted", n: "1" }, { status: "cto_charter", n: "1" }] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/unpromote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("ALREADY_STARTED");
    expect(captured.some((q) => q.sql.includes("SET status = 'draft'"))).toBe(false);
    expect(captured.some((q) => q.sql === "ROLLBACK")).toBe(true);
  });

  it("/unpromote com todos ainda promovidos → devolve produto e projetos à Bancada", async () => {
    queryHandler = (sql) => {
      if (sql.includes("lifecycle_status FROM products WHERE id")) {
        return { rows: [{ id: PROD_ID, tenant_id: TENANT, lifecycle_status: "promoted" }] };
      }
      if (sql.includes("COUNT(*) AS n FROM projects WHERE product_id")) {
        return { rows: [{ status: "promoted", n: "2" }] };
      }
      if (sql.includes("SET status = 'draft'")) return { rows: [{ id: R1 }, { id: R2 }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/unpromote` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.lifecycleStatus).toBe("draft");
    expect(body.returned).toEqual([R1, R2]);
    expect(captured.some((q) => q.sql.includes("SET status = 'canceled'"))).toBe(true);
    expect(captured.some((q) => q.sql === "COMMIT")).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — proteções do modelo "todo App vive num Produto" (migration 064).
// Códigos: INBOX_PROTECTED (§4.10), INBOX_NOT_PROMOTABLE (§4.12),
// RESERVED_PRODUCT_NAME (§4.14), APP_RUNNING_CANNOT_INBOX (§4.9).
// ─────────────────────────────────────────────────────────────────────────────
describe("INBOX/solo — proteções estruturais (migration 064)", () => {
  const PROJ_ID = "66666666-6666-4666-8666-666666666666";
  const SOLO_ID = "77777777-7777-4777-8777-777777777777";
  const INBOX_ID = "88888888-8888-4888-8888-888888888888";

  it("§4.10: DELETE do INBOX → 409 INBOX_PROTECTED (nem hard nem soft)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT id, name, tenant_id, status, is_inbox FROM products"))
        return { rows: [{ id: PROD_ID, name: "Rascunhos", tenant_id: OTHER_TENANT, status: "active", is_inbox: true }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}`, payload: { confirmId: PROD_ID } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INBOX_PROTECTED");
    // Nunca escreve (não apaga nem arquiva).
    expect(captured.some((q) => /DELETE FROM products|SET status = 'archived'/.test(q.sql))).toBe(false);
  });

  it("§4.10: PATCH do INBOX mudando nome → 409 INBOX_PROTECTED", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, is_inbox FROM products WHERE id"))
        return { rows: [{ tenant_id: OTHER_TENANT, is_inbox: true }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "PATCH", url: `/api/products/${PROD_ID}`, payload: { name: "Outro nome" } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INBOX_PROTECTED");
    expect(captured.some((q) => q.sql.includes("UPDATE products"))).toBe(false);
  });

  it("§4.10: PATCH do INBOX mudando só a descrição → permitido", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, is_inbox FROM products WHERE id"))
        return { rows: [{ tenant_id: OTHER_TENANT, is_inbox: true }] };
      if (sql.includes("UPDATE products")) return { rows: [{ id: PROD_ID }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "PATCH", url: `/api/products/${PROD_ID}`, payload: { description: "nova desc" } });
    expect(res.statusCode).toBe(200);
  });

  it("§4.14: POST criar produto chamado 'Rascunhos' → 409 RESERVED_PRODUCT_NAME (sem tocar o banco)", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    const res = await app.inject({ method: "POST", url: "/api/products", payload: { name: "Rascunhos" } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("RESERVED_PRODUCT_NAME");
    expect(captured).toHaveLength(0);
  });

  it("§4.14: PATCH renomear produto comum para 'Rascunhos' → 409 RESERVED_PRODUCT_NAME", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, is_inbox FROM products WHERE id"))
        return { rows: [{ tenant_id: OTHER_TENANT, is_inbox: false }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "PATCH", url: `/api/products/${PROD_ID}`, payload: { name: "Rascunhos" } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("RESERVED_PRODUCT_NAME");
    expect(captured.some((q) => q.sql.includes("UPDATE products"))).toBe(false);
  });

  it("§4.12: promover o INBOX em bloco → 409 INBOX_NOT_PROMOTABLE, não dispara", async () => {
    queryHandler = (sql) => {
      if (sql.includes("lifecycle_status, is_inbox FROM products WHERE id"))
        return { rows: [{ id: PROD_ID, tenant_id: OTHER_TENANT, lifecycle_status: "draft", is_inbox: true }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: `/api/products/${PROD_ID}/promote` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INBOX_NOT_PROMOTABLE");
    await flushImmediate();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("§4.9: 'tirar do produto' App em fábrica (running) → 409 APP_RUNNING_CANNOT_INBOX", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, created_by, status, product_id FROM projects WHERE id"))
        return { rows: [{ tenant_id: OTHER_TENANT, created_by: "u9", status: "running", product_id: SOLO_ID }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}/projects/${PROJ_ID}` });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("APP_RUNNING_CANNOT_INBOX");
    // Não moveu nada.
    expect(captured.some((q) => q.sql.includes("UPDATE projects SET product_id"))).toBe(false);
  });

  it("§4.9: 'tirar do produto' App rascunho (draft) → move ao INBOX (200)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("SELECT tenant_id, created_by, status, product_id FROM projects WHERE id"))
        return { rows: [{ tenant_id: OTHER_TENANT, created_by: "u9", status: "draft", product_id: SOLO_ID }] };
      // resolveInboxProductId: find-or-create idempotente do INBOX.
      if (sql.includes("INSERT INTO products") && sql.includes("is_inbox"))
        return { rows: [{ id: INBOX_ID }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "DELETE", url: `/api/products/${PROD_ID}/projects/${PROJ_ID}` });
    expect(res.statusCode).toBe(200);
    const moved = captured.find((q) => q.sql.includes("UPDATE projects SET product_id"));
    expect(moved?.params[0]).toBe(INBOX_ID);
    expect(moved?.params[1]).toBe(PROJ_ID);
  });
});

describe("GET /api/products — Certificado Genesis Factory agregado (A6)", () => {
  const PROD_B = "44444444-4444-4444-8444-444444444444";
  const SPEC_1 = "55555555-5555-4555-8555-555555555555";
  const SPEC_2 = "66666666-6666-4666-8666-666666666666";

  /** Lista 2 produtos; o primeiro tem 2 specs na Bancada, o segundo nenhuma. */
  function listing() {
    queryHandler = (sql) => {
      if (sql.includes("FROM products")) return { rows: [{ id: PROD_ID, name: "Venuxx V2" }, { id: PROD_B, name: "Vazio" }] };
      if (sql.includes("SELECT id, product_id FROM projects")) {
        return { rows: [{ id: SPEC_1, product_id: PROD_ID }, { id: SPEC_2, product_id: PROD_ID }] };
      }
      return { rows: [] };
    };
  }

  afterEach(() => { delete process.env.FACTORY_CERTIFICATE; });

  it("flag OFF (default): payload byte-idêntico — nem o selo nem a query de specs aparecem", async () => {
    listing();
    const res = await app.inject({ method: "GET", url: "/api/products" });
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body[0]).not.toHaveProperty("factoryCertificate");
    expect(captured.some((q) => q.sql.includes("SELECT id, product_id FROM projects"))).toBe(false);
  });

  it("flag ON: agrega por produto (AND com n/m) e só olha projetos da BANCADA", async () => {
    process.env.FACTORY_CERTIFICATE = "on";
    listing();
    // O serviço roda de verdade contra o pool fake (sem arquivos de spec no duplo).
    const res = await app.inject({ method: "GET", url: "/api/products" });
    const body = res.json() as Array<{ id: string; factoryCertificate: Record<string, unknown> }>;
    const venuxx = body.find((p) => p.id === PROD_ID)!;
    const vazio = body.find((p) => p.id === PROD_B)!;
    // Sem arquivos de spec no duplo, os 2 projetos reprovam C1 → produto `blocked`, 0/2.
    expect(venuxx.factoryCertificate).toMatchObject({ level: "blocked", certified: 0, total: 2, blocked: 2 });
    expect(venuxx.factoryCertificate.message).toContain("0/2 projetos certificados");
    // Produto sem projeto na Bancada não é "reprovado": é `unknown` com total 0 (a UI esconde).
    expect(vazio.factoryCertificate).toMatchObject({ level: "unknown", total: 0 });
    // O status filtrado é o da Bancada (pré-fábrica), não qualquer projeto do produto.
    const specQuery = captured.find((q) => q.sql.includes("SELECT id, product_id FROM projects"));
    expect(specQuery?.params[1]).toEqual(["draft", "spec_submitted", "pending_conversion"]);
  });
});
