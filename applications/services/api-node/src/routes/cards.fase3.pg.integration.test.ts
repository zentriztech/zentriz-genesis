/**
 * Fase 3 / 3.3 + 3.5 — backend dos cards em Postgres REAL (efêmero): trava CARD_SPEC_LOCKED em todos os escritores de spec do
 * rascunho, reabertura explícita, escopo de escrita (só a pasta do card), Chat IA / GAPs / planner de RFC lendo a spec da versão
 * corrente em modo somente leitura, revalidação ok|stale|conflict, card bloqueado por orçamento e retomada, jornada, anexos,
 * flag off byte a byte. Rotas reais; LLM/agents sempre STUBS (nenhuma chamada real). Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, sha256, uid, type Seed,
} from "../testing/evolvePg.js";

// `specFiles.ts` e `evolutionPlanner.ts` leem UPLOAD_DIR UMA vez, no import: o diretório precisa existir ANTES dos imports.
const UP = vi.hoisted(() => {
  const d = `/tmp/k1-upload-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = d;
  return d;
});

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

// Agents: nenhuma chamada real. `agentsReply` decide a resposta por URL; `agentsCalls` guarda o que a api mandou.
let agentsCalls: Array<{ url: string; body: string }> = [];
let agentsReply: (url: string, body: string) => string = () => "{}";
vi.mock("./specs.js", async (orig) => ({
  ...(await orig<typeof import("./specs.js")>()),
  httpPost: async (url: string, body: string) => { agentsCalls.push({ url, body }); return agentsReply(url, body); },
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
import { specChatRoutes, dispatchGapFileJob } from "./specChat.js";
import { evolutionPlanRoutes } from "./evolutionPlan.js";
import { specAutonomyRoutes } from "./specAutonomy.js";
import { pipelineRoutes } from "./pipeline.js";
import { connectDeclarationRoutes } from "./connectDeclaration.js";
import { evolveTestHooks } from "../services/evolveClaim.js";
import { syncCardForChildProject, syncCardsWithChildren } from "../services/cardPromote.js";
import { advanceAutonomyRun } from "../services/specAutonomy.js";
import { runReconcilerPass } from "../services/evolveReconciler.js";
import { evaluateCardDraftPromotability } from "../services/promotability.js";

const ev = (tag: string, data: unknown) => console.log(`[F3-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const BASE_MARK = "MARCADOR-BASE-9f3c";

const rfc = (o: { n?: number; compat?: string; nonGoals?: boolean; files?: string[]; extra?: string } = {}) => `# RFC-${String(o.n ?? 1).padStart(4, "0")} — Exportar entregas em CSV

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.
${o.nonGoals === false ? "" : "\n## Non-goals\nNão altera o cálculo de prazos nem a tela de mapa.\n"}
## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.
${o.extra ?? ""}
## Critérios de aceite
### Cenário: exportar entregas
- **Dado** um usuário autenticado com entregas
- **Quando** clica em "Exportar CSV"
- **Então** recebe um arquivo CSV com todas as entregas

## Compatibilidade
- Tipo (SemVer): ${o.compat ?? "MINOR"}
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
${(o.files ?? ["apps/api/src/deliveries/**", "tests/**"]).map((f) => `  - "${f}"`).join("\n")}
\`\`\`
`;

describePg("Fase 3 — backend dos cards (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const tmpDirs: string[] = [UP];
  const envBackup = { SPEC_AUTONOMY: process.env.SPEC_AUTONOMY, API_AGENTS_URL: process.env.API_AGENTS_URL, PROJECT_FILES_ROOT: process.env.PROJECT_FILES_ROOT };

  beforeAll(async () => {
    mkdirSync(UP, { recursive: true });
    pool = await openPg();
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes, specFileRoutes, specChatRoutes, evolutionPlanRoutes, specAutonomyRoutes, connectDeclarationRoutes, pipelineRoutes]);
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    evolveTestHooks.fault = undefined;
    await app?.close();
    for (const s of seeds) s.cleanup();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool?.end();
  });
  beforeEach(() => { agentsCalls = []; agentsReply = () => "{}"; process.env.API_AGENTS_URL = "http://agents.local"; });
  afterEach(() => { evolveTestHooks.fault = undefined; vi.unstubAllEnvs(); });

  const as = (s: Seed, role = "tenant_admin") => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId });
  const flagOn = (tenantId: string) => pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [tenantId]);
  const mk = async (o: { budgetUsd?: number | null; flag?: boolean } = {}) => {
    const s = await seedAcceptedProduct(pool, {
      budgetUsd: o.budgetUsd === undefined ? 50 : o.budgetUsd,
      specContent: `# Spec do pai\n\nO app lista entregas. ${BASE_MARK}: prazo de 48h.\n`,
      extraFiles: [{ relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h para entregas urgentes.\n" }],
    });
    seeds.push(s);
    process.env.UPLOAD_DIR = UP;                     // tudo o que a api grava (rascunhos, v2) cai no mesmo diretório dos módulos
    if (o.flag !== false) await flagOn(s.tenantId);
    as(s);
    return s;
  };
  const create = async (s: Seed, o: { kind?: string; title?: string; body?: string } = {}) => {
    as(s);
    const r = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: o.kind ?? "feature", title: o.title ?? "Exportar CSV", body: o.body ?? "Quero baixar a lista de entregas em CSV." } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; code: string; draftProjectId: string; state: string };
  };
  const addDraftFile = async (s: Seed, draftId: string, relDir: string, filename: string, content: string) => {
    const dir = join(UP, draftId, relDir);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, filename);
    writeFileSync(fp, content, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1,$2,$3,'text/markdown',$4,false,$5) ON CONFLICT (project_id, rel_dir, filename) DO UPDATE SET file_path = EXCLUDED.file_path, content_sha256 = EXCLUDED.content_sha256`,
      [draftId, filename, fp, relDir, sha256(content)],
    );
    return fp;
  };
  const addRfc = (s: Seed, draftId: string, o: Parameters<typeof rfc>[0] = {}) =>
    addDraftFile(s, draftId, "docs/rfc", `RFC-${String(o.n ?? 1).padStart(4, "0")}-exportar-csv.md`, rfc(o));
  const post = (s: Seed, path: string, payload?: unknown) => { as(s); return app.inject({ method: "POST", url: path, ...(payload ? { payload } : {}) }); };
  const get = (s: Seed, path: string) => { as(s); return app.inject({ method: "GET", url: path }); };
  const stateOf = async (id: string) => (await pool.query("SELECT card_state, status, child_project_id, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0] as
    { card_state: string; status: string; child_project_id: string | null; blocked_reason: string | null };
  const eventsOf = async (id: string) => (await pool.query("SELECT to_state, actor_kind, reason FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows as Array<{ to_state: string; actor_kind: string; reason: string | null }>;
  const readyCard = async (s: Seed, o: { kind?: string; rfc?: Parameters<typeof rfc>[0] } = {}) => {
    const c = await create(s, { kind: o.kind ?? "feature" });
    await addRfc(s, c.draftProjectId, o.rfc ?? { compat: "MINOR", nonGoals: true });
    const r = await post(s, `/api/cards/${c.id}/ready`);
    expect(r.statusCode, r.body).toBe(200);
    return c;
  };
  /** árvore da spec do rascunho: caminho → sha (conteúdo REAL em disco) */
  const treeOf = async (projectId: string) => {
    const rows = (await pool.query("SELECT rel_dir, filename, file_path FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename", [projectId])).rows;
    return Object.fromEntries(rows.map((r) => [`${r.rel_dir ? `${r.rel_dir}/` : ""}${r.filename}`, existsSync(r.file_path) ? sha256(readFileSync(r.file_path)) : "(sem arquivo)"]));
  };
  const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.3 — TRAVA CARD_SPEC_LOCKED
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("ready trava a spec: TODO escritor do rascunho responde 409 CARD_SPEC_LOCKED (e nada é escrito nem chamado)", async () => {
    process.env.SPEC_AUTONOMY = "on";
    const s = await mk();
    const c = await readyCard(s);
    const d = c.draftProjectId;
    const before = await treeOf(d);
    const reqSha = before["tickets/TK-0001/request.md"];
    as(s);
    const writers: Array<[string, string, string, unknown]> = [
      ["editor PUT", "PUT", `/api/projects/${d}/spec-file?path=tickets/TK-0001/request.md`, { content: "novo", baseSha: reqSha }],
      ["editor POST", "POST", `/api/projects/${d}/spec-file`, { path: "docs/rfc/RFC-0002-outro.md", content: "# x" }],
      ["editor DELETE", "DELETE", `/api/projects/${d}/spec-file?path=docs/rfc/RFC-0001-exportar-csv.md`, undefined],
      ["spec-content PATCH", "PATCH", `/api/projects/${d}/spec-content`, { specMarkdown: "# novo texto" }],
      ["Chat IA (arquivo)", "POST", `/api/spec-chat`, { specMarkdown: "# doc", messages: [{ role: "user", content: "ajuste" }], projectId: d, filePath: "tickets/TK-0001/request.md" }],
      ["Chat IA (spec inteira)", "POST", `/api/spec-chat`, { specMarkdown: "# doc", messages: [{ role: "user", content: "ajuste" }], projectId: d }],
      ["Resolver GAPs", "POST", `/api/spec-chat`, { specMarkdown: "# doc", messages: [], projectId: d, resolveGaps: true }],
      ["modo autônomo", "POST", `/api/spec-autonomy`, { projectId: d }],
      ["planner de RFC", "POST", `/api/projects/${d}/evolution-plan`, { request: "gere o RFC" }],
      ["RFC a partir do modelo", "POST", `/api/projects/${d}/rfc-from-template`, { title: "Outro" }],
      ["PATCH do card", "PATCH", `/api/cards/${c.id}`, { body: "texto novo" }],
      ["PATCH legado de ticket", "PATCH", `/api/tickets/${c.id}`, { body: "texto novo" }],
    ];
    const out: Record<string, number> = {};
    for (const [nome, method, url, payload] of writers) {
      const r = await app.inject({ method: method as "PUT", url, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${nome}: ${r.body}`).toBe(409);
      expect(r.json(), nome).toMatchObject({ code: "CARD_SPEC_LOCKED" });
      if (nome !== "modo autônomo") expect(r.json(), nome).toMatchObject({ state: "ready", canReopen: true });
      out[nome] = r.statusCode;
    }
    expect(agentsCalls).toEqual([]);                                  // nenhum LLM foi acionado
    expect(await treeOf(d)).toEqual(before);                          // nada escrito
    expect((await stateOf(c.id)).card_state).toBe("ready");           // e o card segue pronto (a recusa não o derruba)
    ev("trava-todos-os-escritores", out);
  });

  it("promovido: o rascunho vira histórico — mesma trava, sem 'reopen' possível", async () => {
    const s = await mk();
    const c = await readyCard(s);
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    const r = await app.inject({ method: "PUT", url: `/api/projects/${c.draftProjectId}/spec-file?path=tickets/TK-0001/request.md`, payload: { content: "x", baseSha: "y" } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "CARD_SPEC_LOCKED", state: "promoted", canReopen: false });
    const re = await post(s, `/api/cards/${c.id}/reopen`);
    expect(re.statusCode).toBe(409);
    expect(re.json()).toMatchObject({ code: "CARD_INVALID_TRANSITION", from: "promoted" });
  });

  it("reopen: ready → refining pela máquina (auditoria), destrava os escritores e invalida o carimbo; promover exige validar de novo", async () => {
    const s = await mk();
    const c = await readyCard(s);
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].has).toBe(true);
    expect((await get(s, `/api/cards/${c.id}`)).json().actions).toMatchObject({ reopen: true, edit: false });
    const lockedPatch = await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { body: "x" } });
    expect(lockedPatch.json().userMessage).toBe("A spec do card está travada. Reabra o card para voltar a editar.");   // mensagem curta PT-BR da tabela única
    const r = await post(s, `/api/cards/${c.id}/reopen`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, replayed: false, card: { state: "refining" } });
    expect((await get(s, `/api/cards/${c.id}`)).json().actions).toMatchObject({ reopen: false, edit: true });
    const evs = await eventsOf(c.id);
    expect(evs.map((e) => e.to_state)).toEqual(["draft", "ready", "refining"]);
    expect(evs[2]).toMatchObject({ actor_kind: "user", reason: "user_reopen" });
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].has).toBe(false);
    // repetir é seguro
    expect((await post(s, `/api/cards/${c.id}/reopen`)).json()).toMatchObject({ ok: true, replayed: true });
    expect((await eventsOf(c.id)).length).toBe(3);
    // destravado: o editor escreve
    const tree = await treeOf(c.draftProjectId);
    const put = await app.inject({ method: "PUT", url: `/api/projects/${c.draftProjectId}/spec-file?path=tickets/TK-0001/request.md`, payload: { content: "# Pedido revisado\n\nExportar com ponto e vírgula.\n", baseSha: tree["tickets/TK-0001/request.md"] } });
    expect(put.statusCode, put.body).toBe(200);
    // promover sem validar de novo: não está ready
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode).toBe(409);
    expect(pr.json().code).toBe("CARD_NOT_READY");
    // validar de novo → ready → promover (hash do novo carimbo)
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    // reopen em estados em que não vale
    const d = await create(s);
    expect((await post(s, `/api/cards/${d.id}/reopen`)).json()).toMatchObject({ code: "CARD_INVALID_TRANSITION", from: "draft" });
    ev("reopen", { eventos: evs.map((e) => `${e.to_state}:${e.actor_kind}:${e.reason}`) });
  });

  it("a 1ª escrita na spec do rascunho leva draft → refining (qualquer escritor); depois disso nada muda de estado", async () => {
    const s = await mk();
    const c = await create(s);
    expect((await stateOf(c.id)).card_state).toBe("draft");
    as(s);
    const r = await app.inject({ method: "POST", url: `/api/projects/${c.draftProjectId}/spec-file`, payload: { path: "docs/rfc/RFC-0001-exportar-csv.md", content: rfc() } });
    expect(r.statusCode, r.body).toBe(201);
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await eventsOf(c.id)).map((e) => `${e.to_state}:${e.actor_kind}:${e.reason}`)).toEqual(["draft:user:null", "refining:system:spec_write"]);
    // editor segue livre em refining
    const tree = await treeOf(c.draftProjectId);
    expect((await app.inject({ method: "PUT", url: `/api/projects/${c.draftProjectId}/spec-file?path=docs/rfc/RFC-0001-exportar-csv.md`, payload: { content: rfc({ compat: "PATCH" }), baseSha: tree["docs/rfc/RFC-0001-exportar-csv.md"] } })).statusCode).toBe(200);
    expect((await eventsOf(c.id)).length).toBe(2);
    // o card passa pelo gate com o RFC escrito pelo editor
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.3 — ESCOPO: só a pasta do card; a árvore herdada nunca muda
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("escritores só gravam em tickets/TK-NNNN/**, docs/rfc/** e docs/adr/** — o resto é 400 CARD_PATH_OUT_OF_SCOPE e a árvore da versão corrente não muda", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    const parentBefore = await treeOf(s.parentId);
    const out: Record<string, number> = {};
    as(s);
    for (const p of ["README.md", "CHANGELOG.md", "connect.yaml", "docs/regras.md", "docs/arquitetura/diagramas.md", "apps/api/src/x.ts", "tickets/TK-0002/request.md", "spec.md"]) {
      const r = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path: p, content: "# x" } });
      expect(r.statusCode, `${p}: ${r.body}`).toBe(400);
      expect(r.json().code).toBe("CARD_PATH_OUT_OF_SCOPE");
      out[p] = r.statusCode;
    }
    for (const p of ["tickets/TK-0001/notas.md", "tickets/TK-0001/anexos/regra.md", "docs/rfc/RFC-0001-exportar-csv.md", "docs/adr/ADR-001-formato.md"]) {
      const r = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path: p, content: "# ok" } });
      expect(r.statusCode, `${p}: ${r.body}`).toBe(201);
    }
    // Chat IA por arquivo também recusa arquivo fora do escopo (nem chega ao LLM)
    const chat = await app.inject({ method: "POST", url: "/api/spec-chat", payload: { specMarkdown: "# doc", messages: [{ role: "user", content: "x" }], projectId: d, filePath: "docs/regras.md" } });
    expect(chat.statusCode).toBe(400);
    expect(chat.json().code).toBe("CARD_PATH_OUT_OF_SCOPE");
    expect(agentsCalls).toEqual([]);
    // split e declaração Connect não se aplicam a card
    const cd = await app.inject({ method: "POST", url: `/api/projects/${d}/connect-declaration`, payload: {} });
    expect(cd.statusCode).toBe(409);
    expect(cd.json().code).toBe("CARD_OPERATION_UNSUPPORTED");
    // nada fora do escopo no rascunho; árvore do pai idêntica; sem README/CHANGELOG/connect/apps no disco do rascunho
    const tree = await treeOf(d);
    expect(Object.keys(tree).every((p) => /^(tickets\/TK-0001\/|docs\/rfc\/|docs\/adr\/)/.test(p)), JSON.stringify(Object.keys(tree))).toBe(true);
    expect(await treeOf(s.parentId)).toEqual(parentBefore);
    for (const f of ["README.md", "CHANGELOG.md", "connect.yaml", "apps"]) expect(existsSync(join(UP, d, f))).toBe(false);
    expect(readdirSync(join(UP, d)).sort()).toEqual(["docs", "tickets"]);
    ev("escopo", { recusados: out, arvore: Object.keys(tree) });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.3 — Chat IA / GAPs / planner leem a spec corrente (somente leitura)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Chat IA por arquivo: o prompt leva a spec da versão corrente (somente leitura) e a regra de escopo; o chat NÃO escreve nada; projeto comum não recebe o bloco", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    as(s);
    agentsReply = () => JSON.stringify({ response: "# Pedido\n\nTexto revisado pela IA.\n", model_used: "stub" });
    const treeBefore = await treeOf(d);
    const parentBefore = await treeOf(s.parentId);
    const reqPath = "tickets/TK-0001/request.md";
    const r = await app.inject({ method: "POST", url: "/api/spec-chat", payload: {
      specMarkdown: readFileSync(join(UP, d, reqPath), "utf-8"), baseSha: treeBefore[reqPath],
      messages: [{ role: "user", content: "deixe o pedido mais claro" }], projectId: d, filePath: reqPath,
    } });
    expect(r.statusCode, r.body).toBe(202);
    expect(await waitFor(() => agentsCalls.some((x) => x.url.endsWith("/invoke/raw")))).toBe(true);
    const raw = JSON.parse(agentsCalls.find((x) => x.url.endsWith("/invoke/raw"))!.body) as { user_message: string; guard_project_id?: string };
    expect(raw.user_message).toContain("SPEC DA VERSÃO CORRENTE (v1) — SOMENTE LEITURA");
    expect(raw.user_message).toContain(BASE_MARK);                              // o conteúdo do HEAD chegou
    expect(raw.user_message).toContain("docs/regras.md");                       // e a lista de arquivos do HEAD
    expect(raw.user_message).toContain("Escreva SOMENTE em tickets/TK-0001/");
    expect(raw.user_message).toContain("ARQUIVO: tickets/TK-0001/request.md");  // o alvo é o arquivo do card
    expect(raw.guard_project_id).toBe(d);                                       // o gasto sai do rascunho → dono do orçamento da versão
    // o chat não escreve: rascunho e versão corrente idênticos
    expect(await treeOf(d)).toEqual(treeBefore);
    expect(await treeOf(s.parentId)).toEqual(parentBefore);
    // controle: projeto COMUM (a versão corrente) não recebe o bloco do card
    agentsCalls = [];
    const parentSpec = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND is_primary", [s.parentId])).rows[0].file_path as string;
    const r2 = await app.inject({ method: "POST", url: "/api/spec-chat", payload: {
      specMarkdown: readFileSync(parentSpec, "utf-8"), messages: [{ role: "user", content: "x" }], projectId: s.parentId, filePath: "spec.md",
    } });
    expect(r2.statusCode, r2.body).toBe(202);
    expect(await waitFor(() => agentsCalls.some((x) => x.url.endsWith("/invoke/raw")))).toBe(true);
    const raw2 = JSON.parse(agentsCalls.find((x) => x.url.endsWith("/invoke/raw"))!.body) as { user_message: string };
    expect(raw2.user_message).not.toContain("SOMENTE LEITURA ---");
    expect(raw2.user_message).not.toContain("ESCOPO DESTE CARD");
    ev("chat-le-base", { chars: raw.user_message.length, temBase: true });
  });

  it("Resolver GAPs (por arquivo) sobre o rascunho: o pedido carrega a spec corrente como contexto somente leitura", async () => {
    const s = await mk();
    const c = await create(s);
    as(s);
    agentsReply = () => JSON.stringify({ response: "<<<<<<< SEARCH\nQuero baixar\n=======\nQuero exportar\n>>>>>>> REPLACE", model_used: "stub" });
    const reqPath = "tickets/TK-0001/request.md";
    const content = readFileSync(join(UP, c.draftProjectId, reqPath), "utf-8");
    const res = await dispatchGapFileJob({
      jobId: randomUUID(), projectId: c.draftProjectId, tenantId: s.tenantId, ownerUserId: s.userId, filePath: reqPath, fileContent: content,
      findings: [{ file: reqPath, line: null, severity: "blocker", title: "Pedido ambíguo", rationale: "Diga o formato do CSV.", source: "stage_b" } as never],
      userMessage: "resolver", agentsUrl: "http://agents.local", llm: {},
    });
    expect(res).toMatchObject({ ok: true, gaps: 1 });
    expect(await waitFor(() => agentsCalls.some((x) => x.url.endsWith("/invoke/raw")))).toBe(true);
    const raw = JSON.parse(agentsCalls.find((x) => x.url.endsWith("/invoke/raw"))!.body) as { user_message: string };
    expect(raw.user_message).toContain("SPEC DA VERSÃO CORRENTE (v1) — SOMENTE LEITURA");
    expect(raw.user_message).toContain(BASE_MARK);
    expect(raw.user_message).toContain("GAPs A RESOLVER NESTE ARQUIVO");
    expect(raw.user_message).toContain("Escreva SOMENTE em tickets/TK-0001/");
  });

  it("orçamento: a negativa do Guard no Chat/planner é um 402 claro do dono da versão — o card não é tocado", async () => {
    const s = await mk();
    const c = await create(s);
    as(s);
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1", [s.parentId]);
    const chat = await app.inject({ method: "POST", url: "/api/spec-chat", payload: { specMarkdown: "# doc", messages: [{ role: "user", content: "x" }], projectId: c.draftProjectId, filePath: "tickets/TK-0001/request.md" } });
    expect(chat.statusCode).toBe(402);
    expect(chat.json()).toMatchObject({ code: "BUDGET_PAUSED", cardId: c.id, cardState: "draft" });
    const plan = await app.inject({ method: "POST", url: `/api/projects/${c.draftProjectId}/evolution-plan`, payload: { request: "x" } });
    expect(plan.statusCode).toBe(402);
    expect(plan.json().code).toBe("BUDGET_PAUSED");
    expect(agentsCalls).toEqual([]);
    expect(await stateOf(c.id)).toMatchObject({ card_state: "draft", status: "open", blocked_reason: null });
    await pool.query("UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1", [s.parentId]);
    ev("orcamento-chat", { status: chat.statusCode, code: chat.json().code });
  });

  it("planner de RFC sobre o rascunho: lê a spec corrente, grava só RFC/ADR (sem CHANGELOG nem connect.yaml) e o gate do tipo passa", async () => {
    const s = await mk();
    const c = await create(s, { kind: "feature" });
    const d = c.draftProjectId;
    as(s);
    const plan = {
      summary: "Exportar entregas em CSV", compat: "minor", questions: [],
      rfcs: [{ slug: "exportar-csv", title: "Exportar entregas em CSV", content: rfc({ n: 1 }).replace(/^# [^\n]*\n/, "# x\n") }],
      adrs: [{ slug: "formato-csv", title: "Formato do CSV", content: "# x\n\n## Decisão\nUsar ponto e vírgula como separador, conforme o padrão do cliente brasileiro.\n" }],
      changelog: { added: ["Exportação de entregas em CSV"], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
      connect_yaml: "schemaVersion: 1\nserviceName: api\nresponsibility: x\ninterfaces: []\n",
    };
    agentsReply = () => JSON.stringify({ response: JSON.stringify(plan), model_used: "stub" });
    const r = await app.inject({ method: "POST", url: `/api/projects/${d}/evolution-plan`, payload: {} });   // sem pedido explícito: vale o texto do card
    expect(r.statusCode, r.body).toBe(202);
    const jobId = r.json().jobId as string;
    const finished = await waitFor(async () => ["done", "error"].includes((await pool.query("SELECT status FROM evolution_plan_jobs WHERE id = $1", [jobId])).rows[0]?.status), 8000);
    const jr = (await pool.query("SELECT status, error FROM evolution_plan_jobs WHERE id = $1", [jobId])).rows[0];
    expect(finished && jr.status === "done", JSON.stringify(jr)).toBe(true);
    const job = (await pool.query("SELECT result FROM evolution_plan_jobs WHERE id = $1", [jobId])).rows[0].result as { written: Array<{ path: string; action: string }>; warnings: string[] };
    // o pedido ao arquiteto levou a spec corrente (somente leitura), o texto do card e a regra de escopo
    const raw = JSON.parse(agentsCalls.find((x) => x.url.endsWith("/invoke/raw"))!.body) as { user_message: string };
    expect(raw.user_message).toContain(BASE_MARK);
    expect(raw.user_message).toContain("Quero baixar a lista de entregas em CSV");
    expect(raw.user_message).toContain("ESCOPO DO CARD");
    // grava só RFC/ADR
    expect(job.written.map((w) => w.path).sort()).toEqual(["docs/adr/ADR-001-formato-csv.md", "docs/rfc/RFC-0001-exportar-csv.md"]);
    const tree = await treeOf(d);
    expect(Object.keys(tree).sort()).toEqual(["docs/adr/ADR-001-formato-csv.md", "docs/rfc/RFC-0001-exportar-csv.md", "tickets/TK-0001/request.md"]);
    expect(job.warnings.join(" ")).toContain("NÃO foram gravados");
    expect((await stateOf(c.id)).card_state).toBe("refining");
    // o gate (com o gate por tipo da 2.6) funciona com o rascunho: feature exige Non-goals — o RFC tem
    const ready = await post(s, `/api/cards/${c.id}/ready`);
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json().gate).toMatchObject({ rfcs: 1, kind: "feature" });
    ev("planner", { gravou: job.written.map((w) => w.path), avisos: job.warnings.length });
  });

  it("jornada/veredito: o card_draft não é spec de produto (nem 'já saiu da Bancada') e o /promote do projeto manda para o card", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const v = await evaluateCardDraftPromotability(pool, c.draftProjectId);
    expect(v).toMatchObject({ canPromote: false, reason: "CARD_DRAFT", status: "card_draft", card: { cardId: c.id, state: "ready", promoteVia: `POST /api/cards/${c.id}/promote` } });
    expect(v.message).not.toMatch(/saiu da Bancada|normaliz/i);
    as(s);
    const p = await app.inject({ method: "POST", url: `/api/projects/${c.draftProjectId}/promote` });
    expect(p.statusCode).toBe(409);
    expect(p.json()).toMatchObject({ code: "USE_CARD_PROMOTE", cardId: c.id, cardState: "ready" });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.3 — GAPs / modo autônomo
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const seedRun = async (s: Seed, projectId: string, o: { status: string; file: string; jobId?: string; baseSha?: string; mode?: string }) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO spec_autonomy_runs (id, project_id, tenant_id, owner_user_id, status, round, max_rounds, chat_job_id, base_spec_sha, gaps_initial, gaps_current, deadline_at, mode, current_file, rounds)
       VALUES ($1,$2,$3,$4,$5,1,5,$6,$7,2,2, now() + interval '1 hour', $8, $9, $10::jsonb)`,
      [id, projectId, s.tenantId, s.userId, o.status, o.jobId ?? null, o.baseSha ?? null, o.mode ?? "per_file", o.file,
        JSON.stringify([{ round: 1, pass: 0, startedAt: new Date().toISOString(), filePath: o.file, gapsBefore: 2, blockers: 1, warnings: 1, specChars: 10, note: "seed" }])],
    );
    return id;
  };
  const seedJob = async (s: Seed, projectId: string, filePath: string, revised: string) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO spec_chat_jobs (id, project_id, tenant_id, owner_user_id, kind, file_path, status, spec_markdown, reply, finished_at, collected_at)
       VALUES ($1,$2,$3,$4,'file',$5,'done',$6,'ok', now(), now())`,
      [id, projectId, s.tenantId, s.userId, filePath, revised],
    );
    return id;
  };
  const runStatus = async (id: string) => (await pool.query("SELECT status, last_error, rounds FROM spec_autonomy_runs WHERE id = $1", [id])).rows[0] as { status: string; last_error: string | null; rounds: Array<Record<string, unknown>> };

  it("modo autônomo: o laço respeita a trava a cada rodada, aplica só em arquivo do card e recusa o que está fora do escopo", async () => {
    process.env.SPEC_AUTONOMY = "on";
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(s, d, { compat: "MINOR", nonGoals: true });
    const rfcPath = "docs/rfc/RFC-0001-exportar-csv.md";
    const reqPath = "tickets/TK-0001/request.md";
    // arquivo intruso no rascunho (legado/bug de outra versão do código) — o laço NÃO pode escrevê-lo
    const strayPath = join(UP, d, "docs/arquitetura/visao.md");
    await addDraftFile(s, d, "docs/arquitetura", "visao.md", "# Visão\n\nTexto original do intruso com conteúdo suficiente para a revisão.\n");
    const shaOf = (p: string) => sha256(readFileSync(p));
    const parentBefore = await treeOf(s.parentId);

    // (1) rodada aplicada num arquivo do card: escreve
    const reqFile = join(UP, d, reqPath);
    const reqBefore = readFileSync(reqFile, "utf-8");
    const revised = `${reqBefore}\nAcrescentado pelo CTO: o CSV usa ponto e vírgula e UTF-8.\n`;
    const job1 = await seedJob(s, d, reqPath, revised);
    const run1 = await seedRun(s, d, { status: "applying", file: reqPath, jobId: job1, baseSha: shaOf(reqFile) });
    await advanceAutonomyRun(pool, run1);
    expect(readFileSync(reqFile, "utf-8")).toBe(revised);
    expect((await runStatus(run1)).rounds.at(-1)).toMatchObject({ applied: true });
    await pool.query("UPDATE spec_autonomy_runs SET status = 'stopped', finished_at = now() WHERE id = $1", [run1]);

    // (2) rodada num arquivo fora do escopo: pula o arquivo, nada escrito
    const strayBefore = readFileSync(strayPath, "utf-8");
    const job2 = await seedJob(s, d, "docs/arquitetura/visao.md", `${strayBefore}\nReescrito pelo CTO fora do escopo do card.\n`);
    const run2 = await seedRun(s, d, { status: "applying", file: "docs/arquitetura/visao.md", jobId: job2, baseSha: shaOf(strayPath) });
    await advanceAutonomyRun(pool, run2);
    expect(readFileSync(strayPath, "utf-8")).toBe(strayBefore);
    const r2 = await runStatus(run2);
    expect(JSON.stringify(r2.rounds)).toContain("fora do escopo do card");
    await pool.query("UPDATE spec_autonomy_runs SET status = 'stopped', finished_at = now() WHERE id = $1", [run2]);

    // (3) o card vai a ready no meio do laço: a rodada seguinte PARA (stalled) e não escreve
    const rfcFile = join(UP, d, rfcPath);
    const rfcBefore = readFileSync(rfcFile, "utf-8");
    const job3 = await seedJob(s, d, rfcPath, `${rfcBefore}\nMais um requisito proposto.\n`);
    const run3 = await seedRun(s, d, { status: "applying", file: rfcPath, jobId: job3, baseSha: shaOf(rfcFile) });
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'visao.md'", [d]);   // tira o intruso para o gate
    await pool.query("UPDATE tickets SET card_state = 'refining' WHERE id = $1", [c.id]);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);                                 // ready de verdade (carimbo)
    await advanceAutonomyRun(pool, run3);
    const r3 = await runStatus(run3);
    expect(r3.status).toBe("stalled");
    // Y-23: ao ir a `ready` o card já encerra (stalled) os laços ativos do rascunho; a rodada que ainda chega responde pela trava.
    expect(JSON.stringify(r3.rounds) + (r3.last_error ?? "")).toMatch(/card_draft, card 'ready'|Card validado \(ready\)/);
    expect(readFileSync(rfcFile, "utf-8")).toBe(rfcBefore);

    // (4) iniciar o laço com o card ready: 409 CARD_SPEC_LOCKED (mensagem do card, não 'SPEC_LOCKED' genérico)
    as(s);
    const start = await app.inject({ method: "POST", url: "/api/spec-autonomy", payload: { projectId: d } });
    expect(start.statusCode).toBe(409);
    expect(start.json().code).toBe("CARD_SPEC_LOCKED");
    expect(await treeOf(s.parentId)).toEqual(parentBefore);                  // a árvore herdada nunca muda
    ev("autonomo", { aplicou: "request.md", pulou: "docs/arquitetura/visao.md", travou: r3.status });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.5 — REVALIDAÇÃO ok | stale | conflict
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  /** v2 `accepted` da linhagem (vira o HEAD) com spec e árvore de código próprias; devolve o id. */
  const addV2 = async (s: Seed, o: { spec: Array<{ relDir: string; filename: string; content: string }>; primary?: string }) => {
    const r = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
       VALUES ($1,$2,'App v2','accepted',$3,$4,2,$4) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId],
    );
    const id = r.rows[0].id as string;
    for (const f of o.spec) {
      const fp = join(UP, id, f.relDir, f.filename);
      mkdirSync(join(UP, id, f.relDir), { recursive: true });
      writeFileSync(fp, f.content);
      await pool.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,$2,$3,'text/markdown',$4,$5,$6)`,
        [id, f.filename, fp, f.relDir, f.filename === (o.primary ?? "spec.md") && !f.relDir, sha256(f.content)],
      );
    }
    return id;
  };
  const filesRoot = () => { const d = mkdtempSync(join(tmpdir(), "k1-files-")); tmpDirs.push(d); process.env.PROJECT_FILES_ROOT = d; return d; };
  const writeApps = (root: string, productId: string, projectId: string, files: string[]) => {
    for (const f of files) {
      const p = join(root, productId, projectId, "apps", f);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "// x");
    }
  };

  it("revalidar: ok (base == HEAD) não mexe no card; resultado explícito e repetível", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const r = await post(s, `/api/cards/${c.id}/revalidate`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, result: "ok", rebased: false, reopened: false, card: { state: "ready" }, base: { headProjectId: s.parentId } });
    expect((await eventsOf(c.id)).map((e) => e.to_state)).toEqual(["draft", "ready"]);   // sem evento novo
    expect((await post(s, `/api/cards/${c.id}/revalidate`)).json().result).toBe("ok");
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);          // e o carimbo continua valendo
    // estados sem base a revalidar
    expect((await post(s, `/api/cards/${c.id}/revalidate`)).json()).toMatchObject({ code: "CARD_INVALID_TRANSITION" });
  });

  it("revalidar: stale — o HEAD andou e o RFC segue compatível ⇒ rebaseia (base, HEAD, dono do orçamento), invalida o carimbo e volta a refining", async () => {
    const s = await mk();
    const root = filesRoot();
    const c = await readyCard(s, { rfc: { compat: "MINOR", nonGoals: true, files: ["apps/api/src/deliveries/**", "tests/**"] } });
    const v2 = await addV2(s, { spec: [{ relDir: "", filename: "spec.md", content: `# Spec v2\n\n${BASE_MARK}: prazo de 24h agora.\n` }, { relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo 24h.\n" }] });
    writeApps(root, s.productId, s.parentId, ["api/src/deliveries/list.ts"]);
    writeApps(root, s.productId, v2, ["api/src/deliveries/list.ts", "api/src/deliveries/csv.ts"]);
    // enquanto o card segue na base v1, a promoção recusa (CARD_BASE_STALE) — comportamento da 2.6 preservado
    const stale = await post(s, `/api/cards/${c.id}/promote`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CARD_BASE_STALE", currentHead: v2 });
    // o card já foi devolvido a refining pela promoção; volta a ready para provar a transição da revalidação
    const rv = await post(s, `/api/cards/${c.id}/revalidate`);
    expect(rv.statusCode, rv.body).toBe(200);
    const b = rv.json();
    expect(b).toMatchObject({ ok: true, result: "stale", rebased: true, base: { headProjectId: v2, headVersion: 2, previousHeadProjectId: s.parentId }, card: { state: "refining" } });
    expect(b.reasons.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(["BASE_MOVED", "NEEDS_HUMAN_REVIEW"]));
    expect(b.checks.specDiff.changed).toEqual(expect.arrayContaining(["spec.md", "docs/regras.md"]));
    expect(b.checks.globs.find((g: { glob: string }) => g.glob === "apps/api/src/deliveries/**")).toMatchObject({ matchedNow: true, matchedBefore: true });
    const dr = (await pool.query("SELECT extra, budget_owner_project_id FROM projects WHERE id = $1", [c.draftProjectId])).rows[0];
    expect(dr.extra.card_base).toMatchObject({ head_project_id: v2, head_version: 2 });
    expect(dr.extra.evolution_parent_id).toBe(v2);
    expect(dr.extra.card_ready).toBeUndefined();
    expect(dr.budget_owner_project_id).toBe(s.parentId);                    // orçamento compartilhado com o dono da versão corrente
    // validar de novo contra a base nova e promover → v3
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(201);
    expect(pr.json().versionNumber).toBe(3);
    ev("revalidar-stale", { result: b.result, motivos: b.reasons.map((x: { code: string }) => x.code) });
  });

  it("revalidar: conflict — glob que casava na base anterior some no HEAD novo; ou o RFC cita spec removida ⇒ NÃO rebaseia e devolve a refining", async () => {
    const s = await mk();
    const root = filesRoot();
    const c = await readyCard(s, { rfc: { compat: "MINOR", nonGoals: true, files: ["apps/api/src/deliveries/**"], extra: "- REQ-02 — Respeitar o prazo descrito em docs/regras.md." } });
    const v2 = await addV2(s, { spec: [{ relDir: "", filename: "spec.md", content: "# Spec v2\n\nSem o arquivo de regras.\n" }] });   // docs/regras.md REMOVIDO
    writeApps(root, s.productId, s.parentId, ["api/src/deliveries/list.ts"]);
    writeApps(root, s.productId, v2, ["api/src/entregas/list.ts"]);                                                                   // módulo renomeado
    const rv = await post(s, `/api/cards/${c.id}/revalidate`);
    expect(rv.statusCode, rv.body).toBe(200);
    const b = rv.json();
    expect(b).toMatchObject({ ok: false, result: "conflict", rebased: false, card: { state: "refining" }, base: { headProjectId: v2, previousHeadProjectId: s.parentId } });
    const codes = b.reasons.filter((r: { severity: string }) => r.severity === "conflict").map((r: { code: string }) => r.code).sort();
    expect(codes).toEqual(["GLOB_NO_LONGER_MATCHES", "RFC_REFERENCES_REMOVED_SPEC"]);
    // o ponteiro de base do rascunho continua na v1 (o humano ajusta o RFC antes de rebasear) e o carimbo caiu
    const dr = (await pool.query("SELECT extra FROM projects WHERE id = $1", [c.draftProjectId])).rows[0];
    expect(dr.extra.card_base).toMatchObject({ head_project_id: s.parentId });
    expect(dr.extra.card_ready).toBeUndefined();
    // corrige o RFC (novo módulo, sem citar o arquivo removido) → revalidar vira stale e rebaseia
    const tree = await treeOf(c.draftProjectId);
    as(s);
    const fix = await app.inject({ method: "PUT", url: `/api/projects/${c.draftProjectId}/spec-file?path=docs/rfc/RFC-0001-exportar-csv.md`, payload: { content: rfc({ files: ["apps/api/src/entregas/**"] }), baseSha: tree["docs/rfc/RFC-0001-exportar-csv.md"] } });
    expect(fix.statusCode, fix.body).toBe(200);
    const rv2 = (await post(s, `/api/cards/${c.id}/revalidate`)).json();
    expect(rv2).toMatchObject({ result: "stale", rebased: true, base: { headProjectId: v2 } });
    ev("revalidar-conflict", { motivos: codes, depoisDeCorrigir: rv2.result });
  });

  it("revalidar sem clone em disco: declara que não conferiu os globs (REPO_UNAVAILABLE) e não inventa conflito", async () => {
    const s = await mk();
    process.env.PROJECT_FILES_ROOT = "";
    const c = await readyCard(s);
    await addV2(s, { spec: [{ relDir: "", filename: "spec.md", content: "# v2\n\nigual.\n" }, { relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h para entregas urgentes.\n" }] });
    const b = (await post(s, `/api/cards/${c.id}/revalidate`)).json();
    expect(b.result).toBe("stale");
    expect(b.reasons).toContainEqual(expect.objectContaining({ code: "REPO_UNAVAILABLE", severity: "info" }));
    expect(b.checks.repo.available).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.5 — ORÇAMENTO: o Guard para o filho ⇒ card blocked (nunca failed) ⇒ resume com saldo
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const inFactory = async (s: Seed) => {
    const c = await readyCard(s);
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    const t = await stateOf(c.id);
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [t.child_project_id]);
    await syncCardForChildProject(pool, t.child_project_id!);
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    return { c, child: t.child_project_id! };
  };
  /** o que `pauseForBudget` (Guard) faz: pausa o dono e para o filho em execução com stopped_by = 'budget' */
  const guardPauses = async (ownerId: string, childId: string) => {
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [ownerId]);
    await pool.query("UPDATE projects SET status = 'stopped', stopped_by = 'budget' WHERE id = $1", [childId]);
  };

  it("Guard para o filho (stopped_by='budget') ⇒ card blocked com motivo de orçamento (nunca failed); resume sem saldo = 402; com saldo volta a in_factory", async () => {
    const s = await mk();
    const { c, child } = await inFactory(s);
    await guardPauses(s.parentId, child);
    // a jornada alinha o card ao estado real do filho
    const j = (await get(s, `/api/cards/${c.id}/journey`)).json();
    expect(j).toMatchObject({ state: "blocked", phase: "blocked", blocked: { kind: "budget", resumable: true }, action: { key: "resume" } });
    expect(j.blockers[0]).toMatchObject({ code: "CARD_BUDGET_BLOCKED" });
    expect(j.steps.find((x: { key: string }) => x.key === "in_factory").state).toBe("blocked");
    const t = await stateOf(c.id);
    expect(t).toMatchObject({ card_state: "blocked", status: "promoted" });
    expect(t.blocked_reason).toBe("budget:BUDGET_PAUSED");
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [child])).rows[0].status).toBe("stopped");   // o filho não virou failed
    const evs = await eventsOf(c.id);
    expect(evs.at(-1)).toMatchObject({ to_state: "blocked", actor_kind: "guard", reason: "budget:BUDGET_PAUSED" });
    // resume enquanto o Guard ainda nega: 402, card segue blocked
    const no = await post(s, `/api/cards/${c.id}/resume`);
    expect(no.statusCode).toBe(402);
    expect(no.json()).toMatchObject({ code: "CARD_BUDGET_BLOCKED", guardCode: "BUDGET_PAUSED", cardState: "blocked" });
    expect(no.json().userMessage).toContain("bloqueado por orçamento");
    expect((await stateOf(c.id)).card_state).toBe("blocked");
    // o humano aumenta o orçamento (PUT /budget libera a pausa); resume volta a in_factory e diz que o filho precisa ser religado
    await pool.query("UPDATE projects SET budget_usd = 500, budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    const ok = await post(s, `/api/cards/${c.id}/resume`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, childRestartRequired: true, next: `POST /api/projects/${child}/run`, card: { state: "in_factory" } });
    // sem saldo de novo o card NÃO volta a bloquear sozinho enquanto há saldo (filho parado = espera humana), e repetir o resume é seguro
    await syncCardForChildProject(pool, child);
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    expect((await post(s, `/api/cards/${c.id}/resume`)).json()).toMatchObject({ ok: true, replayed: true });
    ev("orcamento-bloqueio", { eventos: (await eventsOf(c.id)).map((e) => `${e.to_state}:${e.actor_kind}:${e.reason}`) });
  });

  it("reconciliador (EVOLVE_RECONCILER=on) leva a blocked o card cujo filho o Guard parou, e o libera quando o saldo volta; em shadow não toca", async () => {
    const s = await mk();
    const root = filesRoot();
    const { c, child } = await inFactory(s);
    await guardPauses(s.parentId, child);
    const env = { EVOLVE_RECONCILER: "shadow", PROJECT_FILES_ROOT: root, UPLOAD_DIR: UP } as NodeJS.ProcessEnv;
    const pass = async (e: NodeJS.ProcessEnv) => {
      let r = await runReconcilerPass(pool, e);
      for (let i = 0; i < 40 && r.skipped === "locked"; i++) { await new Promise((res) => setTimeout(res, 250)); r = await runReconcilerPass(pool, e); }
      return r;
    };
    const sh = await pass(env);
    expect(sh.cardsSynced).toBeUndefined();
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    const on = await pass({ ...env, EVOLVE_RECONCILER: "on" } as NodeJS.ProcessEnv);
    expect(on.mode).toBe("on");
    expect(on.cardsSynced).toBeGreaterThanOrEqual(1);
    expect(await stateOf(c.id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:BUDGET_PAUSED" });
    await pool.query("UPDATE projects SET budget_usd = 500, budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    expect(await syncCardsWithChildren(pool)).toBeGreaterThanOrEqual(1);
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    expect((await eventsOf(c.id)).map((e) => e.to_state)).toEqual(["draft", "ready", "promoted", "in_factory", "blocked", "in_factory"]);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3.5 — JORNADA e ANEXOS
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("GET /api/cards/:id/journey: etapas, o que bloqueia a próxima e a ação sugerida em cada estado", async () => {
    const s = await mk();
    const c = await create(s, { kind: "feature" });
    const J = async () => (await get(s, `/api/cards/${c.id}/journey`)).json();
    // draft sem RFC: gate pede o RFC → ação = gerar com a IA
    let j = await J();
    expect(j).toMatchObject({ code: "TK-0001", state: "draft", kind: "feature", phase: "editing", current: "draft", next: "refining", action: { key: "generate_rfc", method: "POST", path: `/api/projects/${c.draftProjectId}/evolution-plan`, enabled: true }, spec: { locked: false, canReopen: false } });
    expect(j.steps.map((x: { key: string }) => x.key)).toEqual(["draft", "refining", "ready", "promoted", "in_factory", "delivered"]);
    expect(j.steps.map((x: { label: string }) => x.label)).toEqual(["Rascunho", "Refinando", "Pronto", "Promovido", "Na fábrica", "Entregue"]);
    expect(j.blockers[0]).toMatchObject({ code: "EVOLUTION_RFC_REQUIRED" });
    expect(j.blockers[0].userMessage).toContain("RFC");
    // RFC inválido: bloqueia com o motivo do gate
    await addRfc(s, c.draftProjectId, { files: ["apps/**"] });
    j = await J();
    expect(j.blockers[0].code).toBe("EVOLUTION_RFC_INVALID");
    expect(j.action).toMatchObject({ key: "edit_rfc" });
    // feature sem Non-goals: o gate do tipo
    await addRfc(s, c.draftProjectId, { nonGoals: false });
    expect((await J()).blockers[0].code).toBe("CARD_KIND_REQUIREMENT");
    // RFC ok: pode validar
    await addRfc(s, c.draftProjectId, { nonGoals: true });
    j = await J();
    expect(j).toMatchObject({ blockers: [], action: { key: "ready", path: `/api/cards/${c.id}/ready` }, severity: "success" });
    // ready → promover; spec travada com a opção de reabrir
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    j = await J();
    expect(j).toMatchObject({ state: "ready", phase: "ready", current: "ready", next: "promoted", blockers: [], action: { key: "promote" }, spec: { locked: true, canReopen: true } });
    expect(j.steps.map((x: { state: string }) => x.state)).toEqual(["done", "done", "current", "todo", "todo", "todo"]);
    // base vencida: revalidar
    const v2 = await addV2(s, { spec: [{ relDir: "", filename: "spec.md", content: "# v2\n\nnova.\n" }] });
    j = await J();
    expect(j.blockers.map((b: { code: string }) => b.code)).toContain("CARD_BASE_STALE");
    expect(j).toMatchObject({ action: { key: "revalidate", path: `/api/cards/${c.id}/revalidate` }, base: { stale: true, currentHeadProjectId: v2 } });
    // orçamento negado na ação de promover: sugere aumentar o orçamento (PUT no dono)
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'esgotado' WHERE id = $1", [s.parentId]);
    await pool.query("UPDATE projects SET status = 'archived' WHERE id = $1", [v2]);
    j = await J();
    expect(j.blockers.map((b: { code: string }) => b.code)).toContain("BUDGET_PAUSED");
    expect(j.action).toMatchObject({ key: "increase_budget", method: "PUT", path: `/api/projects/${s.parentId}/budget` });
    await pool.query("UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1", [s.parentId]);
    // promovido / na fábrica / entregue
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    const t = await stateOf(c.id);
    j = await J();
    expect(j).toMatchObject({ state: "promoted", phase: "running", current: "promoted", next: "in_factory", execution: { childProjectId: t.child_project_id } });
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [t.child_project_id]);
    await syncCardForChildProject(pool, t.child_project_id!);
    j = await J();
    expect(j).toMatchObject({ state: "in_factory", current: "in_factory", next: "delivered", execution: { status: "running" } });
    expect(j.blockers[0].code).toBe("CARD_CHILD_NOT_ACCEPTED");
    expect(j.steps.map((x: { state: string }) => x.state)).toEqual(["done", "done", "done", "done", "current", "todo"]);
    // recusado fora da trilha
    const r = await create(s);
    expect((await post(s, `/api/cards/${r.id}/reject`)).statusCode).toBe(200);
    expect(await (async () => (await get(s, `/api/cards/${r.id}/journey`)).json())()).toMatchObject({ phase: "rejected", current: null, next: null, headline: "Card recusado" });
    // outro tenant: 404
    const other = await mk();
    expect((await get(other, `/api/cards/${c.id}/journey`)).statusCode).toBe(404);
    ev("jornada", { etapas: j.steps.length });
  });

  it("GET /api/cards/:id/attachments: lista com o estado da conversão (disabled / pending / done / failed)", async () => {
    const s = await mk();
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENTS_STRICT', '1', $1)", [s.tenantId]);
    const BOUNDARY = "----k1f3";
    const part = (name: string, filename: string, body: Buffer) => Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), body, Buffer.from("\r\n"),
    ]);
    const fields = (o: Record<string, string>) => Buffer.concat(Object.entries(o).map(([k, v]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)));
    const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
    const payload = Buffer.concat([fields({ kind: "feature", title: "Com anexos", body: "Veja os anexos." }), part("files", "regra.txt", Buffer.from("regra: ponto e vírgula\n")), part("files", "contrato.pdf", PDF), Buffer.from(`--${BOUNDARY}--\r\n`)]);
    as(s);
    const created = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }, payload });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    let l = (await get(s, `/api/cards/${id}/attachments`)).json();
    const byName = (n: string) => l.items.find((x: { filename: string }) => x.filename === n);
    expect(l.strict).toBe(true);
    expect(l.items.length).toBe(2);
    expect(byName("regra.txt")).toMatchObject({ kind: "spec_text", conversion: { state: "not_applicable" }, downloadUrl: `/api/cards/${id}/attachments/${byName("regra.txt").id}` });
    expect(byName("contrato.pdf")).toMatchObject({ kind: "card_only", conversion: { state: "disabled" } });
    // conversão ligada: sem linha na fila = queued; com linhas da fila: pending / failed (erro claro) / done (derivado)
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENT_CONVERSION', '1', $1)", [s.tenantId]);
    l = (await get(s, `/api/cards/${id}/attachments`)).json();
    expect(l.conversionEnabled).toBe(true);
    expect(byName("contrato.pdf").conversion.state).toBe("queued");
    const pdfId = byName("contrato.pdf").id as string;
    const sha = byName("contrato.pdf").contentSha256 as string;
    await pool.query("INSERT INTO attachment_conversions (attachment_id, content_sha256, status) VALUES ($1,$2,'pending')", [pdfId, sha]);
    expect(byName("contrato.pdf").conversion.state).toBe("queued");   // (cache do objeto antigo — relê abaixo)
    l = (await get(s, `/api/cards/${id}/attachments`)).json();
    expect(byName("contrato.pdf").conversion.state).toBe("pending");
    await pool.query("UPDATE attachment_conversions SET status = 'failed', error_code = 'NO_TEXT_LAYER', error_message = 'sem camada de texto', attempts = 3 WHERE attachment_id = $1", [pdfId]);
    l = (await get(s, `/api/cards/${id}/attachments`)).json();
    expect(byName("contrato.pdf").conversion).toMatchObject({ state: "failed", errorCode: "NO_TEXT_LAYER", errorMessage: "sem camada de texto", attempts: 3 });
    expect(l.summary).toMatchObject({ failed: 1, not_applicable: 1 });
    ev("anexos", { resumo: l.summary });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // FLAG OFF — byte a byte
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("CARDS_BANCADA off: as rotas novas respondem 404 exatamente como as antigas (sem userMessage) e os escritores de projeto comum não mudam", async () => {
    const s = await mk({ flag: false });
    const t = await seedTicket(pool, s);
    const NA = { code: "NOT_FOUND", message: "Recurso indisponível" };
    for (const [m, u] of [["GET", `/api/cards/${t.id}/journey`], ["GET", `/api/cards/${t.id}/attachments`], ["POST", `/api/cards/${t.id}/reopen`], ["POST", `/api/cards/${t.id}/revalidate`], ["POST", `/api/cards/${t.id}/resume`]] as const) {
      as(s);
      const r = await app.inject({ method: m, url: u });
      expect(r.statusCode, `${m} ${u}`).toBe(404);
      expect(r.json(), `${m} ${u}`).toEqual(NA);
    }
    // escritores do projeto COMUM (a versão corrente): mesmas respostas com a flag off e on (cada um no seu tenant)
    const on = await mk({ flag: true });
    const run = async (x: Seed) => {
      as(x);
      const out: string[] = [];
      const n = (b: string) => b.replaceAll(x.parentId, "<P>").replaceAll(x.tenantId, "<T>");
      for (const [m, u, p] of [
        ["PUT", `/api/projects/${x.parentId}/spec-file?path=spec.md`, { content: "novo", baseSha: "x" }],
        ["POST", `/api/projects/${x.parentId}/spec-file`, { path: "README.md", content: "# x" }],
        ["PATCH", `/api/projects/${x.parentId}/spec-content`, { specMarkdown: "# novo" }],
        ["POST", `/api/projects/${x.parentId}/evolution-plan`, { request: "x" }],
        ["POST", `/api/projects/${x.parentId}/connect-declaration`, {}],
      ] as const) {
        const r = await app.inject({ method: m, url: u, payload: p });
        out.push(`${m} ${r.statusCode} ${n(r.body)}`);
      }
      return out;
    };
    expect(await run(on)).toEqual(await run(s));
    ev("flag-off", { rotasNovas404: 5 });
  });

  it("flag off DEPOIS de existir rascunho: a trava e o escopo continuam valendo (consistência de dados), as rotas de card somem", async () => {
    const s = await mk();
    const c = await readyCard(s);
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
    as(s);
    expect((await app.inject({ method: "GET", url: `/api/cards/${c.id}/journey` })).statusCode).toBe(404);
    const r = await app.inject({ method: "PUT", url: `/api/projects/${c.draftProjectId}/spec-file?path=tickets/TK-0001/request.md`, payload: { content: "x", baseSha: "y" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("CARD_SPEC_LOCKED");
  });
});
