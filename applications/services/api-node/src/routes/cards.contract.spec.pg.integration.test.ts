/**
 * Teste de CONTRATO da aba Especificação dos cards (revisão adversarial Y-03/Y-15, frente L2).
 *
 * Complementa `cards.contract.pg.integration.test.ts` (que cobre as rotas `/api/cards/**`): aqui entram as rotas que o portal usa
 * para OPERAR o rascunho do card e que não estavam no contrato — `spec-tree`, `spec-files`, `spec-file` (GET/PUT/POST),
 * `spec-chat`, `evolution-plan` e `rfc-from-template`. O fluxo percorre, pelas rotas REAIS em Postgres efêmero:
 *   criar card → listar o rascunho → recusar caminhos fora do escopo → escrever o RFC em `docs/rfc/` → conflito/edição (If-Match)
 *   → Chat (stub do agente) → validar (`ready`) → travar (Chat/plano/escrita recusados) → reabrir → RFC pelo modelo e pelo
 *   planner → validar → promover.
 * Cada resposta vira uma fixture em `applications/apps/genesis-web/lib/cards/__contract__/spec/*.json`, validada por schema no portal.
 * Dois modos, como no teste irmão: `CONTRACT_GEN=1` (npm run contract:gen:spec) regrava; sem a variável compara e falha se mudou.
 * LLM/agents sempre STUBS. Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed,
} from "../testing/evolvePg.js";

const UP = vi.hoisted(() => {
  const d = `/tmp/l2-upload-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = d;
  return d;
});
/** Resposta do "agente": o teste troca a função a cada passo (chat de arquivo e planner usam o mesmo `/invoke/raw`). */
const agent = vi.hoisted(() => ({ reply: (_url: string, _body: string): string => "{}", calls: [] as Array<{ url: string; body: string }> }));

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
vi.mock("./specs.js", async (orig) => ({
  ...(await orig<typeof import("./specs.js")>()),
  httpPost: async (url: string, body: string) => { agent.calls.push({ url, body }); return agent.reply(url, body); },
  httpGet: async () => "{}",
}));
vi.mock("../services/tenantLlmConfig.js", async (orig) => ({
  ...(await orig<typeof import("../services/tenantLlmConfig.js")>()),
  resolveWorkbenchLlm: async () => ({}),
  agentsLlmFields: () => ({}),
}));

import { cardRoutes } from "./cards.js";
import { ticketRoutes } from "./tickets.js";
import { projectRoutes } from "./projects.js";
import { specFileRoutes } from "./specFiles.js";
import { specChatRoutes } from "./specChat.js";
import { evolutionPlanRoutes } from "./evolutionPlan.js";
import { specAutonomyRoutes } from "./specAutonomy.js";
import { pipelineRoutes } from "./pipeline.js";
import { connectDeclarationRoutes } from "./connectDeclaration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SPEC_CONTRACT_DIR = resolve(HERE, "../../../../apps/genesis-web/lib/cards/__contract__/spec");
const GEN = process.env.CONTRACT_GEN === "1";

// ── Normalização (mesma do teste irmão): ids, datas, hashes e caminhos de /tmp viram placeholders estáveis (por fixture) ──
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA = /\b[0-9a-f]{64}\b/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const TMP = /\/tmp\/[A-Za-z0-9_./-]+/g;
function normalize(value: unknown): unknown {
  let text = JSON.stringify(value ?? null);
  const ids = new Map<string, string>();
  const shas = new Map<string, string>();
  text = text.replace(UUID, (m) => {
    const k = m.toLowerCase();
    if (!ids.has(k)) ids.set(k, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(k)!;
  });
  text = text.replace(SHA, (m) => {
    if (!shas.has(m)) shas.set(m, String(shas.size + 1).padStart(64, "0"));
    return shas.get(m)!;
  });
  text = text.replace(ISO, "2026-11-04T12:00:00.000Z").replace(TMP, "<tmp>").replace(/App [a-z0-9]{8,}/g, "App Demo").replace(/aberto_em: \d{4}-\d{2}-\d{2}/g, "aberto_em: 2026-11-04");
  return JSON.parse(text);
}

const rfc = (o: { n?: number; extra?: string } = {}) => `# RFC-${String(o.n ?? 1).padStart(4, "0")} — Exportar entregas em CSV

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.
${o.extra ?? ""}
## Critérios de aceite
### Cenário: exportar entregas
- **Dado** um usuário autenticado com entregas
- **Quando** clica em "Exportar CSV"
- **Então** recebe um arquivo CSV com todas as entregas

## Compatibilidade
- Tipo (SemVer): MINOR
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/deliveries/**"
  - "tests/**"
\`\`\`
`;

describePg("Contrato da aba Especificação — rotas de spec, chat e planner gravadas como fixtures do portal", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const written: string[] = [];
  const envBackup = { API_AGENTS_URL: process.env.API_AGENTS_URL };

  beforeAll(async () => {
    mkdirSync(UP, { recursive: true });
    pool = await openPg();
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes, specFileRoutes, specChatRoutes, evolutionPlanRoutes, specAutonomyRoutes, connectDeclarationRoutes, pipelineRoutes]);
    if (GEN) mkdirSync(SPEC_CONTRACT_DIR, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    if (GEN) writeFileSync(join(SPEC_CONTRACT_DIR, "index.json"), JSON.stringify([...new Set(written)].sort(), null, 2) + "\n");
    await app?.close();
    for (const s of seeds) s.cleanup();
    rmSync(UP, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool?.end();
  });
  beforeEach(() => { process.env.API_AGENTS_URL = "http://agents.local"; agent.calls.length = 0; agent.reply = () => "{}"; });
  afterEach(() => { vi.unstubAllEnvs(); });

  type Res = Awaited<ReturnType<FastifyInstance["inject"]>>;
  const rec = (name: string, request: string, res: Res, expectStatus?: number) => {
    if (expectStatus !== undefined) expect(res.statusCode, `${name}: ${res.body}`).toBe(expectStatus);
    let body: unknown = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    const fixture = { request, status: res.statusCode, body: normalize(body) };
    written.push(name);
    const file = join(SPEC_CONTRACT_DIR, `${name}.json`);
    const text = JSON.stringify(fixture, null, 2) + "\n";
    if (GEN) writeFileSync(file, text);
    else {
      expect(existsSync(file), `fixture spec/${name}.json ausente: rode \`npm run contract:gen:spec\` no api-node e revise o diff no portal`).toBe(true);
      expect(fixture, `o contrato de spec/${name} mudou: rode \`npm run contract:gen:spec\`, revise o diff e adapte o portal`).toEqual(JSON.parse(readFileSync(file, "utf-8")));
    }
    return body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const as = (s: Seed, role = "tenant_admin") => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId });
  const mk = async () => {
    const s = await seedAcceptedProduct(pool, {
      budgetUsd: 50,
      specContent: "# Spec do pai\n\nO app lista entregas. Prazo de 48h.\n",
      extraFiles: [{ relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h para entregas urgentes.\n" }],
    });
    seeds.push(s);
    process.env.UPLOAD_DIR = UP;
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    as(s);
    return s;
  };
  const req = (s: Seed, method: string, url: string, payload?: unknown) => { as(s); return app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) }); };
  const get = (s: Seed, url: string) => req(s, "GET", url);
  const post = (s: Seed, url: string, payload?: unknown) => req(s, "POST", url, payload);
  const create = async (s: Seed) => {
    const r = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", title: "Exportar entregas em CSV", body: "Quero baixar a lista de entregas em CSV." });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; code: string; draftProjectId: string };
  };
  const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("tempo esgotado esperando o job");
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const pollChat = (s: Seed, jobId: string) => until(async () => {
    const r = await get(s, `/api/spec-chat/${jobId}`);
    const j = r.json() as { status: string };
    return j.status === "done" || j.status === "error" ? r : null;
  });
  const pollPlan = (s: Seed, draftId: string, jobId: string) => until(async () => {
    const r = await get(s, `/api/projects/${draftId}/evolution-plan/${jobId}`);
    const j = r.json() as { status: string };
    return j.status === "done" || j.status === "error" ? r : null;
  });

  it("aba Especificação: listar, escopo, escrever o RFC em docs/rfc, conflito, chat, validar, travar, reabrir e promover", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;

    // O rascunho de um card novo só tem o pedido (tickets/TK-NNNN/request.md): é o arquivo que a tela precisa mostrar.
    rec("spec-tree.draft", "GET /api/projects/:draftId/spec-tree", await get(s, `/api/projects/${d}/spec-tree`), 200);
    rec("spec-files.draft", "GET /api/projects/:draftId/spec-files", await get(s, `/api/projects/${d}/spec-files`), 200);
    rec("spec-file.get-request", "GET /api/projects/:draftId/spec-file?path=", await get(s, `/api/projects/${d}/spec-file?path=tickets/TK-0001/request.md`), 200);

    // Caminhos que a tela NÃO pode sugerir: o antigo "rfc/RFC-001.md" e um spec.md na raiz.
    const bad1 = rec("spec-file.post-400-fora-do-escopo", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "rfc/RFC-001.md", content: "# x" }), 400);
    expect(bad1.code).toBe("CARD_PATH_OUT_OF_SCOPE");
    expect(bad1.writable).toEqual(["tickets/TK-0001/**", "docs/rfc/**", "docs/adr/**"]);
    rec("spec-file.post-400-raiz", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "spec.md", content: "# x" }), 400);
    rec("spec-file.post-400-caminho-invalido", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/rfc/../../x.md", content: "# x" }), 400);

    // Escrever o RFC no caminho válido; repetir = EXISTS; ler; editar com If-Match; conflito.
    const rfcPath = "docs/rfc/RFC-0001-exportar-csv.md";
    rec("spec-file.post-201", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: rfcPath, content: "# RFC-0001 — Exportar entregas em CSV\n\nrascunho\n" }), 201);
    rec("spec-file.post-409-exists", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: rfcPath, content: "# x" }), 409);
    rec("spec-tree.with-rfc", "GET /api/projects/:draftId/spec-tree", await get(s, `/api/projects/${d}/spec-tree`), 200);
    const got = rec("spec-file.get-200", "GET /api/projects/:draftId/spec-file?path=", await get(s, `/api/projects/${d}/spec-file?path=${rfcPath}`), 200);
    rec("spec-file.get-404", "GET /api/projects/:draftId/spec-file?path=", await get(s, `/api/projects/${d}/spec-file?path=docs/rfc/RFC-9999-nao-existe.md`), 404);
    rec("spec-file.put-409-conflict", "PUT /api/projects/:draftId/spec-file?path=", await req(s, "PUT", `/api/projects/${d}/spec-file?path=${rfcPath}`, { content: rfc(), baseSha: "0".repeat(64) }), 409);
    const put = rec("spec-file.put-200", "PUT /api/projects/:draftId/spec-file?path=", await req(s, "PUT", `/api/projects/${d}/spec-file?path=${rfcPath}`, { content: rfc(), baseSha: got.contentSha256 }), 200);
    expect(put.contentSha256).not.toBe(got.contentSha256);

    // Chat de IA sobre o arquivo aberto (stub do agente devolve o RFC com uma linha a mais).
    const revised = rfc({ extra: "- REQ-02 — O CSV DEVE usar ponto e vírgula como separador.\n" });
    agent.reply = () => JSON.stringify({ response: revised, model_used: "stub" });
    const chatBody = { specMarkdown: rfc(), messages: [{ role: "user", content: "Acrescente o separador do CSV." }], projectId: d, filePath: rfcPath, baseSha: put.contentSha256 };
    const chat = rec("spec-chat.post-202", "POST /api/spec-chat", await post(s, "/api/spec-chat", chatBody), 202);
    const done = rec("spec-chat.get-done", "GET /api/spec-chat/:jobId", await pollChat(s, chat.jobId), 200);
    expect(done).toMatchObject({ status: "done", filePath: rfcPath });
    expect(String(done.specMarkdown)).toContain("ponto e vírgula");
    expect(agent.calls.some((x) => x.url.endsWith("/invoke/raw"))).toBe(true);
    // agente sem conteúdo ⇒ job em erro (a tela mostra a mensagem e não aplica nada)
    agent.reply = () => JSON.stringify({ response: "", model_used: "stub" });
    const chat2 = await post(s, "/api/spec-chat", chatBody);
    expect(chat2.statusCode).toBe(202);
    rec("spec-chat.get-error", "GET /api/spec-chat/:jobId", await pollChat(s, chat2.json().jobId), 200);
    rec("spec-chat.post-400-sem-mensagem", "POST /api/spec-chat", await post(s, "/api/spec-chat", { ...chatBody, messages: [] }), 400);
    rec("spec-chat.post-400-escopo", "POST /api/spec-chat", await post(s, "/api/spec-chat", { ...chatBody, filePath: "spec.md" }), 400);

    // Aplicar a revisão (como a tela faz: PUT com o sha atual) e validar.
    const sha = (await get(s, `/api/projects/${d}/spec-file?path=${rfcPath}`)).json().contentSha256 as string;
    expect((await req(s, "PUT", `/api/projects/${d}/spec-file?path=${rfcPath}`, { content: String(done.specMarkdown), baseSha: sha })).statusCode).toBe(200);
    const ready = await post(s, `/api/cards/${c.id}/ready`);
    expect(ready.statusCode, ready.body).toBe(200);

    // Travado (card pronto): o servidor recusa chat, planner, modelo de RFC e escrita com CARD_SPEC_LOCKED.
    rec("spec-chat.post-409-locked", "POST /api/spec-chat", await post(s, "/api/spec-chat", chatBody), 409);
    rec("evolution-plan.post-409-locked", "POST /api/projects/:draftId/evolution-plan", await post(s, `/api/projects/${d}/evolution-plan`, { request: "x" }), 409);
    rec("rfc-from-template.post-409-locked", "POST /api/projects/:draftId/rfc-from-template", await post(s, `/api/projects/${d}/rfc-from-template`, { title: "x" }), 409);
    rec("spec-file.post-409-locked", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/rfc/RFC-0002-x.md", content: "# x" }), 409);

    // Reabrir, mexer na spec, validar de novo e promover.
    expect((await post(s, `/api/cards/${c.id}/reopen`)).statusCode).toBe(200);
    rec("spec-file.post-201-apos-reabrir", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/adr/ADR-001-formato-csv.md", content: "# ADR-001 — Formato do CSV\n\n## Decisão\nPonto e vírgula.\n" }), 201);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    const promoted = await post(s, `/api/cards/${c.id}/promote`);
    expect(promoted.statusCode, promoted.body).toBe(201);
    // Promovido: a spec do rascunho segue travada.
    rec("spec-file.post-409-locked-promoted", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/rfc/RFC-0003-x.md", content: "# x" }), 409);
  }, 120_000);

  it("RFC pelo modelo e pelo planner (evolution-plan): job, resultado e erro", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;

    const tpl = rec("rfc-from-template.201", "POST /api/projects/:draftId/rfc-from-template", await post(s, `/api/projects/${d}/rfc-from-template`, { title: "Exportar entregas em CSV" }), 201);
    expect(String(tpl.path)).toMatch(/^docs\/rfc\/RFC-\d{4}-exportar-entregas-em-csv\.md$/);

    // Planner com resposta vazia ⇒ job em erro (mensagem amigável)
    agent.reply = () => JSON.stringify({ response: "", model_used: "stub" });
    const bad = rec("evolution-plan.post-202", "POST /api/projects/:draftId/evolution-plan", await post(s, `/api/projects/${d}/evolution-plan`, {}), 202);
    rec("evolution-plan.get-error", "GET /api/projects/:draftId/evolution-plan/:jobId", await pollPlan(s, d, bad.jobId), 200);

    // Planner com plano válido ⇒ grava RFC/ADR do card (e só eles)
    const plan = {
      summary: "Exportar entregas em CSV", compat: "minor", questions: ["O CSV deve incluir entregas canceladas?"],
      rfcs: [{ slug: "exportar-csv", title: "Exportar entregas em CSV", content: rfc({ n: 1 }).replace(/^# [^\n]*\n/, "# x\n") }],
      adrs: [{ slug: "formato-csv", title: "Formato do CSV", content: "# x\n\n## Decisão\nUsar ponto e vírgula como separador, conforme o padrão do cliente brasileiro.\n" }],
      changelog: { added: ["Exportação de entregas em CSV"], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
      connect_yaml: "schemaVersion: 1\nserviceName: api\nresponsibility: x\ninterfaces: []\n",
    };
    agent.reply = () => JSON.stringify({ response: JSON.stringify(plan), model_used: "stub" });
    const ok = await post(s, `/api/projects/${d}/evolution-plan`, { request: "Gere o RFC de exportação em CSV." });
    expect(ok.statusCode, ok.body).toBe(202);
    const finished = rec("evolution-plan.get-done", "GET /api/projects/:draftId/evolution-plan/:jobId", await pollPlan(s, d, ok.json().jobId), 200);
    expect(finished.status).toBe("done");
    expect((finished.result.written as Array<{ path: string }>).map((w) => w.path).sort()).toEqual(["docs/adr/ADR-001-formato-csv.md", "docs/rfc/RFC-0002-exportar-csv.md"]);   // o 0001 é o do modelo (numeração por produto)
    rec("spec-tree.after-plan", "GET /api/projects/:draftId/spec-tree", await get(s, `/api/projects/${d}/spec-tree`), 200);
    rec("evolution-plan.get-404", "GET /api/projects/:draftId/evolution-plan/:jobId", await get(s, `/api/projects/${d}/evolution-plan/00000000-0000-4000-8000-0000000000ff`), 404);

    // Fora do projeto de evolução (o produto aceito) o planner não roda: o portal só o oferece no rascunho do card.
    rec("evolution-plan.post-409-not-evolution", "POST /api/projects/:id/evolution-plan", await post(s, `/api/projects/${s.parentId}/evolution-plan`, { request: "x" }), 409);
  }, 120_000);
});
