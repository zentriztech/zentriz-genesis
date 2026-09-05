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
    // Migração 089: o teto de espera é DITADO PELO SERVIDOR. O cliente tinha 18 min hardcoded,
    // menor que revisões reais de ~19 min — ele descartava trabalho já concluído e pago.
    expect(Date.parse(body.deadlineAt)).toBeGreaterThan(Date.now());
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

// ── Migração 089: rehidratação (in-flight + history) e binding de dono ─────────
// O bug que estas rotas existem para matar: o job vivia só num Map em memória e o jobId só no
// closure do React → sair da tela perdia o estado e um segundo Opus 5 era disparado em paralelo.
describe("GET /api/spec-chat/in-flight — rehidratação fail-closed", () => {
  const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
  const JOB = "55555555-5555-4555-8555-555555555555";
  // Linha de job em voo pertencente ao usuário corrente.
  const withInFlight = (sql: string) => {
    if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
    if (sql.includes("FROM spec_chat_jobs") && sql.includes("project_id = $1")) {
      return {
        rows: [{
          id: JOB, project_id: PROJ, tenant_id: TENANT, owner_user_id: USER_ID, agents_job_id: "cto-abc",
          kind: "resolve_gaps", file_path: null, base_sha: null, base_spec_sha: "sha-spec",
          status: "done", reply: "pronto", error: null,
          created_at: new Date(Date.now() - 60_000).toISOString(),
          finished_at: new Date().toISOString(), collected_at: null,
          deadline_at: new Date(Date.now() + 600_000).toISOString(),
        }],
      };
    }
    return { rows: [] };
  };

  it("projectId inválido → 400 (fail-closed antes de tocar o banco)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/spec-chat/in-flight?projectId=nao-e-uuid" });
    expect(res.statusCode).toBe(400);
  });

  it("projeto de OUTRO tenant → 404 (não vaza a existência do job)", async () => {
    currentUser = { id: USER_ID, role: "user", tenantId: OTHER_TENANT };
    queryHandler = withInFlight; // o job existe, mas o projeto é do TENANT
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/in-flight?projectId=${PROJ}` });
    expect(res.statusCode).toBe(404);
  });

  it("devolve o job recuperado com escalares e SEM a spec (95kB não trafegam a cada mount)", async () => {
    queryHandler = withInFlight;
    const sqls: string[] = [];
    const inner = withInFlight;
    queryHandler = (sql) => { sqls.push(sql); return inner(sql); };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/in-flight?projectId=${PROJ}` });
    expect(res.statusCode).toBe(200);
    const { job } = JSON.parse(res.body);
    expect(job.jobId).toBe(JOB);
    expect(job.status).toBe("done");
    expect(job.kind).toBe("resolve_gaps");
    // `recovered` = terminou enquanto ninguém olhava → o cliente OFERECE, não aplica sozinho.
    expect(job.recovered).toBe(true);
    expect(job.specMarkdown).toBeUndefined();
    expect(job.elapsed).toBeGreaterThan(0);
    // `createdAt` em ISO (o mapper devolve `Date.toString()`, que só o parser leniente do JS lê).
    expect(job.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // guarda anti-`SELECT *`: a consulta de rehidratação não pode carregar a spec inteira.
    // `spec_markdown IS NOT NULL` no WHERE/projeção booleana é PERMITIDO (não trafega o corpo) —
    // é o que deixa o in-flight reoferecer um job reprovado que guardou a revisão.
    const jobSql = sqls.find((s) => s.includes("FROM spec_chat_jobs") && s.includes("project_id = $1"));
    expect(jobSql).toBeTruthy();
    expect(jobSql).not.toMatch(/\bspec_markdown\b(?!\s+IS NOT NULL)/);
    expect(jobSql).not.toContain("SELECT *");
    // e o binding de dono está NO PRÓPRIO SQL (não só na aplicação)
    expect(jobSql).toContain("owner_user_id");
  });

  it("sem job em voo → { job: null } (não 404 — o projeto existe)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/in-flight?projectId=${PROJ}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).job).toBeNull();
  });

  it("GET /:jobId de job de OUTRO dono → 404 (S3: binding de dono vem do banco)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
      if (sql.includes("FROM spec_chat_jobs") && sql.includes("WHERE id = $1")) {
        return { rows: [{ id: JOB, owner_user_id: "99999999-9999-4999-8999-999999999999", status: "done", spec_markdown: "SEGREDO", created_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/${JOB}` });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("SEGREDO");
  });

  it("GET /:jobId lê o BANCO quando o Map não tem o job (sobrevive a restart da api)", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
      if (sql.includes("FROM spec_chat_jobs") && sql.includes("WHERE id = $1")) {
        return { rows: [{ id: JOB, owner_user_id: USER_ID, status: "done", spec_markdown: "# Spec recuperada", reply: "ok", file_path: "backend/01-api.md", base_sha: "sha-1", base_spec_sha: "sha-spec", created_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/${JOB}` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.status).toBe("done");
    expect(b.specMarkdown).toBe("# Spec recuperada");
    expect(b.filePath).toBe("backend/01-api.md");
    expect(b.baseSha).toBe("sha-1");
  });

  it("estado terminal 'lost' do banco chega ao cliente como error COM causa", async () => {
    queryHandler = (sql) => {
      if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
      if (sql.includes("FROM spec_chat_jobs") && sql.includes("WHERE id = $1")) {
        return { rows: [{ id: JOB, owner_user_id: USER_ID, status: "lost", error: "O agente já descartou o resultado desta revisão (expirou).", created_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/${JOB}` });
    const b = JSON.parse(res.body);
    expect(b.status).toBe("error");
    expect(b.error).toContain("descartou");
  });
});

describe("GET /api/spec-chat/history — o chat deixa de nascer vazio", () => {
  it("devolve o histórico em ordem cronológica (o SELECT vem DESC + reverse)", async () => {
    const now = Date.now();
    queryHandler = (sql) => {
      if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
      if (sql.includes("FROM spec_chat_messages")) {
        return {
          rows: [
            { id: "3", role: "assistant", content: "resposta 2", created_at: new Date(now).toISOString(), job_id: null },
            { id: "2", role: "user", content: "pergunta 2", created_at: new Date(now - 1000).toISOString(), job_id: null },
            { id: "1", role: "user", content: "pergunta 1", created_at: new Date(now - 2000).toISOString(), job_id: null },
          ],
        };
      }
      return { rows: [] };
    };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/history?projectId=${PROJ}` });
    expect(res.statusCode).toBe(200);
    const { messages } = JSON.parse(res.body);
    expect(messages.map((m: { content: string }) => m.content)).toEqual(["pergunta 1", "pergunta 2", "resposta 2"]);
  });

  it("projeto de outro tenant → 404 (histórico é vetor de prompt injection cross-tenant)", async () => {
    currentUser = { id: USER_ID, role: "user", tenantId: "22222222-2222-4222-8222-222222222222" };
    const res = await app.inject({ method: "GET", url: `/api/spec-chat/history?projectId=${PROJ}` });
    expect(res.statusCode).toBe(404);
  });
});

// ── Fase 1: escopo de PRODUTO (SPEC_CONTEXT_PRODUCT_SCOPE) ─────────────────────
// O que estes testes protegem: (a) com a flag OFF o envelope é o de ANTES (deploy de api e agents
// em qualquer ordem é seguro); (b) com ON os blocos viajam como CAMPOS PRÓPRIOS e a api PARA de
// colá-los no `task` (senão o runtime, que agora os emite, mandaria o mesmo texto duas vezes);
// (c) o chat por-arquivo — que rodava com contexto ZERO (defeito E) — passa a receber o mapa.
describe("POST /api/spec-chat — Fase 1: contexto de PRODUTO", () => {
  const PRODUCT = "66666666-6666-4666-8666-666666666666";
  const SIB = "77777777-7777-4777-8777-777777777777";
  const FINDINGS = [
    { file: "tms.md", line: 3, severity: "blocker", title: "Contrato de auth ausente", rationale: "", source: "stage_b" },
  ];
  /** Responde às 4 consultas do productContext + acesso + última validação. */
  const withProduct = (sql: string) => {
    const s = sql.replace(/\s+/g, " ");
    if (s.includes("pr.name AS product_name")) {
      return { rows: [{ id: PROJ, title: "tms", status: "on_bench", product_id: PRODUCT, tenant_id: TENANT, created_by: USER_ID, product_name: "Venuxx V2" }] };
    }
    if (s.includes("p.extra->>'project_type'")) {
      return { rows: [
        { id: PROJ, title: "tms", status: "on_bench", project_type: "backend_api_python" },
        { id: SIB, title: "identity", status: "accepted", project_type: "backend_api_python" },
      ] };
    }
    if (s.includes("FROM project_triggers")) return { rows: [{ project_id: PROJ, trigger_project_id: SIB }] };
    if (s.includes("FROM project_spec_files")) return { rows: [] };
    if (s.includes("spec_validation_runs")) return { rows: [{ status: "failed", findings: FINDINGS }] };
    if (s.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
    return { rows: [] };
  };

  beforeEach(() => { queryHandler = withProduct; delete process.env.SPEC_CONTEXT_PRODUCT_SCOPE; });

  it("flag OFF: nenhum campo novo no envelope e o contexto segue colado no task (byte-idêntico)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# tms", messages: msg("detalhe o modelo"), projectId: PROJ },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.inputs.context_emit).toBeUndefined();
    expect(body.inputs.product_map).toBeUndefined();
    // Comportamento antigo preservado: o bloco (com o finding) continua COLADO no task.
    expect(body.task).toContain("─── RELATÓRIO DE VALIDAÇÃO / GAPs A RESOLVER");
    expect(body.task).toContain("Contrato de auth ausente");
  });

  it("flag ON: mapa vai em inputs.product_map com context_emit=v2 e SAI do task (sem duplicar)", async () => {
    process.env.SPEC_CONTEXT_PRODUCT_SCOPE = "on";
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# tms", messages: msg("detalhe o modelo"), projectId: PROJ },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.inputs.context_emit).toBe("v2");
    expect(body.inputs.product_map).toContain("MAPA DO PRODUTO");
    expect(body.inputs.product_map).toContain("Venuxx V2");
    expect(body.inputs.product_map).toContain("identity"); // o irmão que o CTO nunca viu
    expect(body.inputs.validation_report).toContain("Contrato de auth ausente");
    // O `task` não repete o que agora é campo próprio (o runtime emite uma vez). A menção
    // "RELATÓRIO DE VALIDAÇÃO" segue no texto fixo do prompt; o que não pode voltar é o BLOCO.
    expect(body.task).not.toContain("─── RELATÓRIO DE VALIDAÇÃO / GAPs A RESOLVER");
    expect(body.task).not.toContain("Contrato de auth ausente");
    expect(body.task).not.toContain("MAPA DO PRODUTO");
  });

  it("flag ON no modo por-arquivo: o mapa entra como contexto só-leitura (fecha o defeito E)", async () => {
    process.env.SPEC_CONTEXT_PRODUCT_SCOPE = "on";
    rawResponse = JSON.stringify({ response: "# tms\n\nrevisado" });
    const res = await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# tms", messages: msg("ajuste"), projectId: PROJ, filePath: "tms.md" },
    });
    expect(res.statusCode).toBe(202);
    const rawCall = httpPostCalls.find((c) => c.url.includes("/invoke/raw"));
    const prompt = JSON.parse(rawCall!.body).user_message as string;
    expect(prompt).toContain("CONTEXTO SÓ-LEITURA");
    expect(prompt).toContain("MAPA DO PRODUTO");
    expect(prompt).toContain("NÃO o copie para o arquivo");
  });

  it("flag OFF no modo por-arquivo: contexto zero (não regride nem gasta contexto)", async () => {
    rawResponse = JSON.stringify({ response: "# tms\n\nrevisado" });
    await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# tms", messages: msg("ajuste"), projectId: PROJ, filePath: "tms.md" },
    });
    const prompt = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/raw"))!.body).user_message as string;
    expect(prompt).not.toContain("CONTEXTO SÓ-LEITURA");
  });
});

// ── F1 (2026-09-05): `SPEC_CTO_EDIT_FORMAT` — o CTO entrega EDIÇÕES, não a spec inteira ────────────
// A causa do truncamento é o CTO reemitir 98k chars a cada rodada (≈75% dos 64k tokens de saída do
// Opus 5 só para copiar o que não mudou). A DECISÃO do formato nasce aqui, na api, porque é ela quem
// monta a regra 4 do prompt: se a decisão morasse no agents o prompt ficaria auto-contraditório.
// A autoria do texto continua 100% do LLM — o servidor apenas aplica o search/replace que ele escreveu.
describe("POST /api/spec-chat — F1: formato de entrega do CTO", () => {
  const withFindings = (sql: string) => {
    if (sql.includes("FROM projects")) return { rows: [{ tenant_id: TENANT, created_by: USER_ID }] };
    if (sql.includes("spec_validation_runs")) {
      return { rows: [{ status: "failed", findings: [{ file: "README.md", line: 1, severity: "blocker", title: "Falta authz", rationale: "x", source: "stage_b" }] }] };
    }
    return { rows: [] };
  };

  beforeEach(() => { delete process.env.SPEC_CTO_EDIT_FORMAT; });

  it("default (whole): prompt e constraints byte-idênticos ao legado", async () => {
    queryHandler = withFindings;
    await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", projectId: PROJ, resolveGaps: true },
    });
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.task).toContain("Devolva a SPEC INTEIRA revisada");
    expect(body.task).toContain("devolvendo a spec COMPLETA revisada");
    expect(body.task).not.toContain("APENAS AS EDIÇÕES");
    expect(body.inputs.edit_format).toBeUndefined();
    expect(body.inputs.constraints).toContain("return-full-revised-spec");
  });

  it("ON (edits): a regra 4 pede EDIÇÕES, mantém o path exigido e marca inputs.edit_format", async () => {
    process.env.SPEC_CTO_EDIT_FORMAT = "edits";
    queryHandler = withFindings;
    await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", projectId: PROJ, resolveGaps: true },
    });
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.task).toContain("APENAS AS EDIÇÕES");
    expect(body.task).not.toContain("Devolva a SPEC INTEIRA revisada");
    // o path continua obrigatório: o gate `_required_path_prefixes_for_mode` não mudou
    expect(body.task).toContain("docs/spec/PRODUCT_SPEC.md");
    expect(body.inputs.edit_format).toBe("edits");
    expect(body.inputs.constraints).toContain("return-edits-not-full-spec");
    expect(body.inputs.constraints).not.toContain("return-full-revised-spec");
    // a spec-base continua viajando inteira: é contra ela que o servidor aplica os edits
    expect(body.inputs.spec_raw).toBe("# doc");
  });

  it("ON (edits) também vale no chat conversacional (sem resolveGaps)", async () => {
    process.env.SPEC_CTO_EDIT_FORMAT = "edits";
    await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("adicione um campo email"), projectId: PROJ },
    });
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.task).toContain("APENAS AS EDIÇÕES");
    expect(body.inputs.edit_format).toBe("edits");
    expect(body.inputs.constraints).toContain("return-edits-not-full-spec");
  });

  it("valor desconhecido da flag cai no legado (fail-safe)", async () => {
    process.env.SPEC_CTO_EDIT_FORMAT = "sim";
    await app.inject({
      method: "POST", url: "/api/spec-chat",
      payload: { specMarkdown: "# doc", messages: msg("ajuste"), projectId: PROJ },
    });
    const body = JSON.parse(httpPostCalls.find((c) => c.url.includes("/invoke/cto/async"))!.body);
    expect(body.inputs.edit_format).toBeUndefined();
    expect(body.task).toContain("Devolva a SPEC INTEIRA revisada");
  });
});
