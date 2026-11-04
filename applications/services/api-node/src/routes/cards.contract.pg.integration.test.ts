/**
 * Teste de CONTRATO dos cards (Fase 3, frente K3): percorre o ciclo inteiro pelas rotas REAIS em Postgres efêmero
 * (criar → refinar → pronto → travado → reabrir → revalidar → promover → bloqueado por orçamento → retomado → entregue /
 * rejeitado) e grava cada resposta (status, `Retry-After` quando houver, corpo normalizado) em
 * `applications/apps/genesis-web/lib/cards/__contract__/*.json`. O portal consome essas fixtures nos testes dele (tipos e
 * validador em `lib/cards/schemas.ts`), então backend e portal não voltam a divergir sem que um teste quebre.
 *
 * Dois modos:
 *   • `CONTRACT_GEN=1` (npm run contract:gen) — REGRAVA as fixtures;
 *   • sem a variável (suíte normal) — COMPARA a resposta de hoje com a fixture versionada e falha se o contrato mudou
 *     (a mensagem diz para rodar `npm run contract:gen` e revisar o diff no portal).
 * LLM/agents sempre STUBS. Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, sha256, type Seed,
} from "../testing/evolvePg.js";

const UP = vi.hoisted(() => {
  const d = `/tmp/k3-upload-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = d;
  return d;
});

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
vi.mock("./specs.js", async (orig) => ({
  ...(await orig<typeof import("./specs.js")>()),
  httpPost: async () => "{}",
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
import { syncCardForChildProject } from "../services/cardPromote.js";
import { transitionCard } from "../services/cardState.js";
import { CARD_ERRORS } from "../services/cardErrors.js";
import { cardReadyTestHooks, specHashOf } from "../services/cardService.js";
import { randomUUID } from "crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = resolve(HERE, "../../../../apps/genesis-web/lib/cards/__contract__");
const GEN = process.env.CONTRACT_GEN === "1";

// ── Normalização: ids, datas, hashes e caminhos de /tmp viram placeholders estáveis (por fixture) ──
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA = /\b[0-9a-f]{64}\b/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const TMP = /\/tmp\/[A-Za-z0-9_./-]+/g;
export function normalize(value: unknown): unknown {
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
  text = text.replace(ISO, "2026-11-04T12:00:00.000Z").replace(TMP, "<tmp>").replace(/App [a-z0-9]{8,}/g, "App Demo");
  return JSON.parse(text);
}

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

describePg("Contrato dos cards — respostas reais gravadas como fixtures do portal", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const tmpDirs: string[] = [UP];
  const written: string[] = [];
  const envBackup = { API_AGENTS_URL: process.env.API_AGENTS_URL, PROJECT_FILES_ROOT: process.env.PROJECT_FILES_ROOT };

  beforeAll(async () => {
    mkdirSync(UP, { recursive: true });
    pool = await openPg();
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes, specFileRoutes, specChatRoutes, evolutionPlanRoutes, specAutonomyRoutes, connectDeclarationRoutes, pipelineRoutes]);
    if (GEN) mkdirSync(CONTRACT_DIR, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    if (GEN) {
      writeFileSync(join(CONTRACT_DIR, "error-codes.json"), JSON.stringify(Object.fromEntries(Object.entries(CARD_ERRORS).map(([k, v]) => [k, { ...v }])), null, 2) + "\n");
      writeFileSync(join(CONTRACT_DIR, "index.json"), JSON.stringify([...new Set(written)].sort(), null, 2) + "\n");
    }
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool?.end();
  });
  beforeEach(() => { process.env.API_AGENTS_URL = "http://agents.local"; });
  afterEach(() => { vi.unstubAllEnvs(); });

  type Res = Awaited<ReturnType<FastifyInstance["inject"]>>;
  /** Grava (GEN) ou confere (modo normal) a fixture `name` com a resposta real. Devolve o corpo (sem normalizar) para o fluxo seguir. */
  const rec = (name: string, request: string, res: Res, expectStatus?: number) => {
    if (expectStatus !== undefined) expect(res.statusCode, `${name}: ${res.body}`).toBe(expectStatus);
    let body: unknown = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    const retryAfter = res.headers["retry-after"];
    const fixture = {
      request, status: res.statusCode,
      ...(retryAfter ? { headers: { "retry-after": String(retryAfter) } } : {}),
      body: normalize(body),
    };
    written.push(name);
    const file = join(CONTRACT_DIR, `${name}.json`);
    const text = JSON.stringify(fixture, null, 2) + "\n";
    if (GEN) writeFileSync(file, text);
    else {
      expect(existsSync(file), `fixture ${name}.json ausente: rode \`npm run contract:gen\` no api-node e revise o diff no portal`).toBe(true);
      expect(fixture, `o contrato de ${name} mudou: rode \`npm run contract:gen\`, revise o diff e adapte o portal`).toEqual(JSON.parse(readFileSync(file, "utf-8")));
    }
    return body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const as = (s: Seed, role = "tenant_admin") => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId });
  const flagOn = (tenantId: string) => pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [tenantId]);
  const mk = async (o: { budgetUsd?: number | null; flag?: boolean; withAdr?: boolean } = {}) => {
    const s = await seedAcceptedProduct(pool, {
      budgetUsd: o.budgetUsd === undefined ? 50 : o.budgetUsd,
      specContent: "# Spec do pai\n\nO app lista entregas. Prazo de 48h.\n",
      extraFiles: [
        { relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h para entregas urgentes.\n" },
        // AC (AB-04): versão corrente com RFC/ADR herdados, para as recusas por colisão com a base
        ...(o.withAdr ? [
          { relDir: "docs/adr", filename: "ADR-001-formato.md", content: "# ADR-001 — Formato\n\nDecisão herdada da versão corrente.\n" },
          { relDir: "docs/rfc", filename: "RFC-0004-legado.md", content: "# RFC-0004 — Legado\n\nRFC histórico da versão corrente.\n" },
        ] : []),
      ],
    });
    seeds.push(s);
    process.env.UPLOAD_DIR = UP;
    if (o.flag !== false) await flagOn(s.tenantId);
    as(s);
    return s;
  };
  const req = (s: Seed, method: string, url: string, payload?: unknown) => { as(s); return app.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) }); };
  const get = (s: Seed, url: string) => req(s, "GET", url);
  const post = (s: Seed, url: string, payload?: unknown) => req(s, "POST", url, payload);
  const createRaw = (s: Seed, o: { kind?: string; title?: string; body?: string } = {}) =>
    post(s, `/api/products/${s.productId}/cards`, { kind: o.kind ?? "feature", title: o.title ?? "Exportar entregas em CSV", body: o.body ?? "Quero baixar a lista de entregas em CSV." });
  const create = async (s: Seed, o: { kind?: string; title?: string; body?: string } = {}) => {
    const r = await createRaw(s, o);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; code: string; draftProjectId: string; state: string };
  };
  const addDraftFile = async (draftId: string, relDir: string, filename: string, content: string) => {
    const dir = join(UP, draftId, relDir);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, filename);
    writeFileSync(fp, content, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1,$2,$3,'text/markdown',$4,false,$5) ON CONFLICT (project_id, rel_dir, filename) DO UPDATE SET file_path = EXCLUDED.file_path, content_sha256 = EXCLUDED.content_sha256`,
      [draftId, filename, fp, relDir, sha256(content)],
    );
  };
  const addRfc = (draftId: string, o: Parameters<typeof rfc>[0] = {}) => addDraftFile(draftId, "docs/rfc", `RFC-${String(o.n ?? 1).padStart(4, "0")}-exportar-csv.md`, rfc(o));
  const stateOf = async (id: string) => (await pool.query("SELECT card_state, status, child_project_id, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0] as
    { card_state: string; status: string; child_project_id: string | null; blocked_reason: string | null };
  const readyCard = async (s: Seed) => {
    const c = await create(s);
    await addRfc(c.draftProjectId);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    return c;
  };
  const addV2 = async (s: Seed) => {
    const r = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
       VALUES ($1,$2,'App v2','accepted',$3,$4,2,$4) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId],
    );
    const id = r.rows[0].id as string;
    const content = "# Spec v2\n\nPrazo de 24h agora.\n";
    const fp = join(UP, id, "spec.md");
    mkdirSync(join(UP, id), { recursive: true });
    writeFileSync(fp, content);
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,'spec.md',$2,'text/markdown','',true,$3)`,
      [id, fp, sha256(content)],
    );
    return id;
  };
  const filesRoot = () => { const d = mkdtempSync(join(tmpdir(), "k3-files-")); tmpDirs.push(d); process.env.PROJECT_FILES_ROOT = d; return d; };
  const BOUNDARY = "----k3contract";
  const part = (filename: string, body: Buffer) => Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), body, Buffer.from("\r\n"),
  ]);
  const fields = (o: Record<string, string>) => Buffer.concat(Object.entries(o).map(([k, v]) => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)));
  const multipart = (s: Seed, f: Record<string, string>, files: Array<[string, Buffer]>) => {
    as(s);
    return app.inject({
      method: "POST", url: `/api/products/${s.productId}/cards`, headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([fields(f), ...files.map(([n, b]) => part(n, b)), Buffer.from(`--${BOUNDARY}--\r\n`)]),
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("ciclo feliz: capacidades, criar, listar, jornada e detalhe em cada estado, refinar, validar, travar, reabrir, promover, entregar", async () => {
    const s = await mk();
    rec("capabilities.on", "GET /api/products/:productId/cards/capabilities", await get(s, `/api/products/${s.productId}/cards/capabilities`), 200);

    const created = rec("create.201", "POST /api/products/:productId/cards", await createRaw(s), 201);
    const c = { id: created.id as string, draftProjectId: created.draftProjectId as string };
    rec("detail.draft", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    // draft sem RFC: o gate pede o RFC; com RFC inválido, outro bloqueio; com RFC ok, pode validar
    rec("journey.draft-no-rfc", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    await addRfc(c.draftProjectId, { files: ["apps/**"] });
    rec("journey.draft-rfc-invalid", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    await addRfc(c.draftProjectId, { nonGoals: false });
    rec("journey.draft-kind-requirement", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("ready.409-kind-requirement", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 409);
    await addRfc(c.draftProjectId);
    rec("journey.draft-ready-to-validate", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);

    rec("refine.200", "POST /api/cards/:id/refine", await post(s, `/api/cards/${c.id}/refine`), 200);
    rec("detail.refining", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.refining", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("patch.200", "PATCH /api/cards/:id", await req(s, "PATCH", `/api/cards/${c.id}`, { title: "Exportar entregas em CSV (v2)" }), 200);

    rec("ready.200", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 200);
    rec("detail.ready", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.ready", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("base-spec.200", "GET /api/cards/:id/base-spec", await get(s, `/api/cards/${c.id}/base-spec`), 200);

    // travado: PATCH e escritor de spec recusam com CARD_SPEC_LOCKED
    rec("patch.409-spec-locked", "PATCH /api/cards/:id", await req(s, "PATCH", `/api/cards/${c.id}`, { body: "texto novo" }), 409);
    rec("spec-write.409-card-spec-locked", "PUT /api/projects/:draftId/spec-file", await req(s, "PUT", `/api/projects/${c.draftProjectId}/spec-file?path=tickets/TK-0001/request.md`, { content: "novo", baseSha: "x" }), 409);
    rec("delete.409-not-deletable", "DELETE /api/cards/:id", await req(s, "DELETE", `/api/cards/${c.id}`), 409);
    rec("revalidate.ok", "POST /api/cards/:id/revalidate", await post(s, `/api/cards/${c.id}/revalidate`), 200);

    // reabrir (ready → refining), repetir (replayed), validar de novo
    rec("reopen.200", "POST /api/cards/:id/reopen", await post(s, `/api/cards/${c.id}/reopen`), 200);
    rec("reopen.200-replayed", "POST /api/cards/:id/reopen", await post(s, `/api/cards/${c.id}/reopen`), 200);
    rec("promote.409-not-ready", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 409);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);

    // promover, repetir (replayed), jornada nos estados seguintes
    rec("promote.201", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 201);
    rec("promote.200-replayed", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 200);
    rec("detail.promoted", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.promoted", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("reopen.409-invalid-transition", "POST /api/cards/:id/reopen", await post(s, `/api/cards/${c.id}/reopen`), 409);
    rec("spec-write.409-card-spec-locked-promoted", "PUT /api/projects/:draftId/spec-file", await req(s, "PUT", `/api/projects/${c.draftProjectId}/spec-file?path=tickets/TK-0001/request.md`, { content: "novo", baseSha: "x" }), 409);

    const t = await stateOf(c.id);
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [t.child_project_id]);
    await syncCardForChildProject(pool, t.child_project_id!);
    rec("detail.in_factory", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.in_factory", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);

    // entregue: filho aceito + PR
    await pool.query("UPDATE projects SET status = 'accepted', extra = COALESCE(extra,'{}'::jsonb) || jsonb_build_object('evolution_pr_url', 'https://github.com/zentriz-demo/entregas/pull/42') WHERE id = $1", [t.child_project_id]);
    const d = await transitionCard(pool, { ticketId: c.id, to: "delivered", actorKind: "system", reason: "child_accepted_pr_merged" });
    expect(d.kind).toBe("applied");
    rec("detail.delivered", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.delivered", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);

    // listagem com filtros e paginação (cards em vários estados)
    await create(s, { kind: "fix", title: "Corrigir o CSV vazio" });
    await create(s, { kind: "evolution", title: "Evoluir os filtros" });
    rec("list.all", "GET /api/products/:productId/cards", await get(s, `/api/products/${s.productId}/cards`), 200);
    rec("list.filtered-page", "GET /api/products/:productId/cards?state=draft,refining&kind=fix&limit=1&offset=0", await get(s, `/api/products/${s.productId}/cards?state=draft,refining&kind=fix&limit=1&offset=0`), 200);
    rec("list.400-invalid-state", "GET /api/products/:productId/cards?state=xx", await get(s, `/api/products/${s.productId}/cards?state=xx`), 400);
  }, 120_000);

  it("rejeitado, excluído, erros de criação e de estado", async () => {
    const s = await mk();
    const c = await create(s);
    rec("reject.200", "POST /api/cards/:id/reject", await post(s, `/api/cards/${c.id}/reject`), 200);
    rec("detail.rejected", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("journey.rejected", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("patch.409-not-editable", "PATCH /api/cards/:id", await req(s, "PATCH", `/api/cards/${c.id}`, { body: "x" }), 409);
    rec("ready.409-invalid-transition", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 409);

    const d = await create(s, { title: "Para excluir" });
    const del = await req(s, "DELETE", `/api/cards/${d.id}`);
    rec("delete.204", "DELETE /api/cards/:id", del, 204);

    rec("create.400-bad-request", "POST /api/products/:productId/cards", await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", title: "sem corpo", body: "" }), 400);
    rec("get.404-not-found", "GET /api/cards/:id", await get(s, "/api/cards/00000000-0000-4000-8000-0000000000ff"), 404);

    // RFC ausente ao validar
    const e = await create(s);
    rec("ready.409-rfc-required", "POST /api/cards/:id/ready", await post(s, `/api/cards/${e.id}/ready`), 409);

    // RFC inválido e gates por tipo (correção)
    const inv = await create(s, { title: "RFC inválido" });
    await addRfc(inv.draftProjectId, { files: ["apps/**"] });
    rec("ready.409-rfc-invalid", "POST /api/cards/:id/ready", await post(s, `/api/cards/${inv.id}/ready`), 409);
    const fx = await create(s, { kind: "fix", title: "Corrigir CSV" });
    await addRfc(fx.draftProjectId, { compat: "MINOR" });
    rec("ready.409-kind-mismatch", "POST /api/cards/:id/ready", await post(s, `/api/cards/${fx.id}/ready`), 409);
    await addRfc(fx.draftProjectId, { compat: "PATCH" });
    rec("ready.409-kind-requirement-fix", "POST /api/cards/:id/ready", await post(s, `/api/cards/${fx.id}/ready`), 409);

    // escopo de escrita
    rec("spec-write.400-path-out-of-scope", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${e.draftProjectId}/spec-file`, { path: "spec.md", content: "# x" }), 400);

    // /evolve legado com ticket-card
    rec("legacy-evolve.409-use-card-promote", "POST /api/projects/:id/evolve", await post(s, `/api/projects/${s.parentId}/evolve`, { ticketId: e.id }), 409);

    // outro tenant: 404; flag off: 404 sem userMessage
    const other = await mk();
    rec("get.404-other-tenant", "GET /api/cards/:id", await get(other, `/api/cards/${e.id}`), 404);
    const off = await mk({ flag: false });
    rec("capabilities.off", "GET /api/products/:productId/cards/capabilities", await get(off, `/api/products/${off.productId}/cards/capabilities`), 200);
    rec("create.404-flag-off", "POST /api/products/:productId/cards", await createRaw(off), 404);
  }, 120_000);

  it("orçamento: criação sem orçamento, validação com Guard pausado e saldo abaixo do mínimo, promoção negada", async () => {
    const none = await mk({ budgetUsd: null });
    rec("create.402-budget-missing", "POST /api/products/:productId/cards", await createRaw(none), 402);

    const s = await mk();
    const c = await create(s);
    await addRfc(c.draftProjectId);
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    rec("ready.402-budget-paused", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 402);
    rec("journey.draft-budget-paused", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    await pool.query("UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL, budget_usd = 3 WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    rec("ready.402-budget-free-below-min", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 402);
    await pool.query("UPDATE projects SET budget_usd = 50 WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);

    // pronto → Guard pausa → jornada pede aumentar o orçamento; promover é negado (402)
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    rec("journey.ready-budget-paused", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("promote.402-budget-paused", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 402);
    await pool.query("UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);

    // promovido e em execução; o Guard para o filho ⇒ blocked por orçamento; retomar sem saldo = 402; com saldo = 200 (reiniciar o filho)
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    const t = await stateOf(c.id);
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [t.child_project_id]);
    await syncCardForChildProject(pool, t.child_project_id!);
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    await pool.query("UPDATE projects SET status = 'stopped', stopped_by = 'budget' WHERE id = $1", [t.child_project_id]);
    rec("journey.blocked-budget", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("detail.blocked", "GET /api/cards/:id", await get(s, `/api/cards/${c.id}`), 200);
    rec("resume.402-budget-still-blocked", "POST /api/cards/:id/resume", await post(s, `/api/cards/${c.id}/resume`), 402);
    await pool.query("UPDATE projects SET budget_usd = 500, budget_paused_at = NULL, budget_paused_reason = NULL WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    rec("resume.200-child-restart-required", "POST /api/cards/:id/resume", await post(s, `/api/cards/${c.id}/resume`), 200);
    rec("resume.200-replayed", "POST /api/cards/:id/resume", await post(s, `/api/cards/${c.id}/resume`), 200);
  }, 120_000);

  it("base vencida: promover, revalidar (stale e conflict); promoção em andamento com Retry-After", async () => {
    const s = await mk();
    filesRoot();
    const c = await readyCard(s);
    // conflict: o RFC cita docs/regras.md (existe na base v1) e o HEAD novo não o tem mais
    const k = await create(s, { title: "Card com conflito" });
    await addRfc(k.draftProjectId, { files: ["apps/api/src/deliveries/**"], extra: "- REQ-02 — Respeitar o prazo descrito em docs/regras.md." });
    expect((await post(s, `/api/cards/${k.id}/ready`)).statusCode).toBe(200);
    await addV2(s);
    rec("journey.ready-base-stale", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
    rec("promote.409-base-stale", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 409);
    rec("revalidate.stale", "POST /api/cards/:id/revalidate", await post(s, `/api/cards/${c.id}/revalidate`), 200);
    const rv = await post(s, `/api/cards/${k.id}/revalidate`);
    rec("revalidate.conflict", "POST /api/cards/:id/revalidate", rv, 200);

    // promoção em andamento (outra requisição materializa): 409 MATERIALIZATION_IN_PROGRESS + Retry-After
    const s2 = await mk();
    const m = await readyCard(s2);
    expect((await post(s2, `/api/cards/${m.id}/promote`)).statusCode).toBe(201);
    const t = await stateOf(m.id);
    await pool.query(
      `UPDATE projects SET status = 'materializing', extra = jsonb_set(COALESCE(extra,'{}'::jsonb), '{materialization}', jsonb_build_object('lease_until', to_char(now() + interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id = $1`,
      [t.child_project_id],
    );
    rec("promote.409-materialization-in-progress", "POST /api/cards/:id/promote", await post(s2, `/api/cards/${m.id}/promote`), 409);
  }, 120_000);

  it("anexos: lista com o estado da conversão, detalhe com anexos, recusas", async () => {
    const s = await mk();
    rec("create.409-attachments-unavailable", "POST /api/products/:productId/cards (multipart)", await multipart(s, { kind: "feature", title: "Com anexo", body: "Veja o anexo." }, [["regra.txt", Buffer.from("regra\n")]]), 409);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENTS_STRICT', '1', $1)", [s.tenantId]);
    rec("create.400-attachment-invalid", "POST /api/products/:productId/cards (multipart)", await multipart(s, { kind: "feature", title: "Com anexo", body: "Veja o anexo." }, [["virus.exe", Buffer.from("MZ")]]), 400);
    const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
    const created = await multipart(s, { kind: "feature", title: "Com anexos", body: "Veja os anexos." }, [["regra.txt", Buffer.from("regra: ponto e vírgula\n")], ["contrato.pdf", PDF]]);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    rec("detail.with-attachments", "GET /api/cards/:id", await get(s, `/api/cards/${id}`), 200);
    rec("attachments.list-conversion-disabled", "GET /api/cards/:id/attachments", await get(s, `/api/cards/${id}/attachments`), 200);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENT_CONVERSION', '1', $1)", [s.tenantId]);
    const l = (await get(s, `/api/cards/${id}/attachments`)).json();
    const pdf = l.items.find((x: { filename: string }) => x.filename === "contrato.pdf");
    await pool.query("INSERT INTO attachment_conversions (attachment_id, content_sha256, status, attempts, error_code, error_message) VALUES ($1,$2,'failed',3,'NO_TEXT_LAYER','sem camada de texto')", [pdf.id, pdf.contentSha256]);
    rec("attachments.list-conversion-failed", "GET /api/cards/:id/attachments", await get(s, `/api/cards/${id}/attachments`), 200);
    const first = l.items.find((x: { filename: string }) => x.filename === "regra.txt");
    const dl = await get(s, `/api/cards/${id}/attachments/${first.id}`);
    expect(dl.statusCode).toBe(200);
  }, 120_000);

  it("AC / AB-04: códigos de erro novos — colisão com a base, conversão pendente, spec mudou, papel, id inválido, USE_CARD_DELETE e USE_CARDS", async () => {
    const s = await mk({ withAdr: true });
    // (1) escrita no caminho/número que a versão corrente já tem
    const c = await create(s);
    const d = c.draftProjectId;
    rec("spec-write.409-path-collides-base", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/adr/ADR-001-formato.md", content: "# ADR-001 — reescrito\n" }), 409);
    rec("spec-write.409-number-collides-base", "POST /api/projects/:draftId/spec-file", await post(s, `/api/projects/${d}/spec-file`, { path: "docs/rfc/RFC-0004-outro-nome.md", content: rfc({ n: 4 }) }), 409);
    // id de projeto fora da forma canônica
    rec("spec-write.400-invalid-id", "POST /api/projects/:id/spec-file", await post(s, `/api/projects/${d.replace(/-/g, "")}/spec-file`, { path: "tickets/TK-0001/x.md", content: "x" }), 400);
    // rascunho não se apaga pela rota de projeto
    rec("project-delete.409-use-card-delete", "DELETE /api/projects/:draftId", await req(s, "DELETE", `/api/projects/${d}`), 409);

    // (2) 'Validar': arquivo que escapou da escrita, conversão pendente e spec que muda no meio
    await addDraftFile(d, "docs/adr", "ADR-001-formato.md", "# ADR-001 — reescrito pelo card\n");
    await addRfc(d, { n: 5 });
    rec("ready.409-path-collides-base", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 409);
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'ADR-001-formato.md'", [d]);
    const pdfDir = join(UP, "att", c.id);
    mkdirSync(pdfDir, { recursive: true });
    const pdf = join(pdfDir, "contrato.pdf");
    writeFileSync(pdf, "%PDF-1.4 fake");
    const att = (await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin)
       VALUES ($1,'contrato.pdf',$2,'application/pdf',13,$3,'card_only','upload') RETURNING id`, [c.id, pdf, sha256("%PDF-1.4 fake")])).rows[0].id as string;
    await pool.query("INSERT INTO attachment_conversions (attachment_id, content_sha256, status) VALUES ($1,$2,'pending')", [att, sha256("%PDF-1.4 fake")]);
    rec("ready.409-conversion-pending", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 409);
    await pool.query("UPDATE attachment_conversions SET status = 'empty' WHERE attachment_id = $1", [att]);
    cardReadyTestHooks.afterSnapshot = async () => { await addDraftFile(d, "docs", "nota-na-janela.md", "# Nota\n\nEscrita entre a leitura e o carimbo.\n"); };
    try {
      rec("ready.409-spec-changed", "POST /api/cards/:id/ready", await post(s, `/api/cards/${c.id}/ready`), 409);
    } finally { cardReadyTestHooks.afterSnapshot = undefined; }
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'nota-na-janela.md'", [d]);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);

    // (3) papéis: user não autor e conta de gestão não promovem
    const mkUser = async (role: string) => (await pool.query(`INSERT INTO users (email, name, role, tenant_id) VALUES ($1,'u',$2,$3) RETURNING id`, [`r-${randomUUID()}@x.test`, role, s.tenantId])).rows[0].id as string;
    Object.assign(testUser, { id: await mkUser("user"), role: "user", tenantId: s.tenantId });
    rec("promote.403-not-allowed", "POST /api/cards/:id/promote", await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` }), 403);
    Object.assign(testUser, { id: await mkUser("user"), role: "zentriz_admin", tenantId: s.tenantId });
    rec("promote.403-zentriz-admin", "POST /api/cards/:id/promote", await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` }), 403);

    // (4) carimbo válido + colisão que escapou: o claim recusa e o card volta a refining
    await addDraftFile(d, "docs/adr", "ADR-001-formato.md", "# ADR-001 — reescrito depois do ready\n");
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{card_ready,draft_spec_hash}', to_jsonb($2::text)) WHERE id = $1`, [d, await specHashOf(pool, d)]);
    rec("promote.409-path-collides-base", "POST /api/cards/:id/promote", await post(s, `/api/cards/${c.id}/promote`), 409);

    // (5) flag ligada: pedidos fora da máquina de cards
    rec("legacy-evolve.409-use-cards", "POST /api/projects/:id/evolve", await post(s, `/api/projects/${s.parentId}/evolve`, { request: "evoluir direto" }), 409);
    rec("legacy-ticket-create.409-use-cards", "POST /api/products/:productId/tickets", await post(s, `/api/products/${s.productId}/tickets`, { title: "legado", body: "pedido legado" }), 409);
  }, 120_000);

  it("AC / AB-04: jornada com o bloqueador 'globs não conferidos' (base andou, sem clone para conferir)", async () => {
    const s = await mk();
    filesRoot();
    const c = await readyCard(s);
    await addV2(s);
    rec("revalidate.stale-globs-unverified", "POST /api/cards/:id/revalidate", await post(s, `/api/cards/${c.id}/revalidate`), 200);
    rec("journey.ready-globs-unverified", "GET /api/cards/:id/journey", await get(s, `/api/cards/${c.id}/journey`), 200);
  }, 120_000);
});
