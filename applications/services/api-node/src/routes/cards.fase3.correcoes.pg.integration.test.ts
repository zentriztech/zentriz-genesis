/**
 * Correções do BACKEND da revisão adversarial da Fase 3 (relatório Y → frente Z), em Postgres REAL (efêmero).
 * As sondas P1 (id não canônico), P2 (DELETE do rascunho), P3 (papéis), P4 (corrida ready × DELETE do RFC), P5 (promote perdedor) e P6
 * (ADR herdado) da revisão viram testes aqui, junto com Y-07, Y-08, Y-09, Y-10, Y-13, Y-14, Y-16, Y-21 e Y-22.
 * LLM/agents sempre STUBS. Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, childrenOf, sha256, type Seed,
} from "../testing/evolvePg.js";

// `specFiles.ts` e `evolutionPlanner.ts` leem UPLOAD_DIR UMA vez, no import: o diretório precisa existir ANTES dos imports.
const UP = vi.hoisted(() => {
  const d = `/tmp/z1-upload-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = d;
  return d;
});

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

let agentsCalls: Array<{ url: string; body: string }> = [];
vi.mock("./specs.js", async (orig) => ({
  ...(await orig<typeof import("./specs.js")>()),
  httpPost: async (url: string, body: string) => { agentsCalls.push({ url, body }); return "{}"; },
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
import { runtimeConfigRoutes } from "./runtimeConfig.js";
import { llmGuardInternalRoutes } from "./llmGuard.js";
import { cardSpecWriteBlock, loadCardDraftInfo, noteCardSpecWrite, buildCardBaseContextBlock, CARD_BASE_FILE_LIST_MAX_CHARS } from "../services/cardSpecGuard.js";
import { applyEvolutionPlan, buildEvolutionPlanContext, nextRfcNumber, type EvolutionPlan } from "../services/evolutionPlanner.js";
import { syncCardAfterConversion, specHashOf, cardReadyTestHooks } from "../services/cardService.js";
import { listRepoTree } from "../services/cardRevalidate.js";
import { isCanonicalUuid, toCanonicalUuid } from "../lib/uuid.js";

const ev = (tag: string, data: unknown) => console.log(`[Z-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const ADR_BASE = "# ADR-001 BASE ORIGINAL\n\nDecisão herdada da versão corrente.\n";
const RFC_BASE = "# RFC-0004 — Legado\n\nRFC histórico da versão corrente.\n";
const RFC_PATH = "docs/rfc/RFC-0001-exportar-csv.md";

const rfc = (o: { n?: number; title?: string } = {}) => `# RFC-${String(o.n ?? 1).padStart(4, "0")} — ${o.title ?? "Exportar entregas em CSV"}

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.

## Non-goals
Não altera o cálculo de prazos nem a tela de mapa.

## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.

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

describePg("Fase 3 — correções do backend após a revisão adversarial (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const tmpDirs: string[] = [UP];
  const envBackup = { API_AGENTS_URL: process.env.API_AGENTS_URL, PROJECT_FILES_ROOT: process.env.PROJECT_FILES_ROOT, SPEC_AUTONOMY: process.env.SPEC_AUTONOMY };

  beforeAll(async () => {
    mkdirSync(UP, { recursive: true });
    pool = await openPg();
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes, specFileRoutes, specChatRoutes, evolutionPlanRoutes, specAutonomyRoutes, pipelineRoutes, runtimeConfigRoutes, llmGuardInternalRoutes]);
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool?.end();
  });
  beforeEach(() => { agentsCalls = []; process.env.API_AGENTS_URL = "http://agents.local"; });
  afterEach(() => { vi.unstubAllEnvs(); });

  const as = (s: Seed, role = "tenant_admin", extra: { id?: string; svc?: string } = {}) =>
    Object.assign(testUser, { id: extra.id ?? s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId, svc: extra.svc });
  const flagOn = (tenantId: string) => pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [tenantId]);
  const mk = async (o: { flag?: boolean; extraFiles?: Array<{ relDir: string; filename: string; content: string }> } = {}) => {
    const s = await seedAcceptedProduct(pool, {
      budgetUsd: 50, specContent: "# Spec do pai\n\nO app lista entregas.\n",
      extraFiles: o.extraFiles ?? [{ relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h.\n" }],
    });
    seeds.push(s);
    process.env.UPLOAD_DIR = UP;
    if (o.flag !== false) await flagOn(s.tenantId);
    as(s);
    return s;
  };
  const create = async (s: Seed, o: { kind?: string } = {}) => {
    as(s);
    const r = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: o.kind ?? "feature", title: "Exportar CSV", body: "Quero baixar a lista de entregas em CSV." } });
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
    return fp;
  };
  const addRfc = (draftId: string, o: Parameters<typeof rfc>[0] = {}) =>
    addDraftFile(draftId, "docs/rfc", `RFC-${String(o.n ?? 1).padStart(4, "0")}-exportar-csv.md`, rfc(o));
  const post = (s: Seed, path: string, payload?: unknown, role = "tenant_admin") => { as(s, role); return app.inject({ method: "POST", url: path, ...(payload ? { payload } : {}) }); };
  const get = (s: Seed, path: string) => { as(s); return app.inject({ method: "GET", url: path }); };
  const stateOf = async (id: string) => (await pool.query("SELECT card_state, status, child_project_id, blocked_reason, draft_project_id FROM tickets WHERE id = $1", [id])).rows[0] as
    { card_state: string; status: string; child_project_id: string | null; blocked_reason: string | null; draft_project_id: string | null };
  const eventsOf = async (id: string) => (await pool.query("SELECT to_state, actor_kind, reason FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows as Array<{ to_state: string; actor_kind: string; reason: string | null }>;
  const readyCard = async (s: Seed, o: { n?: number } = {}) => {
    const c = await create(s);
    await addRfc(c.draftProjectId, { n: o.n });
    const r = await post(s, `/api/cards/${c.id}/ready`);
    expect(r.statusCode, r.body).toBe(200);
    return c;
  };
  const treeOf = async (projectId: string) => {
    const rows = (await pool.query("SELECT rel_dir, filename, file_path FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename", [projectId])).rows;
    return Object.fromEntries(rows.map((r) => [`${r.rel_dir ? `${r.rel_dir}/` : ""}${r.filename}`, existsSync(r.file_path) ? sha256(readFileSync(r.file_path)) : "(sem arquivo)"])) as Record<string, string>;
  };
  const contentOf = async (projectId: string, relPath: string) => {
    const i = relPath.lastIndexOf("/");
    const row = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND rel_dir = $2 AND filename = $3", [projectId, i >= 0 ? relPath.slice(0, i) : "", relPath.slice(i + 1)])).rows[0];
    return row ? readFileSync(row.file_path, "utf-8") : null;
  };
  const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return false;
  };

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-04 — id de projeto em forma NÃO canônica não contorna trava, escopo nem orçamento (sonda P1)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-04 (P1): UUID sem hífens / entre chaves / com hífens deslocados ⇒ 400 INVALID_ID em todos os escritores; maiúsculas ⇒ a mesma trava; nada é escrito nem chamado", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const d = c.draftProjectId;
    const hex = d.replace(/-/g, "");
    const forms = { semHifens: hex, entreChaves: `{${d}}`, hifensDeslocados: `${hex.slice(0, 4)}-${hex.slice(4, 12)}-${hex.slice(12, 20)}-${hex.slice(20)}` };
    const before = await treeOf(d);
    as(s);
    const out: Record<string, number[]> = {};
    for (const [nome, id] of Object.entries(forms)) {
      expect(isCanonicalUuid(id), nome).toBe(false);
      expect(toCanonicalUuid(id), nome).toBe(d);
      const reqs: Array<[string, string, string, unknown]> = [
        ["spec-content", "PATCH", `/api/projects/${id}/spec-content`, { specMarkdown: "# invadido" }],
        ["spec-chat", "POST", `/api/spec-chat`, { specMarkdown: "# doc", messages: [{ role: "user", content: "x" }], projectId: id }],
        ["spec-autonomy", "POST", `/api/spec-autonomy`, { projectId: id }],
        ["spec-file PUT", "PUT", `/api/projects/${id}/spec-file?path=tickets/TK-0001/request.md`, { content: "x", baseSha: "y" }],
        ["spec-file POST", "POST", `/api/projects/${id}/spec-file`, { path: "docs/rfc/RFC-0009-x.md", content: "# x" }],
        ["spec-file DELETE", "DELETE", `/api/projects/${id}/spec-file?path=${RFC_PATH}`, undefined],
        ["evolution-plan", "POST", `/api/projects/${id}/evolution-plan`, { request: "x" }],
        ["rfc-from-template", "POST", `/api/projects/${id}/rfc-from-template`, { title: "x" }],
      ];
      out[nome] = [];
      for (const [rotulo, method, url, payload] of reqs) {
        const r = await app.inject({ method: method as "PUT", url, ...(payload ? { payload } : {}) });
        expect(r.statusCode, `${nome}/${rotulo}: ${r.body}`).toBe(400);
        expect(r.json().code, `${nome}/${rotulo}`).toBe("INVALID_ID");
        out[nome].push(r.statusCode);
      }
    }
    // maiúsculas é UUID canônico: passa pelo hook e cai na MESMA trava do id minúsculo
    const up = d.toUpperCase();
    const a = await app.inject({ method: "PATCH", url: `/api/projects/${up}/spec-content`, payload: { specMarkdown: "# invadido" } });
    expect(a.statusCode, a.body).toBe(409);
    expect(a.json().code).toBe("CARD_SPEC_LOCKED");
    const b = await app.inject({ method: "POST", url: "/api/spec-chat", payload: { specMarkdown: "# doc", messages: [{ role: "user", content: "x" }], projectId: up } });
    expect(b.statusCode, b.body).toBe(409);
    expect(b.json().code).toBe("CARD_SPEC_LOCKED");
    expect(agentsCalls).toEqual([]);
    expect(await treeOf(d)).toEqual(before);
    expect((await stateOf(c.id)).card_state).toBe("ready");
    // defesa em profundidade: a PRÓPRIA guarda (chamada com o texto cru por qualquer escritor futuro) resolve a linha do banco
    for (const id of Object.values(forms)) {
      const blk = await cardSpecWriteBlock(pool as never, id);
      expect(blk, id).toMatchObject({ status: 409, body: { code: "CARD_SPEC_LOCKED" } });
      expect((await loadCardDraftInfo(pool as never, id))?.projectId).toBe(d);   // sempre o id canônico lido do banco
    }
    expect(await loadCardDraftInfo(pool as never, "abc")).toBeNull();
    ev("P1", out);
  });

  it("Y-16: ids malformados nas rotas de card respondem 404 limpo (nunca 500 com a mensagem 22P02 do Postgres)", async () => {
    const s = await mk();
    const c = await create(s);
    as(s);
    for (const url of ["/api/products/abc/cards", "/api/products/abc/cards/capabilities", `/api/cards/abc`, `/api/cards/${c.id}/attachments/abc`, `/api/cards/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeeeee`]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, `${url}: ${r.body}`).toBe(404);
      expect(r.body).not.toMatch(/22P02|invalid input syntax|uuid/i);
    }
    const r = await app.inject({ method: "POST", url: "/api/products/abc/cards", payload: { body: "x" } });
    expect(r.statusCode).toBe(404);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-05 — o rascunho de um card não é excluído, arquivado nem parado por rotas de projeto (sonda P2)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-05 (P2): DELETE /api/projects/:draft (legado e guardado), /stop e PATCH de status ⇒ 409, nos 8 estados do card; o rascunho segue card_draft e vinculado", async () => {
    const s = await mk();
    const states: Array<[string, string]> = [["draft", "open"], ["refining", "open"], ["ready", "open"], ["promoted", "promoted"], ["in_factory", "promoted"], ["blocked", "promoted"], ["rejected", "rejected"], ["delivered", "delivered"]];
    const res: Record<string, string> = {};
    for (const [state, legacy] of states) {
      const c = await create(s);
      await pool.query("UPDATE tickets SET card_state = $2, status = $3, blocked_reason = $4 WHERE id = $1", [c.id, state, legacy, state === "blocked" ? "child_failed" : null]);
      const d = c.draftProjectId;
      as(s);
      const del = await app.inject({ method: "DELETE", url: `/api/projects/${d}` });
      expect(del.statusCode, `${state}: ${del.body}`).toBe(409);
      expect(del.json()).toMatchObject({ code: "USE_CARD_DELETE", cardId: c.id, hint: `DELETE /api/cards/${c.id}` });
      const delG = await app.inject({ method: "DELETE", url: `/api/projects/${d}`, payload: { confirmId: d, acknowledge: true } });
      expect(delG.statusCode, `${state} guardado: ${delG.body}`).toBe(409);
      expect(delG.json().code).toBe("USE_CARD_DELETE");
      const stop = await app.inject({ method: "POST", url: `/api/projects/${d}/stop` });
      expect(stop.statusCode, `${state} stop: ${stop.body}`).toBe(409);
      as(s, "zentriz_admin");
      const patch = await app.inject({ method: "PATCH", url: `/api/projects/${d}`, payload: { status: "archived" } });
      expect(patch.statusCode, `${state} patch: ${patch.body}`).toBe(409);
      const proj = (await pool.query("SELECT status FROM projects WHERE id = $1", [d])).rows[0];
      expect(proj.status, state).toBe("card_draft");
      expect((await stateOf(c.id)).draft_project_id, state).toBe(d);        // o vínculo (FK SET NULL) não foi cortado
      res[state] = `${del.statusCode}/${delG.statusCode}/${stop.statusCode}/${patch.statusCode}`;
    }
    // o caminho certo continua: card em draft é excluído por DELETE /api/cards/:id (apaga o rascunho junto)
    const c2 = await create(s);
    as(s);
    expect((await app.inject({ method: "DELETE", url: `/api/cards/${c2.id}` })).statusCode).toBe(204);
    expect((await pool.query("SELECT 1 FROM projects WHERE id = $1", [c2.draftProjectId])).rows.length).toBe(0);
    ev("P2", res);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-01 — gate, hash e carimbo sobre a MESMA leitura; corrida ready × DELETE do RFC (sonda P4)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-01 (P4): 50× 'ready' concorrente com o DELETE do RFC ⇒ nunca ready sem RFC e nunca carimbo sobre árvore diferente", async () => {
    const s = await mk();
    const outcome: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      const c = await create(s);
      const d = c.draftProjectId;
      await addRfc(d);
      as(s);
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // varre o deslocamento do DELETE em relação ao ready (0–27 ms) para cair em várias fases do ready
      const [del, rdy] = await Promise.all([
        delay((i % 10) * 3).then(() => app.inject({ method: "DELETE", url: `/api/projects/${d}/spec-file?path=${RFC_PATH}` })),
        app.inject({ method: "POST", url: `/api/cards/${c.id}/ready` }),
      ]);
      const st = await stateOf(c.id);
      const tree = await treeOf(d);
      const hasRfc = tree[RFC_PATH] !== undefined && tree[RFC_PATH] !== "(sem arquivo)";
      const key = `delete=${del.statusCode} ready=${rdy.statusCode} estado=${st.card_state}`;
      outcome[key] = (outcome[key] ?? 0) + 1;
      if (st.card_state === "ready") {
        // INVARIANTE: pronto ⇒ o RFC existe e o carimbo é da árvore atual
        expect(hasRfc, `iteração ${i}: ${key}`).toBe(true);
        const stamp = (await pool.query("SELECT extra->'card_ready'->>'draft_spec_hash' AS h FROM projects WHERE id = $1", [d])).rows[0].h as string | null;
        expect(stamp, `iteração ${i}`).toBe(await specHashOf(pool, d));
      } else {
        expect(["draft", "refining"], `iteração ${i}: ${key}`).toContain(st.card_state);
        const stamp = (await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [d])).rows[0].has as boolean;
        expect(stamp, `iteração ${i}: carimbo órfão fora de ready: ${key} eventos=${JSON.stringify(await eventsOf(c.id))}`).toBe(false);
      }
    }
    // nenhuma promoção foi pedida: nenhum filho
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    ev("P4-corrida", outcome);
  });

  it("Y-01 (P4, determinístico): escrita exatamente na janela entre a leitura e o carimbo ⇒ ready recusa (CARD_SPEC_CHANGED), nada é carimbado", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d);
    cardReadyTestHooks.afterSnapshot = async () => {
      // o DELETE do RFC cai EXATAMENTE entre o gate/hash e a gravação do carimbo (a sonda P4 da revisão)
      const row = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d])).rows[0];
      await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d]);
      rmSync(row.file_path);
    };
    try {
      const r = await post(s, `/api/cards/${c.id}/ready`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe("CARD_SPEC_CHANGED");
    } finally { cardReadyTestHooks.afterSnapshot = undefined; }
    expect((await stateOf(c.id)).card_state).not.toBe("ready");
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [d])).rows[0].has).toBe(false);
    // e a promoção nunca cria filho sem RFC
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(409);
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
  });

  it("Y-01 (P4, determinístico): escrita entre o COMMIT do carimbo e a conferência final ⇒ o card volta a refining, sem carimbo, e o ready responde 409", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d);
    cardReadyTestHooks.afterCommit = async () => {
      const row = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d])).rows[0];
      await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d]);
      rmSync(row.file_path);
    };
    try {
      const r = await post(s, `/api/cards/${c.id}/ready`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe("CARD_SPEC_CHANGED");
    } finally { cardReadyTestHooks.afterCommit = undefined; }
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await eventsOf(c.id)).at(-1)).toMatchObject({ to_state: "refining", reason: "spec_changed_during_validate" });
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [d])).rows[0].has).toBe(false);
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
  });

  it("Y-01: escrita que passou pela guarda ANTES do ready e termina DEPOIS dele derruba o card para refining (carimbo descartado)", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const d = c.draftProjectId;
    // o "escritor atrasado": já passou pela guarda; apaga o RFC (banco e disco) e só então avisa a máquina
    const row = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d])).rows[0];
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d]);
    rmSync(row.file_path);
    await noteCardSpecWrite(pool as never, d, { knownStatus: "card_draft" });
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [d])).rows[0].has).toBe(false);
    expect((await eventsOf(c.id)).at(-1)).toMatchObject({ to_state: "refining", actor_kind: "system", reason: "spec_write_after_ready" });
    // e sem RFC o ready seguinte recusa
    const again = await post(s, `/api/cards/${c.id}/ready`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("EVOLUTION_RFC_REQUIRED");
  });

  it("Y-01: a promoção reavalia carimbo, hash e gate DENTRO do lock — carimbo forjado sobre árvore sem RFC não cria filho (estado final da sonda P4)", async () => {
    const s = await mk();
    let semFilho = 0;
    for (let i = 0; i < 10; i++) {
      const c = await readyCard(s);
      const d = c.draftProjectId;
      // reproduz o estado final da sonda: RFC sumiu do rascunho E o carimbo foi regravado com o hash da árvore SEM RFC
      const row = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d])).rows[0];
      await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename LIKE 'RFC-%'", [d]);
      rmSync(row.file_path);
      const hashSemRfc = await specHashOf(pool, d);
      await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{card_ready,draft_spec_hash}', to_jsonb($2::text)) WHERE id = $1`, [d, hashSemRfc]);
      const pr = await post(s, `/api/cards/${c.id}/promote`);
      expect(pr.statusCode, pr.body).toBe(409);
      expect(pr.json().code).toBe("EVOLUTION_RFC_REQUIRED");                 // o gate foi reavaliado sobre a mesma leitura do hash
      expect(pr.json().revertToRefining).toBeUndefined();                    // o campo interno não vaza para o cliente
      expect((await stateOf(c.id)).card_state).toBe("refining");
      semFilho += (await childrenOf(pool, s.parentId)).length === 0 ? 1 : 0;
      await post(s, `/api/cards/${c.id}/reject`);                            // limpa o card
    }
    expect(semFilho).toBe(10);
  });

  it("Y-01: ao ir a ready, o laço autônomo ativo do rascunho é encerrado (stalled) na mesma transação (Y-23)", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d);
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO spec_autonomy_runs (id, project_id, tenant_id, owner_user_id, status, round, max_rounds, deadline_at, mode, rounds)
       VALUES ($1,$2,$3,$4,'cto_running',1,5, now() + interval '1 hour','per_file','[]'::jsonb)`, [runId, d, s.tenantId, s.userId]);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    const run = (await pool.query("SELECT status, last_error, finished_at FROM spec_autonomy_runs WHERE id = $1", [runId])).rows[0];
    expect(run.status).toBe("stalled");
    expect(run.last_error).toContain("Card validado");
    expect(run.finished_at).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-02 / Y-08 — o card nunca reescreve RFC/ADR herdado; numeração sobre HEAD + rascunho (sonda P6)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const withBase = () => mk({ extraFiles: [
    { relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h.\n" },
    { relDir: "docs/adr", filename: "ADR-001-formato.md", content: ADR_BASE },
    { relDir: "docs/rfc", filename: "RFC-0004-legado.md", content: RFC_BASE },
  ] });

  it("Y-02 (P6): o rascunho recusa na ESCRITA o arquivo que o HEAD já tem; 'Validar' e a promoção também; a árvore do FILHO herda o ADR original", async () => {
    const s = await withBase();
    const c = await create(s);
    const d = c.draftProjectId;
    as(s);
    // (1) escrita: POST no mesmo caminho do ADR herdado ⇒ 409 CARD_PATH_COLLIDES_WITH_BASE (nada gravado)
    const w = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path: "docs/adr/ADR-001-formato.md", content: "# ADR-001 REESCRITO PELO CARD\n" } });
    expect(w.statusCode, w.body).toBe(409);
    expect(w.json()).toMatchObject({ code: "CARD_PATH_COLLIDES_WITH_BASE", path: "docs/adr/ADR-001-formato.md" });
    expect(await contentOf(d, "docs/adr/ADR-001-formato.md")).toBeNull();
    // maiúsculas/minúsculas não escapam
    const w2 = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path: "docs/adr/adr-001-FORMATO.md", content: "# x\n" } });
    expect(w2.statusCode, w2.body).toBe(409);
    // (2) arquivo que escapou da escrita (inserido por fora): "Validar" recusa
    await addDraftFile(d, "docs/adr", "ADR-001-formato.md", "# ADR-001 REESCRITO PELO CARD\n");
    await addRfc(d, { n: 5 });
    const rd = await post(s, `/api/cards/${c.id}/ready`);
    expect(rd.statusCode, rd.body).toBe(409);
    expect(rd.json()).toMatchObject({ code: "CARD_PATH_COLLIDES_WITH_BASE", paths: ["docs/adr/ADR-001-formato.md"] });
    // (3) o card usa um ADR NOVO: ready + promoção; a árvore do FILHO preserva o ADR/RFC herdados byte a byte
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'ADR-001-formato.md'", [d]);
    await addDraftFile(d, "docs/adr", "ADR-002-formato-csv.md", "# ADR-002 — Formato do CSV\n\nPonto e vírgula.\n");
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(201);
    const child = pr.json().childProjectId as string;
    expect(await contentOf(child, "docs/adr/ADR-001-formato.md")).toBe(ADR_BASE);          // herdado, intacto
    expect(await contentOf(child, "docs/rfc/RFC-0004-legado.md")).toBe(RFC_BASE);
    expect(await contentOf(child, "docs/adr/ADR-002-formato-csv.md")).toContain("Ponto e vírgula");
    const origins = (await pool.query("SELECT rel_dir, filename, spec_origin FROM project_spec_files WHERE project_id = $1 AND filename IN ('ADR-001-formato.md','ADR-002-formato-csv.md')", [child])).rows;
    expect(origins.find((o) => o.filename === "ADR-001-formato.md")?.spec_origin ?? null).not.toBe("card:TK-0001");
    expect(origins.find((o) => o.filename === "ADR-002-formato-csv.md")?.spec_origin).toBe("card:TK-0001");
    ev("P6", { escrita: w.statusCode, ready: rd.statusCode, promocao: pr.statusCode, adrFilhoIntacto: true });
  });

  it("Y-02: carimbo válido + arquivo colidindo com o HEAD ⇒ o claim da promoção recusa (sem filho) e o card volta a refining", async () => {
    const s = await withBase();
    const c = await readyCard(s, { n: 5 });
    const d = c.draftProjectId;
    // arquivo colidente inserido depois do ready, com o carimbo regravado (cenário de bypass da escrita E do hash)
    await addDraftFile(d, "docs/adr", "ADR-001-formato.md", "# ADR-001 REESCRITO PELO CARD\n");
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{card_ready,draft_spec_hash}', to_jsonb($2::text)) WHERE id = $1`, [d, await specHashOf(pool, d)]);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(409);
    expect(pr.json().code).toBe("CARD_PATH_COLLIDES_WITH_BASE");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    expect((await stateOf(c.id)).card_state).toBe("refining");
  });

  it("Y-08: a numeração de RFC/ADR do planner para o rascunho parte da árvore do HEAD somada à do rascunho; colisão residual é pulada com aviso", async () => {
    const s = await withBase();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d, { n: 5 });
    const ctx = await buildEvolutionPlanContext(pool as never, d);
    expect(ctx.existingAdrs).toContain("ADR-001-formato.md");                // vem do HEAD
    expect(ctx.existingRfcs).toEqual(expect.arrayContaining(["RFC-0004-legado.md", "RFC-0005-exportar-csv.md"]));
    expect(ctx.nextAdrSeq).toBeGreaterThanOrEqual(2);                         // antes: 1 ⇒ ADR-001 em cima do herdado
    expect(ctx.nextRfcSeq).toBeGreaterThanOrEqual(6);
    expect(await nextRfcNumber(pool as never, d)).toBeGreaterThanOrEqual(6);
    // defesa final: mesmo que o piso venha errado (nextAdrSeq forçado a 1), o ADR colidente NÃO sobrescreve o herdado e vira aviso
    const plan = {
      summary: "x", compat: "minor", questions: [], rfcs: [], changelog: { added: [], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
      adrs: [{ slug: "formato", title: "Formato", content: "# x\n\nTexto do ADR gerado pelo arquiteto, longo o bastante.\n" }], connectYaml: null,
    } as unknown as EvolutionPlan;
    const r = await applyEvolutionPlan(pool as never, { ...ctx, productId: null, nextAdrSeq: 1 }, plan);
    expect(r.written).toEqual([{ path: "docs/adr/ADR-001-formato.md", action: "skipped" }]);
    expect(r.warnings.join(" ")).toContain("já existe na spec da versão corrente");
    expect(await contentOf(d, "docs/adr/ADR-001-formato.md")).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-06 / Y-21 — matriz de papéis
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-06: criar/editar/validar = user; promover, rejeitar, retomar, revalidar, reabrir e excluir = autor, tenant_admin ou zentriz_admin", async () => {
    const s = await mk();
    const mkUser = async (role: string) => (await pool.query(`INSERT INTO users (email, name, role, tenant_id) VALUES ($1,'u',$2,$3) RETURNING id`, [`r-${randomUUID()}@x.test`, role, s.tenantId])).rows[0].id as string;
    const outro = await mkUser("user");
    // user cria o PRÓPRIO card (autor = o usuário `user`)
    const autor = await mkUser("user");
    as(s, "user", { id: autor });
    const created = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title: "T", body: "Quero exportar CSV" } });
    expect(created.statusCode, created.body).toBe(201);
    const c = created.json() as { id: string; draftProjectId: string };
    await addRfc(c.draftProjectId);
    // outro `user` EDITA e VALIDA (user ou acima) — mas não opera o ciclo
    as(s, "user", { id: outro });
    expect((await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { title: "T2" } })).statusCode).toBe(200);
    const rdy = await app.inject({ method: "POST", url: `/api/cards/${c.id}/ready` });
    expect(rdy.statusCode, rdy.body).toBe(200);
    const denied: Record<string, number> = {};
    for (const [nome, method, path] of [
      ["promote", "POST", "promote"], ["reject", "POST", "reject"], ["resume", "POST", "resume"], ["revalidate", "POST", "revalidate"],
      ["reopen", "POST", "reopen"], ["delete", "DELETE", ""],
    ] as const) {
      as(s, "user", { id: outro });
      const r = await app.inject({ method, url: `/api/cards/${c.id}${path ? `/${path}` : ""}` });
      expect(r.statusCode, `${nome}: ${r.body}`).toBe(403);
      expect(r.json().code, nome).toBe("CARD_ACTION_NOT_ALLOWED");
      denied[nome] = r.statusCode;
    }
    expect((await stateOf(c.id)).card_state).toBe("ready");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    // o AUTOR (role user) reabre e valida de novo; revalida
    as(s, "user", { id: autor });
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/revalidate` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/reopen` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/ready` })).statusCode).toBe(200);
    // outro user NÃO promove; o tenant_admin de OUTRA pessoa promove
    as(s, "user", { id: outro });
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` })).statusCode).toBe(403);
    as(s, "tenant_admin", { id: outro });
    const pr = await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` });
    expect(pr.statusCode, pr.body).toBe(201);
    expect((await childrenOf(pool, s.parentId)).length).toBe(1);
    // autor promove o PRÓPRIO card (segundo card, em outra linhagem pronta: o primeiro filho ainda está vivo ⇒ só confere a autorização)
    as(s, "tenant_admin");                                                                                          // autor = s.userId (outra pessoa)
    const c2 = (await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title: "T", body: "Outro" } })).json() as { id: string };
    as(s, "user", { id: autor });
    const c3 = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title: "Meu", body: "Meu card" } });
    expect(c3.statusCode).toBe(201);
    const own = c3.json() as { id: string };
    expect((await app.inject({ method: "DELETE", url: `/api/cards/${own.id}` })).statusCode).toBe(204);          // autor exclui o próprio draft
    as(s, "user", { id: outro });
    expect((await app.inject({ method: "DELETE", url: `/api/cards/${c2.id}` })).statusCode).toBe(403);             // c2 foi criado pelo tenant_admin (outro autor)
    as(s, "zentriz_admin", { id: await mkUser("user") });
    expect((await app.inject({ method: "POST", url: `/api/cards/${c2.id}/reject` })).statusCode).toBe(200);         // zentriz_admin opera
    // conta de gestão NÃO cria nem edita (autoria é do tenant)
    const cr = await app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "feature", title: "x", body: "y" } });
    expect(cr.statusCode).toBe(403);
    ev("papeis", { negados: denied, promocaoPorOutroTenantAdmin: pr.statusCode });
  });

  it("Y-21: token de serviço (svc) não lê nem muta card; lista, capacidades, detalhe, jornada e anexos respondem 403", async () => {
    const s = await mk();
    const c = await create(s);
    as(s, "tenant_admin", { svc: "runner" });
    for (const [method, url] of [
      ["GET", `/api/products/${s.productId}/cards`], ["GET", `/api/products/${s.productId}/cards/capabilities`], ["GET", `/api/cards/${c.id}`],
      ["GET", `/api/cards/${c.id}/journey`], ["GET", `/api/cards/${c.id}/attachments`], ["GET", `/api/cards/${c.id}/base-spec`],
      ["POST", `/api/cards/${c.id}/reject`], ["POST", `/api/cards/${c.id}/ready`], ["POST", `/api/cards/${c.id}/promote`],
    ] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
    }
    expect((await stateOf(c.id)).card_state).toBe("draft");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-07 — anexos: conversão em andamento bloqueia o ready; o conjunto de anexos entra no carimbo
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const addPdfAttachment = async (s: Seed, cardId: string, status: "pending" | "running" | "done") => {
    const dir = join(UP, "att", cardId);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "contrato.pdf");
    writeFileSync(fp, "%PDF-1.4 fake");
    const att = (await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin)
       VALUES ($1,'contrato.pdf',$2,'application/pdf',13,$3,'card_only','upload') RETURNING id`, [cardId, fp, sha256("%PDF-1.4 fake")])).rows[0].id as string;
    const conv = (await pool.query(`INSERT INTO attachment_conversions (attachment_id, content_sha256, status) VALUES ($1,$2,$3) RETURNING id`, [att, sha256("%PDF-1.4 fake"), status])).rows[0].id as string;
    return { att, conv, fp, dir };
  };

  it("Y-07: conversão pending/running ⇒ 409 CARD_ATTACHMENT_CONVERSION_PENDING; terminada ⇒ ready; conversão que muda depois derruba o carimbo na promoção", async () => {
    const s = await mk();
    const c = await create(s);
    await addRfc(c.draftProjectId);
    const a = await addPdfAttachment(s, c.id, "pending");
    const r1 = await post(s, `/api/cards/${c.id}/ready`);
    expect(r1.statusCode, r1.body).toBe(409);
    expect(r1.json()).toMatchObject({ code: "CARD_ATTACHMENT_CONVERSION_PENDING", pending: [{ filename: "contrato.pdf", state: "pending" }] });
    await pool.query("UPDATE attachment_conversions SET status = 'running' WHERE id = $1", [a.conv]);
    expect((await post(s, `/api/cards/${c.id}/ready`)).json().code).toBe("CARD_ATTACHMENT_CONVERSION_PENDING");
    // terminou sem texto (empty) ⇒ estado terminal: valida, e o carimbo guarda o hash dos anexos
    await pool.query("UPDATE attachment_conversions SET status = 'empty' WHERE id = $1", [a.conv]);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    const stamp = (await pool.query("SELECT extra->'card_ready'->>'attachments_hash' AS h FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].h as string;
    expect(stamp).toMatch(/^[0-9a-f]{64}$/);
    // o conjunto de anexos muda depois do carimbo (conversão reprocessada ⇒ novo estado) ⇒ promover recusa e volta a refining
    await pool.query("UPDATE attachment_conversions SET status = 'done' WHERE id = $1", [a.conv]);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(409);
    expect(pr.json().code).toBe("CARD_NOT_READY");
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
  });

  it("Y-07: conversão que termina DEPOIS do ready devolve o card a refining e rematerializa o derivado no rascunho", async () => {
    const s = await mk();
    const c = await create(s);
    await addRfc(c.draftProjectId);
    const a = await addPdfAttachment(s, c.id, "done");
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    // chega o derivado .md (a fila gravou em ticket_attachments, não na árvore do rascunho)
    const mdPath = join(a.dir, "contrato.md");
    writeFileSync(mdPath, "# Contrato\n\nTexto extraído do PDF.\n");
    await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin, derived_from_attachment_id)
       VALUES ($1,'contrato.md',$2,'text/markdown',36,$3,'spec_text','converted:builtin-text-v1',$4)`, [c.id, mdPath, sha256("# Contrato\n\nTexto extraído do PDF.\n"), a.att]);
    expect(await syncCardAfterConversion(pool as never, c.id)).toBe("reopened");
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await eventsOf(c.id)).at(-1)).toMatchObject({ to_state: "refining", reason: "attachment_converted" });
    expect((await pool.query("SELECT extra->'card_ready' IS NOT NULL AS has FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].has).toBe(false);
    const tree = await treeOf(c.draftProjectId);
    expect(Object.keys(tree).some((p) => p.endsWith("contrato.md")), JSON.stringify(Object.keys(tree))).toBe(true);
    // card ainda em refining: só rematerializa
    expect(await syncCardAfterConversion(pool as never, c.id)).toBe("rematerialized");
    // card rejeitado/promovido: nada
    await post(s, `/api/cards/${c.id}/reject`);
    expect(await syncCardAfterConversion(pool as never, c.id)).toBe("none");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-09 / Y-22 — teto de contexto e lista de arquivos
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-09: CARD_BASE_CONTEXT_CHARS e CARD_BASE_SPEC_MAX_BYTES só o zentriz_admin altera; teto de 200 000 caracteres", async () => {
    const s = await mk();
    for (const key of ["CARD_BASE_CONTEXT_CHARS", "CARD_BASE_SPEC_MAX_BYTES"]) {
      as(s, "tenant_admin");
      const t = await app.inject({ method: "PUT", url: `/api/admin/runtime-config/${key}`, payload: { value: 5000 } });
      expect(t.statusCode, `${key}: ${t.body}`).toBe(403);
      expect(t.json().code).toBe("ADMIN_ONLY_KEY");
    }
    as(s, "zentriz_admin");
    const tooBig = await app.inject({ method: "PUT", url: "/api/admin/runtime-config/CARD_BASE_CONTEXT_CHARS", payload: { value: 400_000, tenantId: s.tenantId } });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().code).toBe("OUT_OF_RANGE");
    const ok = await app.inject({ method: "PUT", url: "/api/admin/runtime-config/CARD_BASE_CONTEXT_CHARS", payload: { value: 200_000, tenantId: s.tenantId } });
    expect(ok.statusCode, ok.body).toBe(200);
    // um override antigo gravado pelo tenant com 400 000 é IGNORADO (fora da faixa) ⇒ vale o piso de 14 000
    await pool.query("UPDATE genesis_runtime_config SET value = '400000' WHERE key = 'CARD_BASE_CONTEXT_CHARS' AND tenant_id = $1", [s.tenantId]);
    const c = await create(s);
    const block = await buildCardBaseContextBlock(pool as never, c.draftProjectId);
    expect(block.length).toBeLessThan(15_000 + 1_000);
  });

  it("Y-22: a lista de arquivos da versão corrente tem teto e o bloco inteiro respeita o orçamento (cabeçalhos contados)", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ relDir: "docs/modulos", filename: `modulo-${String(i).padStart(4, "0")}-com-um-nome-comprido.md`, content: `# Módulo ${i}\n\n${"texto ".repeat(40)}\n` }));
    const s = await mk({ extraFiles: many });
    const c = await create(s);
    const budget = 6_000;
    const block = await buildCardBaseContextBlock(pool as never, c.draftProjectId, { budgetChars: budget });
    const listLine = block.split("\n").find((l) => l.startsWith("Arquivos da versão corrente")) ?? "";
    expect(listLine.length).toBeLessThanOrEqual(CARD_BASE_FILE_LIST_MAX_CHARS + 200);
    expect(listLine).toContain("omitido(s) da lista");
    expect(block.length).toBeLessThanOrEqual(budget + 600);                 // folga: cabeçalho final e frases fixas
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-10 — /evolve sem ticket em tenant com cards ligados
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-10: /evolve sem ticketId num tenant com CARDS_BANCADA ligada ⇒ 409 USE_CARDS; sem a flag segue o caminho histórico", async () => {
    const on = await mk();
    as(on);
    const r = await app.inject({ method: "POST", url: `/api/projects/${on.parentId}/evolve`, payload: { request: "evoluir direto" } });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().code).toBe("USE_CARDS");
    expect((await childrenOf(pool, on.parentId)).length).toBe(0);
    const off = await mk({ flag: false });
    as(off);
    const r2 = await app.inject({ method: "POST", url: `/api/projects/${off.parentId}/evolve`, payload: { request: "evoluir direto" } });
    expect(r2.json().code, r2.body).not.toBe("USE_CARDS");
    expect([200, 201]).toContain(r2.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-13 — revalidação sem repositório: stale + revisão humana + bloqueador na jornada; ls-tree
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-13: HEAD andou sem clone ⇒ stale com NEEDS_HUMAN_REVIEW e bloqueador 'globs não conferidos' na jornada até a revalidação seguinte", async () => {
    const s = await mk();
    const A = await readyCard(s, { n: 1 });
    const B = await create(s);
    await addRfc(B.draftProjectId, { n: 2, title: "Outro" });
    expect((await post(s, `/api/cards/${B.id}/ready`)).statusCode).toBe(200);
    const pa = await post(s, `/api/cards/${A.id}/promote`);
    expect(pa.statusCode, pa.body).toBe(201);
    await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [pa.json().childProjectId]);       // o HEAD andou
    const rv = await post(s, `/api/cards/${B.id}/revalidate`);
    expect(rv.statusCode, rv.body).toBe(200);
    const body = rv.json();
    expect(body.result).toBe("stale");
    expect(body.checks.repo.available).toBe(false);
    expect(body.reasons).toContainEqual(expect.objectContaining({ code: "REPO_UNAVAILABLE" }));
    expect(body.reasons).toContainEqual(expect.objectContaining({ code: "NEEDS_HUMAN_REVIEW", severity: "warning" }));
    const j = (await get(s, `/api/cards/${B.id}/journey`)).json();
    expect(j.blockers.map((b: { code: string }) => b.code)).toContain("GLOBS_UNVERIFIED");
    expect(j.action).toMatchObject({ key: "revalidate", enabled: true });
    expect(j.blockers.find((b: { code: string }) => b.code === "GLOBS_UNVERIFIED").userMessage).toContain("escopo do RFC");
    // a conferência humana (revalidar de novo, base == HEAD ⇒ ok) limpa o bloqueador
    const rv2 = await post(s, `/api/cards/${B.id}/revalidate`);
    expect(rv2.json().result).toBe("ok");
    expect((await get(s, `/api/cards/${B.id}/journey`)).json().blockers.map((b: { code: string }) => b.code)).not.toContain("GLOBS_UNVERIFIED");
  });

  it("Y-13: com repositório, a árvore lida é a do COMMIT aceito (git ls-tree), não a cópia de trabalho", async () => {
    const root = mkdtempSync(join(tmpdir(), "z1-repo-"));
    tmpDirs.push(root);
    const projectId = randomUUID();
    const apps = join(root, projectId, "apps");
    mkdirSync(join(apps, "src"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", apps, ...a], { encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" } }).trim();
    git("init", "-q");
    writeFileSync(join(apps, "src", "aceito.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "aceito");
    const sha = git("rev-parse", "HEAD");
    writeFileSync(join(apps, "src", "so-na-copia-de-trabalho.ts"), "export const b = 2;\n");      // não está no commit aceito
    const env = { PROJECT_FILES_ROOT: root } as NodeJS.ProcessEnv;
    const viaGit = await listRepoTree(projectId, null, env, { ref: sha });
    expect(viaGit).toMatchObject({ available: true, source: "git-ls-tree" });
    expect(viaGit.files).toEqual(["src/aceito.ts"]);
    const viaDisk = await listRepoTree(projectId, null, env);
    expect(viaDisk.source).toBe("working-tree");
    expect(viaDisk.files.sort()).toEqual(["src/aceito.ts", "src/so-na-copia-de-trabalho.ts"]);
    // ref inexistente ou malformada nunca vira opção do git: cai na cópia de trabalho
    expect((await listRepoTree(projectId, null, env, { ref: "--output=/tmp/x" })).source).toBe("working-tree");
    expect((await listRepoTree(projectId, null, env, { ref: "deadbeefdeadbeef" })).source).toBe("working-tree");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-14 — o Guard para o filho ⇒ o card é alinhado no ponto em que o pipeline fala com o Guard
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-14: preflight negado por orçamento (rota interna do Guard) bloqueia o card sem ninguém consultar a jornada", async () => {
    const s = await mk();
    const c = await readyCard(s);
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    const child = (await stateOf(c.id)).child_project_id!;
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [child]);
    await app.inject({ method: "GET", url: `/api/cards/${c.id}/journey` });                          // alinha a in_factory (leitura)
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    // o Guard pausa o dono e para o filho (o que `pauseForBudget` faz)
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [s.parentId]);
    await pool.query("UPDATE projects SET status = 'stopped', stopped_by = 'budget' WHERE id = $1", [child]);
    expect((await stateOf(c.id)).card_state).toBe("in_factory");                                       // ninguém olhou ainda
    const kill = String((await pool.query("SELECT value FROM llm_guard_settings WHERE key='kill_switch'")).rows[0]?.value ?? "on");
    await pool.query("UPDATE llm_guard_settings SET value='off' WHERE key='kill_switch'");
    let pf;
    try {
      pf = await app.inject({ method: "POST", url: "/api/internal/llm-guard/preflight", payload: { projectId: child, purpose: "dev_qa", source: "runner", model: "x", estimatedInputTokens: 10, estimatedOutputTokens: 10 } });
      expect(pf.json(), pf.body).toMatchObject({ allow: false, code: "BUDGET_PAUSED" });
      expect(await waitFor(async () => (await stateOf(c.id)).card_state === "blocked")).toBe(true);
    } finally {
      await pool.query("UPDATE llm_guard_settings SET value=$1 WHERE key='kill_switch'", [kill]);
    }
    expect((await stateOf(c.id)).blocked_reason).toBe("budget:BUDGET_PAUSED");
    expect((await eventsOf(c.id)).at(-1)).toMatchObject({ to_state: "blocked", actor_kind: "guard" });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Y-17 — promote que perde a corrida responde com o estado real (sonda P5)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("Y-17 (P5): promote × reject ⇒ o promote perdedor responde CARD_NOT_READY com o estado real, nunca TICKET_ALREADY_PROMOTED", async () => {
    const s = await mk();
    const codes: Record<string, number> = {};
    for (let i = 0; i < 6; i++) {
      const c = await readyCard(s, { n: i + 1 });
      const [p, r] = await Promise.all([post(s, `/api/cards/${c.id}/promote`), post(s, `/api/cards/${c.id}/reject`)]);
      const st = await stateOf(c.id);
      const pc = p.statusCode === 201 ? "201" : String(p.json().code);
      codes[pc] = (codes[pc] ?? 0) + 1;
      expect(pc, `rodada ${i}`).not.toBe("TICKET_ALREADY_PROMOTED");
      if (p.statusCode === 409) expect(["CARD_NOT_READY", "CARD_INVALID_TRANSITION"]).toContain(p.json().code);
      if (st.card_state === "rejected") { expect(p.statusCode).toBe(409); expect(p.json()).toMatchObject({ code: "CARD_NOT_READY" }); }
      // limpa o filho vivo da rodada para a seguinte (1 filho vivo por serviço)
      if (st.child_project_id) await pool.query("UPDATE projects SET status = 'archived' WHERE id = $1", [st.child_project_id]);
      void r;
    }
    ev("P5", codes);
  });
});
