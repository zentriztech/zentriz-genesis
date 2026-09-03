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

// specs.js: no modo por-arquivo o job chama /invoke/raw (síncrono). Capturamos a URL e o payload
// para provar o roteamento cirúrgico e devolvemos uma resposta controlada.
let httpPostCalls: { url: string; body: string }[] = [];
let rawResponse = "{}";
vi.mock("./specs.js", () => ({
  httpPost: async (url: string, body: string) => {
    httpPostCalls.push({ url, body });
    return url.includes("/invoke/raw") ? rawResponse : "{}";
  },
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
  httpPostCalls = [];
  rawResponse = "{}";
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

  it("modo por-arquivo roteia por /invoke/raw e preserva o conteúdo (não normaliza)", async () => {
    const original = "# API\n\nEndpoint GET /health → { status: ok }.";
    const revised = `${original}\n\n## Nota\nCampo email adicionado.`;
    rawResponse = JSON.stringify({ response: revised, model_used: "us.anthropic.claude-opus-4-8" });
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: original, messages: msg("adicione uma nota"), projectId: PROJ, filePath: "backend/01-api.md", baseSha: "sha-1" },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = JSON.parse(res.body);

    // o job é síncrono (uma chamada /invoke/raw) — poll curto até done
    let done: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !done; i++) {
      const p = await app.inject({ method: "GET", url: `/api/spec-chat/${jobId}` });
      const b = JSON.parse(p.body);
      if (b.status === "done" || b.status === "error") done = b;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(done?.status).toBe("done");
    // conteúdo original PRESERVADO na íntegra (o bug do normalizador o descartava)
    expect(done?.specMarkdown).toContain("Endpoint GET /health");
    expect(done?.specMarkdown).toContain("## Nota");
    // roteou por /invoke/raw — NÃO pelo normalizador cto/async
    const rawCall = httpPostCalls.find((c) => c.url.includes("/invoke/raw"));
    expect(rawCall).toBeTruthy();
    expect(httpPostCalls.some((c) => c.url.includes("/invoke/cto/async"))).toBe(false);
    expect(JSON.parse(rawCall!.body).prompt_override).toContain("PRESERVANDO");
  });

  it("modo por-arquivo: cerca de código externa é removida do conteúdo aplicado", async () => {
    rawResponse = JSON.stringify({ response: "```md\n# Doc\n\ntexto\n```" });
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# Doc\n\ntexto", messages: msg("ajuste"), projectId: PROJ, filePath: "backend/01-api.md" },
    });
    const { jobId } = JSON.parse(res.body);
    let done: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !done; i++) {
      const p = await app.inject({ method: "GET", url: `/api/spec-chat/${jobId}` });
      const b = JSON.parse(p.body);
      if (b.status === "done" || b.status === "error") done = b;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(done?.status).toBe("done");
    expect(done?.specMarkdown).toBe("# Doc\n\ntexto");
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

// ── Onda 1: contexto (relatório de validação) + Resolver GAPs ──────────────────
describe("POST /api/spec-chat — Onda 1: Resolver GAPs + contexto de validação", () => {
  const FINDINGS = [
    { file: "backend/01-api.md", line: 12, severity: "blocker", title: "Falta autenticação", rationale: "Endpoints sem authz", source: "stage_b" },
    { file: "README.md", line: null, severity: "warning", title: "Sem critérios de aceite", rationale: "FR1 vago", source: "stage_b" },
  ];
  // queryHandler que também responde a última run de validação com FINDINGS.
  const withFindings = (sql: string) => {
    if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
    if (sql.includes("spec_validation_runs")) return { rows: [{ status: "failed", findings: FINDINGS }] };
    return { rows: [] };
  };

  it("resolveGaps sem projectId → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", resolveGaps: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain("projectId");
  });

  it("resolveGaps em modo por-arquivo → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", projectId: PROJ, filePath: "backend/01-api.md", resolveGaps: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain("por-arquivo");
  });

  it("resolveGaps sem GAPs em aberto → 409 NO_GAPS", async () => {
    // queryHandler padrão do beforeEach devolve [] para spec_validation_runs → sem findings.
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", projectId: PROJ, resolveGaps: true },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NO_GAPS");
  });

  it("resolveGaps com GAPs → 202, roteia por cto/async com relatório de validação + resolve_gaps", async () => {
    queryHandler = withFindings;
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", projectId: PROJ, resolveGaps: true },
    });
    expect(res.statusCode).toBe(202);
    // runChatJob dispara httpPost(cto/async) sincronamente antes do 202 — inspecionável já.
    const ctoCall = httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"));
    expect(ctoCall).toBeTruthy();
    const body = JSON.parse(ctoCall!.body);
    expect(body.task).toContain("RELATÓRIO DE VALIDAÇÃO");
    expect(body.task).toContain("Falta autenticação");
    expect(body.inputs.resolve_gaps).toBe(true);
    expect(body.inputs.validation_report).toContain("BLOCKER");
    // NÃO roteou pelo /invoke/raw (não é modo por-arquivo)
    expect(httpPostCalls.some((c) => c.url.includes("/invoke/raw"))).toBe(false);
  });

  it("chat de spec inteira injeta o relatório de validação no task (contexto p/ o CTO)", async () => {
    queryHandler = withFindings;
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("detalhe o modelo de dados"), projectId: PROJ },
    });
    expect(res.statusCode).toBe(202);
    const ctoCall = httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"));
    expect(ctoCall).toBeTruthy();
    const body = JSON.parse(ctoCall!.body);
    // mesmo sem resolveGaps, o CTO recebe o relatório como contexto só-leitura
    expect(body.task).toContain("RELATÓRIO DE VALIDAÇÃO");
    expect(body.inputs.resolve_gaps).toBeUndefined();
    expect(body.inputs.validation_report).toContain("Sem critérios de aceite");
  });
});
