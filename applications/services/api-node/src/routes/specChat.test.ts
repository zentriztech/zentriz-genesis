/**
 * specChat.test.ts — RFC-0004 T4.3: chat de spec por-arquivo (revisão adversarial).
 *
 * Cobre as guardas de entrada do POST /api/spec-chat no modo por-arquivo:
 *   • filePath inválido (traversal/charset) → 400 (M2, via parseSpecPath REAL);
 *   • filePath sem projectId → 400 (editar UM arquivo exige um projeto);
 *   • C1: arquivo acima do teto (20k) → 413 (evita revisão truncada → apply que corta o arquivo);
 *   • token de serviço (runner) → 403 (spec é autoria humana);
 *   • caminho feliz → 202 ecoando filePath NORMALIZADO + baseSha (o apply grava no arquivo certo).
 *
 * auth/db/agents são mockados; managementGuard e projectAccess ficam REAIS (são puros).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJ = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

let currentUser: { id: string; role: string; tenantId: string | null; svc?: string; email?: string } = {
  id: USER_ID, role: "user", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

// pool.connect().query → devolve a linha do projeto (tenant do usuário → acesso ok).
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } =
  (sql) => (sql.includes("FROM projects") ? { rows: [{ tenant_id: TENANT, created_by: USER_ID }] } : { rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => queryHandler(sql, params),
    connect: async () => ({ query: async (sql: string, params: unknown[] = []) => queryHandler(sql, params), release: () => {} }),
  },
}));

// specs.js: httpPost/httpGet nunca são exercidos (job assíncrono após o 202); extractSpecMarkdown idem.
vi.mock("./specs.js", () => ({
  httpPost: async () => "{}",
  httpGet: async () => "{}",
  extractSpecMarkdown: () => "",
}));

let app: FastifyInstance;
beforeEach(async () => {
  const { specChatRoutes } = await import("./specChat.js");
  app = Fastify();
  await app.register(specChatRoutes);
  await app.ready();
  process.env.API_AGENTS_URL = "http://agents.local";
  currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
  queryHandler = (sql) => (sql.includes("FROM projects") ? { rows: [{ tenant_id: TENANT, created_by: USER_ID }] } : { rows: [] });
});

const msg = (content: string) => [{ role: "user", content }];

describe("POST /api/spec-chat — guardas do modo por-arquivo", () => {
  it("filePath inválido (traversal) → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("oi"), projectId: PROJ, filePath: "../etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain("filePath inválido");
  });

  it("filePath sem projectId → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("oi"), filePath: "backend/01-api.md" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain("projectId");
  });

  it("C1: arquivo acima de 20k caracteres → 413", async () => {
    const big = "x".repeat(20_001);
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: big, messages: msg("oi"), projectId: PROJ, filePath: "backend/01-api.md" },
    });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).code).toBe("FILE_TOO_LARGE");
  });

  it("token de serviço (runner) → 403", async () => {
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT, svc: "runner" };
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("oi"), projectId: PROJ, filePath: "backend/01-api.md" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("caminho feliz → 202 ecoando filePath normalizado + baseSha", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc pequeno", messages: msg("adicione um campo email"), projectId: PROJ, filePath: "backend/01-api.md", baseSha: "abc123" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("pending");
    expect(body.filePath).toBe("backend/01-api.md");
    expect(body.baseSha).toBe("abc123");
    expect(typeof body.jobId).toBe("string");
  });

  it("spec inteira (sem filePath) → 202 com filePath null", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("melhore a spec"), projectId: PROJ },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).filePath).toBeNull();
  });
});
