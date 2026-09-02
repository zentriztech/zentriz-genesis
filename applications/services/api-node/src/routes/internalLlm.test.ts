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
import { signToken } from "../auth.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATIC_TOKEN = "static-internal-secret";

// pool.query só é exercido no caminho IDOR do tenant_admin (SELECT tenant_id FROM projects).
let projectOwnerTenant: string | null = TENANT;
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (_sql: string, _params: unknown[]) => ({ rows: [{ tenant_id: projectOwnerTenant }] }),
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
