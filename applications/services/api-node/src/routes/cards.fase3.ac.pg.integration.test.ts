/**
 * Correções AC (reverificação AB da Fase 3): AB-01 (planner de RFC × trava do card), AB-02 (porta legada de tickets/evolve),
 * AB-03 (zentriz_admin não promove; `actions` por papel), AB-05 (número de RFC/ADR duplicado) e AB-06 (anexo `queued` sem fila).
 * LLM/agents sempre STUBS. Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, childrenOf, sha256, seedTicket, type Seed,
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
import { applyEvolutionPlan, buildEvolutionPlanContext, createPlanJob, runEvolutionPlan, CardLockedDuringPlanError, type EvolutionPlan } from "../services/evolutionPlanner.js";
import { evolveTestHooks } from "../services/evolveClaim.js";
import { specHashOf } from "../services/cardService.js";

const ev = (tag: string, data: unknown) => console.log(`[AC-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
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

describePg("Fase 3 — correções AC dos achados AB (Postgres real)", () => {
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

  const withBase = () => mk({ extraFiles: [
    { relDir: "docs", filename: "regras.md", content: "# Regras\n\nPrazo de 48h.\n" },
    { relDir: "docs/adr", filename: "ADR-001-formato.md", content: ADR_BASE },
    { relDir: "docs/rfc", filename: "RFC-0004-legado.md", content: RFC_BASE },
  ] });
  const planJson = (slug: string) => JSON.stringify({
    response: JSON.stringify({
      summary: "Plano de teste", compat: "minor", questions: [],
      rfcs: [{ slug, title: "RFC gerado pela IA", content: "# RFC\n\n## Sumário\nTexto longo o bastante para valer como RFC gerado pelo arquiteto.\n" }],
      adrs: [], changelog: { added: ["x"], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
    }),
    model_used: "stub",
  });
  const jobStatus = async (id: string) => (await pool.query("SELECT status, error FROM evolution_plan_jobs WHERE id = $1", [id])).rows[0] as { status: string; error: string | null };

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-01 — o planner de RFC em segundo plano não escreve depois do 'ready' nem da promoção
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-01 (a): applyEvolutionPlan com o card já 'ready' (ou promovido) NÃO grava nada no rascunho", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const d = c.draftProjectId;
    const before = await treeOf(d);
    const hashBefore = await specHashOf(pool, d);
    const ctx = await buildEvolutionPlanContext(pool as never, d);
    const plan = {
      summary: "x", compat: "minor", questions: [], adrs: [], connectYaml: null,
      rfcs: [{ slug: "intruso", title: "Intruso", content: "# x\n\nTexto longo o bastante para valer como RFC gerado pelo arquiteto.\n" }],
      changelog: { added: [], changed: [], deprecated: [], removed: [], fixed: [], security: [] },
    } as unknown as EvolutionPlan;
    await expect(applyEvolutionPlan(pool as never, ctx, plan)).rejects.toBeInstanceOf(CardLockedDuringPlanError);
    expect(await treeOf(d)).toEqual(before);
    expect(await specHashOf(pool, d)).toBe(hashBefore);
    // promovido: o rascunho vira histórico e continua intocável
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
    await expect(applyEvolutionPlan(pool as never, ctx, plan)).rejects.toBeInstanceOf(CardLockedDuringPlanError);
    expect(await treeOf(d)).toEqual(before);
    ev("AB-01a", { arvoIntacta: true });
  });

  it("AB-01 (a+b): job em voo quando o card é validado ⇒ 'Validar' encerra o job (interrupted) e o resultado tardio do LLM não grava nem ressuscita o job", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d);
    const created = await createPlanJob(pool as never, d, s.userId, null);
    expect(created.ok).toBe(true);
    const job = created.job;
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => { release = r; });
    let invoked = false;
    const running = runEvolutionPlan(pool as never, job, null, async () => { invoked = true; return gate; });
    expect(await waitFor(() => invoked)).toBe(true);
    // enquanto o arquiteto "pensa", o usuário valida
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    expect((await jobStatus(job.id)).status).toBe("interrupted");
    const carimbado = await treeOf(d);
    const hash = await specHashOf(pool, d);
    // o LLM responde tarde
    release(planJson("tardio"));
    await running;
    expect(await treeOf(d)).toEqual(carimbado);
    expect(await specHashOf(pool, d)).toBe(hash);
    expect((await jobStatus(job.id)).status).toBe("interrupted");               // não virou 'done' nem 'error'
    expect((await stateOf(c.id)).card_state).toBe("ready");                     // carimbo continua válido
    expect(await contentOf(d, "docs/rfc/RFC-0002-tardio.md")).toBeNull();
    // e a promoção copia exatamente o que foi validado
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(201);
    expect(await contentOf(pr.json().childProjectId, "docs/rfc/RFC-0002-tardio.md")).toBeNull();
    ev("AB-01ab", { job: "interrupted", filhoSemRfcTardio: true });
  });

  it("AB-01 (a): sem o encerramento do job (card travado por outro caminho), a escrita do planner na janela é recusada pela trava reconferida sob lock", async () => {
    const s = await mk();
    const c = await create(s);
    const d = c.draftProjectId;
    await addRfc(d);
    const created = await createPlanJob(pool as never, d, s.userId, null);
    let release!: (v: string) => void;
    const gate = new Promise<string>((r) => { release = r; });
    let invoked = false;
    const running = runEvolutionPlan(pool as never, created.job, null, async () => { invoked = true; return gate; });
    expect(await waitFor(() => invoked)).toBe(true);
    // trava por outro caminho: reject (rascunho vira histórico) — job continua 'running'
    expect((await post(s, `/api/cards/${c.id}/reject`)).statusCode).toBe(200);
    const antes = await treeOf(d);
    release(planJson("depois-do-reject"));
    await running;
    expect(await treeOf(d)).toEqual(antes);
    const j = await jobStatus(created.job.id);
    expect(j.status).toBe("error");
    expect(j.error).toContain("validado ou promovido");
  });

  it("AB-01 (c): a cópia rascunho→filho confere o hash do carimbo — arquivo que entra no rascunho depois do 'ready' NÃO chega ao filho", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const d = c.draftProjectId;
    // escritor que ignora a guarda (bypass) grava um RFC exatamente entre o claim e o passo card_spec
    evolveTestHooks.stall = async (point) => {
      if (point === "during:card_spec") {
        const dir = join(UP, d, "docs/rfc");
        mkdirSync(dir, { recursive: true });
        const fp = join(dir, "RFC-0002-intruso.md");
        writeFileSync(fp, "# RFC-0002 — intruso\n\nNão validado.\n");
        await pool.query(
          `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256) VALUES ($1,'RFC-0002-intruso.md',$2,'text/markdown','docs/rfc',false,$3)`,
          [d, fp, sha256("# RFC-0002 — intruso\n\nNão validado.\n")]);
      }
    };
    let pr;
    try { pr = await post(s, `/api/cards/${c.id}/promote`); } finally { evolveTestHooks.stall = undefined; }
    expect(pr.statusCode, pr.body).toBe(422);
    expect(pr.json().code).toBe("CARD_DRAFT_CHANGED");
    const kids = await childrenOf(pool, s.parentId);
    for (const k of kids) expect(await contentOf(k.id as string, "docs/rfc/RFC-0002-intruso.md")).toBeNull();
    expect((await stateOf(c.id)).card_state).toBe("blocked");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-02 — porta legada de tickets e /evolve com ticket legado
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-02: com CARDS_BANCADA ligada, POST /products/:id/tickets ⇒ 409 USE_CARDS (nada criado) e /evolve com ticket legado ⇒ 409; sem a flag segue o histórico", async () => {
    const on = await mk();
    as(on);
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM tickets WHERE product_id = $1", [on.productId])).rows[0].n);
    const r = await app.inject({ method: "POST", url: `/api/products/${on.productId}/tickets`, payload: { title: "legado", body: "Pedido pela rota legada" } });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().code).toBe("USE_CARDS");
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM tickets WHERE product_id = $1", [on.productId])).rows[0].n)).toBe(before);
    // ticket legado que já existia (criado antes da flag) não vira filho por /evolve
    const t = await seedTicket(pool, on);
    for (const claim of ["off", "on"]) {
      vi.stubEnv("EVOLVE_CLAIM", claim);
      as(on);
      const e = await app.inject({ method: "POST", url: `/api/projects/${on.parentId}/evolve`, payload: { request: "x", ticketId: t.id } });
      expect(e.statusCode, `claim=${claim} ${e.body}`).toBe(409);
      expect(e.json().code).toBe("USE_CARDS");
    }
    expect((await childrenOf(pool, on.parentId)).length).toBe(0);
    // sem a flag: tudo como antes
    const off = await mk({ flag: false });
    as(off);
    const r2 = await app.inject({ method: "POST", url: `/api/products/${off.productId}/tickets`, payload: { title: "legado", body: "Pedido pela rota legada" } });
    expect(r2.statusCode, r2.body).toBe(201);
  });

  it("AB-02: a flag usada é a do tenant do PROJETO — outro tenant com a flag ligada não bloqueia o /evolve e não vaza a flag", async () => {
    const off = await mk({ flag: false });
    const other = await mk();                                  // outro tenant, flag ligada
    const t = await seedTicket(pool, off);
    Object.assign(testUser, { id: off.userId, role: "tenant_admin", tenantId: off.tenantId });
    const r = await app.inject({ method: "POST", url: `/api/projects/${off.parentId}/evolve`, payload: { request: "x", ticketId: t.id } });
    expect(r.statusCode, r.body).toBe(201);
    // usuário do tenant com flag tentando o projeto do outro tenant: 404 (não enxerga), nunca 409 USE_CARDS
    Object.assign(testUser, { id: other.userId, role: "tenant_admin", tenantId: other.tenantId });
    const r2 = await app.inject({ method: "POST", url: `/api/projects/${off.parentId}/evolve`, payload: { request: "x" } });
    expect(r2.json().code).not.toBe("USE_CARDS");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-03 — zentriz_admin não promove; `actions` do detalhe seguem o papel
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-03: zentriz_admin ⇒ 403 ao promover (mesmo card pronto); rejeitar/revalidar continuam; `actions` do detalhe seguem o papel", async () => {
    const s = await mk();
    const mkUser = async (role: string) => (await pool.query(`INSERT INTO users (email, name, role, tenant_id) VALUES ($1,'u',$2,$3) RETURNING id`, [`r-${randomUUID()}@x.test`, role, s.tenantId])).rows[0].id as string;
    const c = await readyCard(s);                                             // autor = tenant_admin do seed
    const detail = async (role: string, id: string) => { as(s, role, { id }); return (await app.inject({ method: "GET", url: `/api/cards/${c.id}` })).json().actions as Record<string, boolean>; };
    const outro = await mkUser("user");
    const zadm = await mkUser("user");
    const aUser = await detail("user", outro);
    expect(aUser).toMatchObject({ promote: false, reject: false, revalidate: false, reopen: false, delete: false });
    const aZ = await detail("zentriz_admin", zadm);
    expect(aZ).toMatchObject({ promote: false, reject: true, revalidate: true, reopen: true });
    const aT = await detail("tenant_admin", await mkUser("user"));
    expect(aT).toMatchObject({ promote: true, reject: true, revalidate: true });
    as(s, "zentriz_admin", { id: zadm });
    const p = await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` });
    expect(p.statusCode, p.body).toBe(403);
    expect(p.json().code).toBe("CARD_ACTION_NOT_ALLOWED");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    expect((await stateOf(c.id)).card_state).toBe("ready");
    as(s, "zentriz_admin", { id: zadm });
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/revalidate` })).statusCode).toBe(200);
    // o tenant_admin de outra pessoa promove
    as(s, "tenant_admin", { id: await mkUser("user") });
    expect((await app.inject({ method: "POST", url: `/api/cards/${c.id}/promote` })).statusCode).toBe(201);
    ev("AB-03", { zentrizAdminPromove: 403, actionsZentrizAdmin: aZ.promote });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-05 — número de RFC/ADR do HEAD é reservado (nome diferente, mesmo número)
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-05: RFC/ADR com o MESMO NÚMERO de um do HEAD (nome diferente) ⇒ 409 na escrita, no 'Validar' e no claim; número novo passa", async () => {
    const s = await withBase();                              // HEAD: ADR-001-formato.md e RFC-0004-legado.md
    const c = await create(s);
    const d = c.draftProjectId;
    as(s);
    for (const [path, n] of [["docs/rfc/RFC-0004-outro-nome.md", 4], ["docs/adr/ADR-001-outra-decisao.md", 1], ["docs/rfc/rfc-0004.md", 4]] as const) {
      const w = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path, content: n === 1 ? "# ADR-001 — x\n" : rfc({ n }) } });
      expect(w.statusCode, `${path} ${w.body}`).toBe(409);
      expect(w.json()).toMatchObject({ code: "CARD_PATH_COLLIDES_WITH_BASE" });
      expect(await contentOf(d, path)).toBeNull();
    }
    // inserido por fora (bypass da escrita): 'Validar' recusa
    await addDraftFile(d, "docs/rfc", "RFC-0004-duplicado.md", rfc({ n: 4 }));
    const rd = await post(s, `/api/cards/${c.id}/ready`);
    expect(rd.statusCode, rd.body).toBe(409);
    expect(rd.json()).toMatchObject({ code: "CARD_PATH_COLLIDES_WITH_BASE", paths: ["docs/rfc/RFC-0004-legado.md"] });
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'RFC-0004-duplicado.md'", [d]);
    // número novo: escreve, valida e promove
    const ok = await app.inject({ method: "POST", url: `/api/projects/${d}/spec-file`, payload: { path: "docs/rfc/RFC-0005-exportar.md", content: rfc({ n: 5 }) } });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(200);
    // claim: carimbo forjado sobre um arquivo de número duplicado
    await addDraftFile(d, "docs/rfc", "RFC-0004-forjado.md", rfc({ n: 4 }));
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{card_ready,draft_spec_hash}', to_jsonb($2::text)) WHERE id = $1`, [d, await specHashOf(pool, d)]);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(409);
    expect(pr.json().code).toBe("CARD_PATH_COLLIDES_WITH_BASE");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-06 — anexo 'queued' sem linha na fila: o 'Validar' enfileira e a espera termina
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-06: anexo pdf enviado com a conversão desligada e conversão ligada depois ⇒ 'Validar' enfileira (linha criada, estado pending) e, terminada, valida", async () => {
    const s = await mk();
    const c = await create(s);
    await addRfc(c.draftProjectId);
    const dir = join(UP, "att", c.id);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, "contrato.pdf");
    writeFileSync(fp, "%PDF-1.4 fake");
    const att = (await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, file_path, mime_type, size_bytes, content_sha256, kind, origin)
       VALUES ($1,'contrato.pdf',$2,'application/pdf',13,$3,'card_only','upload') RETURNING id`, [c.id, fp, sha256("%PDF-1.4 fake")])).rows[0].id as string;
    // conversão ligada DEPOIS do upload (sem nenhuma linha na fila)
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('ATTACHMENT_CONVERSION','1',$1),('ATTACHMENTS_STRICT','1',$1)", [s.tenantId]);
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM attachment_conversions WHERE attachment_id = $1", [att])).rows[0].n)).toBe(0);
    const r1 = await post(s, `/api/cards/${c.id}/ready`);
    expect(r1.statusCode, r1.body).toBe(409);
    expect(r1.json().code).toBe("CARD_ATTACHMENT_CONVERSION_PENDING");
    // a linha da fila foi criada pelo 'Validar' (não fica 'queued' para sempre)
    expect(await waitFor(async () => Number((await pool.query("SELECT count(*)::int AS n FROM attachment_conversions WHERE attachment_id = $1", [att])).rows[0].n) > 0)).toBe(true);
    expect(r1.json().pending[0].state).not.toBe("queued");
    // a conversão termina (worker/tick) ⇒ 'Validar' passa
    expect(await waitFor(async () => {
      await pool.query("UPDATE attachment_conversions SET status = 'empty' WHERE attachment_id = $1 AND status IN ('pending','running','failed')", [att]);
      return (await post(s, `/api/cards/${c.id}/ready`)).statusCode === 200;
    }, 8000)).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AB-08 / AB-09 — flag off idêntico para o token de serviço; escritor autônomo tardio derruba o ready
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  it("AB-08: token de serviço com a flag DESLIGADA recebe o 404 'Recurso indisponível' de sempre (nunca 403); com a flag ligada, 403", async () => {
    const off = await mk({ flag: false });
    const on = await mk();
    const c = await create(on);
    for (const [seed, cardId, esperado] of [[off, null, 404], [on, c.id, 403]] as const) {
      as(seed, "tenant_admin", { svc: "runner" });
      const lst = await app.inject({ method: "GET", url: `/api/products/${seed.productId}/cards` });
      expect(lst.statusCode, lst.body).toBe(esperado);
      if (esperado === 404) expect(lst.json()).toEqual({ code: "NOT_FOUND", message: "Recurso indisponível" });
      if (cardId) expect((await app.inject({ method: "GET", url: `/api/cards/${cardId}` })).statusCode).toBe(403);
    }
    // card de tenant com a flag desligada: 404 idêntico
    const offCard = await seedTicket(pool, off);
    as(off, "tenant_admin", { svc: "runner" });
    expect((await app.inject({ method: "GET", url: `/api/cards/${offCard.id}` })).statusCode).toBe(404);
  });
});
