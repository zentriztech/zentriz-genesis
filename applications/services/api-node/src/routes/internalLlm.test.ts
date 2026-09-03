/**
 * internalLlm.test.ts — T1 (backlog pós-auditoria): escopo por projeto do endpoint
 * interno GET /api/internal/project-llm-config/:projectId.
 *
 * Foco: um token de máquina (svc:"runner") carrega o claim `projectId` e só pode ler a
 * config/api_key do PRÓPRIO projeto (403 cross-project). O token estático segue amplo
 * (server-to-server), a guarda IDOR do tenant_admin continua, e prod é fail-closed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { signToken, verifyToken } from "../auth.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATIC_TOKEN = "static-internal-secret";

// pool.query serve dois caminhos: (a) IDOR do tenant_admin no llm-config
// (SELECT tenant_id FROM projects) e (b) o endpoint cyborg-token (JOIN com users).
let projectOwnerTenant: string | null = TENANT;
// Linha controlável do cyborg-token; null ⇒ projeto inexistente (404).
let cyborgProjectRow: Record<string, unknown> | null = {
  tenant_id: TENANT, created_by: "owner-1", owner_email: "owner@x", owner_role: "user",
};
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, _params: unknown[]) => {
      if (/created_by, u\.email/.test(sql)) {
        return { rows: cyborgProjectRow ? [cyborgProjectRow] : [] };
      }
      return { rows: [{ tenant_id: projectOwnerTenant }] };
    },
  },
}));

// Resolver de config LLM: devolve uma api_key marcada pelo projeto pedido (prova de vazamento).
vi.mock("../services/tenantLlmConfig.js", () => ({
  resolveProjectLlmConfig: async (projectId: string) => ({
    provider: "openai",
    modelId: "gpt-4o",
    apiKey: `KEY-FOR-${projectId}`,
  }),
}));

let app: FastifyInstance;
const OLD_ENV = { NODE_ENV: process.env.NODE_ENV, TOKEN: process.env.GENESIS_API_TOKEN };

beforeAll(async () => {
  process.env.NODE_ENV = "production"; // exercita o fail-closed real de prod
  process.env.GENESIS_API_TOKEN = STATIC_TOKEN;
  const { internalLlmRoutes } = await import("./internalLlm.js");
  app = Fastify();
  await app.register(internalLlmRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  process.env.NODE_ENV = OLD_ENV.NODE_ENV;
  if (OLD_ENV.TOKEN === undefined) delete process.env.GENESIS_API_TOKEN;
  else process.env.GENESIS_API_TOKEN = OLD_ENV.TOKEN;
});

beforeEach(() => {
  projectOwnerTenant = TENANT;
  cyborgProjectRow = { tenant_id: TENANT, created_by: "owner-1", owner_email: "owner@x", owner_role: "user" };
});

function get(projectId: string, token: string, header: "x-internal-token" | "authorization" = "x-internal-token") {
  const headers = header === "x-internal-token"
    ? { "x-internal-token": token }
    : { authorization: `Bearer ${token}` };
  return app.inject({ method: "GET", url: `/api/internal/project-llm-config/${projectId}`, headers });
}

describe("GET /api/internal/project-llm-config/:projectId — binding por projeto (T1)", () => {
  it("token de run (svc:runner) escopado ao MESMO projeto → 200 com api_key do projeto", async () => {
    const token = signToken({ sub: "u1", email: "u@x", role: "user", tenantId: TENANT, svc: "runner", projectId: PROJECT }, "1h");
    const res = await get(PROJECT, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, apiKey: `KEY-FOR-${PROJECT}` });
  });

  it("token de run escopado a OUTRO projeto → 403 (não lê chave cross-project)", async () => {
    const token = signToken({ sub: "u1", email: "u@x", role: "user", tenantId: TENANT, svc: "runner", projectId: OTHER_PROJECT }, "1h");
    const res = await get(PROJECT, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("token estático (server-to-server, sem escopo) → 200 amplo (retrocompatível)", async () => {
    const res = await get(OTHER_PROJECT, STATIC_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, apiKey: `KEY-FOR-${OTHER_PROJECT}` });
  });

  it("tenant_admin do PRÓPRIO tenant → 200 (guarda IDOR preservada)", async () => {
    projectOwnerTenant = TENANT;
    const token = signToken({ sub: "a1", email: "a@x", role: "tenant_admin", tenantId: TENANT }, "1h");
    const res = await get(PROJECT, token, "authorization");
    expect(res.statusCode).toBe(200);
  });

  it("tenant_admin de OUTRO tenant → 403 (guarda IDOR)", async () => {
    projectOwnerTenant = OTHER_TENANT;
    const token = signToken({ sub: "a1", email: "a@x", role: "tenant_admin", tenantId: TENANT }, "1h");
    const res = await get(PROJECT, token, "authorization");
    expect(res.statusCode).toBe(403);
  });

  it("sem token → 401 fail-closed em produção", async () => {
    const res = await app.inject({ method: "GET", url: `/api/internal/project-llm-config/${PROJECT}` });
    expect(res.statusCode).toBe(401);
  });

  it("token de run escopado usado em rota do próprio projeto via Authorization header → 200", async () => {
    const token = signToken({ sub: "u1", email: "u@x", role: "user", tenantId: TENANT, svc: "runner", projectId: PROJECT }, "1h");
    const res = await get(PROJECT, token, "authorization");
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/internal/cyborg-token — Lei 8 (token de projeto p/ o sandbox do FTS)", () => {
  function mint(body: Record<string, unknown>, token = STATIC_TOKEN) {
    return app.inject({
      method: "POST", url: "/api/internal/cyborg-token",
      headers: { "x-internal-token": token, "content-type": "application/json" },
      payload: body,
    });
  }

  it("token admin estático → cunha token svc:runner ESCOPADO por projeto (sub=created_by, tenant do projeto)", async () => {
    const res = await mint({ projectId: PROJECT });
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    const decoded = verifyToken(token)!;
    expect(decoded.svc).toBe("runner");
    expect(decoded.projectId).toBe(PROJECT);
    expect(decoded.tenantId).toBe(TENANT);
    expect(decoded.sub).toBe("owner-1");   // sub = created_by → cobre projeto "solto"
    expect(decoded.role).toBe("user");
  });

  it("dono zentriz_admin → REBAIXA role para tenant_admin (nunca entrega poder global ao executor)", async () => {
    cyborgProjectRow = { tenant_id: TENANT, created_by: "adm", owner_email: "a@x", owner_role: "zentriz_admin" };
    const res = await mint({ projectId: PROJECT });
    expect(res.statusCode).toBe(200);
    const decoded = verifyToken((res.json() as { token: string }).token)!;
    expect(decoded.role).toBe("tenant_admin");
    expect(decoded.role).not.toBe("zentriz_admin");
  });

  it("projeto inexistente → 404", async () => {
    cyborgProjectRow = null;
    const res = await mint({ projectId: PROJECT });
    expect(res.statusCode).toBe(404);
  });

  it("projectId ausente → 400", async () => {
    const res = await mint({});
    expect(res.statusCode).toBe(400);
  });

  it("sem token → 401 fail-closed em produção", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/internal/cyborg-token",
      headers: { "content-type": "application/json" }, payload: { projectId: PROJECT },
    });
    expect(res.statusCode).toBe(401);
  });

  it("P0 (rota B): caller svc:runner NÃO cunha token de projeto → 403 (anti-escalada cross-tenant)", async () => {
    // Um token de run (o que o executor não-confiável tem) tenta cunhar token p/ OUTRO
    // projeto. Se pudesse, viraria tenant_admin de outro tenant + renovaria o próprio TTL.
    const runnerTok = signToken(
      { sub: "u1", email: "u@x", role: "user", tenantId: TENANT, svc: "runner", projectId: PROJECT }, "1h",
    );
    const res = await mint({ projectId: OTHER_PROJECT }, runnerTok);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("P0 (rota B): caller tenant_admin (não estático) NÃO cunha token de projeto → 403", async () => {
    const adminTok = signToken({ sub: "a1", email: "a@x", role: "tenant_admin", tenantId: TENANT }, "1h");
    const res = await mint({ projectId: PROJECT }, adminTok);
    expect(res.statusCode).toBe(403);
  });

  it("zentriz_admin (não estático) PODE cunhar token de projeto → 200", async () => {
    const zTok = signToken({ sub: "z1", email: "z@x", role: "zentriz_admin", tenantId: null }, "1h");
    const res = await mint({ projectId: PROJECT }, zTok);
    expect(res.statusCode).toBe(200);
  });
});
