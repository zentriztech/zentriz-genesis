/**
 * Fase 2 / 2.6 — API de CARDS em Postgres REAL (efêmero): ciclo completo, promoção (corrida, sequência v2→v3, base vencida, crash e
 * retomada), flag off, autorização por tenant, gates por tipo, orçamento, roteamento dos escritores legados (PATCH, /evolve,
 * reopenTicketsOfChild), reconciliador (Q1 e Q6), anexos. Rotas reais; sem LLM. Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, raceN, sha256, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { cardRoutes } from "./cards.js";
import { ticketRoutes } from "./tickets.js";
import { projectRoutes } from "./projects.js";
import { evolveTestHooks, SimulatedCrash } from "../services/evolveClaim.js";
import { syncCardForChildProject } from "../services/cardPromote.js";
import { reopenTicketsOfChild } from "../services/tickets.js";
import { hashId } from "../services/anomalyDetectors.js";
import { cleanExpiredClaim, runReconcilerPass, resolveReconcilerParams } from "../services/evolveReconciler.js";

const ev = (tag: string, data: unknown) => console.log(`[F2-6-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

const rfc = (o: { n?: number; compat?: string; nonGoals?: boolean; repro?: boolean; title?: string } = {}) => `# RFC-${String(o.n ?? 1).padStart(4, "0")} — ${o.title ?? "Exportar entregas em CSV"}

## Sumário
Permitir exportar a lista de entregas em CSV a partir da tela de entregas.
${o.nonGoals ? "\n## Non-goals\nNão altera o cálculo de prazos nem a tela de mapa.\n" : ""}
## Requisitos
- REQ-01 — O sistema DEVE gerar um CSV com as entregas do filtro atual.

## Critérios de aceite
### Cenário: exportar entregas
- **Dado** um usuário autenticado com entregas
- **Quando** clica em "Exportar CSV"
- **Então** recebe um arquivo CSV com todas as entregas
${o.repro ? "\n### Cenário: reprodução do defeito (FAIL_TO_PASS)\n- **Dado** uma entrega com acento no nome\n- **Quando** exporta o CSV\n- **Então** o nome sai corrompido hoje (teste falha)\n" : ""}
## Compatibilidade
- Tipo (SemVer): ${o.compat ?? "MINOR"}
- breaking: false

## Impacto
\`\`\`yaml
files_allowed:
  - "apps/api/src/deliveries/**"
  - "tests/**"
\`\`\`
`;
const RFC_BAD = "# RFC-0009 — Vago\n\n## Sumário\nFazer melhor.\n\n## Critérios de aceite\nDeve funcionar bem.\n";

const BOUNDARY = "----f26cards";
function multipart(fields: Record<string, string>, files: Array<{ filename: string; content: Buffer }> = []) {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(f.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
const TXT = Buffer.from("regra: o CSV usa ponto e vírgula\n", "utf-8");

describePg("Fase 2 / 2.6 — API de cards (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];

  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([cardRoutes, ticketRoutes, projectRoutes]);
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    evolveTestHooks.fault = undefined;
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });
  afterEach(() => { evolveTestHooks.fault = undefined; vi.unstubAllEnvs(); });

  const as = (s: Seed, role = "tenant_admin") => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role, tenantId: s.tenantId });
  const flagOn = (tenantId: string) => pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [tenantId]);
  const mk = async (o: { budgetUsd?: number | null; flag?: boolean } = {}) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: o.budgetUsd === undefined ? 50 : o.budgetUsd });
    seeds.push(s);
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
    const dir = join(s.uploadDir, draftId, relDir);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, filename);
    writeFileSync(fp, content, "utf-8");
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1,$2,$3,'text/markdown',$4,false,$5) ON CONFLICT (project_id, rel_dir, filename) DO UPDATE SET file_path = EXCLUDED.file_path, content_sha256 = EXCLUDED.content_sha256`,
      [draftId, filename, fp, relDir, sha256(content)],
    );
  };
  const addRfc = (s: Seed, draftId: string, o: Parameters<typeof rfc>[0] = {}) =>
    addDraftFile(s, draftId, "docs/rfc", `RFC-${String(o.n ?? 1).padStart(4, "0")}-exportar-csv.md`, rfc(o));
  const post = (s: Seed, path: string, payload?: unknown) => { as(s); return app.inject({ method: "POST", url: path, ...(payload ? { payload } : {}) }); };
  const get = (s: Seed, path: string) => { as(s); return app.inject({ method: "GET", url: path }); };
  const stateOf = async (id: string) => (await pool.query("SELECT card_state, status, child_project_id FROM tickets WHERE id = $1", [id])).rows[0] as { card_state: string; status: string; child_project_id: string | null };
  const eventsOf = async (id: string) => (await pool.query("SELECT to_state FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows.map((r) => r.to_state as string);
  /** card pronto (draft → ready) com RFC válido do tipo pedido */
  const readyCard = async (s: Seed, o: { kind?: string; rfc?: Parameters<typeof rfc>[0] } = {}) => {
    const kind = o.kind ?? "feature";
    const c = await create(s, { kind });
    await addRfc(s, c.draftProjectId, o.rfc ?? { compat: "MINOR", nonGoals: true });
    const r = await post(s, `/api/cards/${c.id}/ready`);
    expect(r.statusCode, r.body).toBe(200);
    return c;
  };

  // ───────────────────────────────────────────────────────────────────────────────────────────
  it("flag OFF: toda rota de card responde 404 (capabilities 200 false) e os escritores legados seguem idênticos", async () => {
    const s = await mk({ flag: false });
    expect((await get(s, `/api/products/${s.productId}/cards/capabilities`)).json()).toEqual({ cardsBancada: false });
    const c = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", body: "x" });
    expect(c.statusCode).toBe(404);
    expect(c.json()).toEqual({ code: "NOT_FOUND", message: "Recurso indisponível" });
    expect((await get(s, `/api/products/${s.productId}/cards`)).statusCode).toBe(404);
    const t = await seedTicket(pool, s);
    for (const [m, u] of [["GET", `/api/cards/${t.id}`], ["PATCH", `/api/cards/${t.id}`], ["DELETE", `/api/cards/${t.id}`], ["POST", `/api/cards/${t.id}/promote`], ["POST", `/api/cards/${t.id}/ready`], ["GET", `/api/cards/${t.id}/base-spec`]] as const) {
      as(s);
      const r = await app.inject({ method: m, url: u, ...(m === "PATCH" ? { payload: { body: "y" } } : {}) });
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    // ticket legado: nada de card
    const row = await stateOf(t.id);
    expect(row).toMatchObject({ card_state: null, status: "open" });
    expect((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id = $1", [t.id])).rows[0].n).toBe(0);
    ev("flag-off", { rotasCard: 404, capabilities: false });
  });

  it("rotas antigas de TICKET LEGADO respondem igual com a flag ligada ou desligada (byte a byte, normalizados ids e datas)", async () => {
    const norm = (b: string) => b.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>");
    const run = async (s: Seed) => {
      as(s);
      const t = await seedTicket(pool, s, { body: "Pedido legado." });
      const out: string[] = [];
      for (const [m, u, p] of [
        ["GET", `/api/products/${s.productId}/tickets`, undefined], ["GET", `/api/tickets/${t.id}`, undefined],
        ["PATCH", `/api/tickets/${t.id}`, { title: "Novo título", body: "Texto novo" }], ["PATCH", `/api/tickets/${t.id}`, { status: "rejected" }],
        ["PATCH", `/api/tickets/${t.id}`, { status: "delivered" }], ["DELETE", `/api/tickets/${t.id}`, undefined],
      ] as const) {
        const r = await app.inject({ method: m, url: u, ...(p ? { payload: p } : {}) });
        out.push(`${m} ${r.statusCode} ${norm(r.body)}`);
      }
      return out;
    };
    const off = await run(await mk({ flag: false }));
    const on = await run(await mk({ flag: true }));
    expect(on).toEqual(off);
    ev("legado-identico", { respostas: off.length });
  });

  it("autorização por tenant: outro tenant não vê, não lista e não muda card alheio (404 antes da flag)", async () => {
    const A = await mk(), B = await mk();
    const c = await create(A);
    for (const [m, u] of [["GET", `/api/cards/${c.id}`], ["PATCH", `/api/cards/${c.id}`], ["POST", `/api/cards/${c.id}/refine`], ["POST", `/api/cards/${c.id}/ready`], ["POST", `/api/cards/${c.id}/promote`], ["POST", `/api/cards/${c.id}/reject`], ["DELETE", `/api/cards/${c.id}`], ["GET", `/api/cards/${c.id}/base-spec`]] as const) {
      as(B);
      const r = await app.inject({ method: m, url: u, ...(m === "PATCH" ? { payload: { body: "y" } } : {}) });
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await get(B, `/api/products/${A.productId}/cards`)).statusCode).toBe(404);
    expect((await post(B, `/api/products/${A.productId}/cards`, { kind: "feature", body: "x" })).statusCode).toBe(404);
    const lb = (await get(B, `/api/products/${B.productId}/cards`)).json();
    expect(lb.total).toBe(0);
    expect((await stateOf(c.id)).card_state).toBe("draft");
    // conta de gestão e token de serviço não mutam
    as(A, "zentriz_admin");
    expect((await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { body: "gestão" } })).statusCode).toBe(403);
    ev("tenant", { outroTenant: 404, gestao: 403 });
  });

  it("ciclo completo: criar → refinar → pronto → promover → in_factory (rascunho sem versão, filho com a spec do card)", async () => {
    const s = await mk();
    const before = (await pool.query("SELECT count(*)::int AS n FROM projects WHERE product_id = $1", [s.productId])).rows[0].n as number;
    const c = await create(s, { kind: "feature" });
    expect(c).toMatchObject({ state: "draft", status: "open", code: "TK-0001", kind: "feature" });

    // rascunho A': sem pai, sem versão, só a pasta do card — nada do HEAD, nada de apps/ nem clone
    const d = (await pool.query("SELECT status, version_number, parent_project_id, budget_owner_project_id, extra FROM projects WHERE id = $1", [c.draftProjectId])).rows[0];
    expect(d).toMatchObject({ status: "card_draft", version_number: 0, parent_project_id: null, budget_owner_project_id: s.parentId });
    expect(d.extra).toMatchObject({ card: true, evolution: true, card_ticket_id: c.id, evolution_parent_id: s.parentId, card_base: { head_project_id: s.parentId } });
    const files = (await pool.query("SELECT rel_dir, filename, spec_origin FROM project_spec_files WHERE project_id = $1", [c.draftProjectId])).rows;
    expect(files).toEqual([{ rel_dir: "tickets/TK-0001", filename: "request.md", spec_origin: "card:TK-0001" }]);
    expect(existsSync(join(s.uploadDir, c.draftProjectId, "spec.md"))).toBe(false);
    expect(existsSync(join(process.env.PROJECT_FILES_ROOT || "/nonexistent", c.draftProjectId, "apps"))).toBe(false);
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM projects WHERE product_id = $1", [s.productId])).rows[0].n).toBe(before + 1);
    expect((await pool.query("SELECT card_state, child_project_id, draft_project_id FROM tickets WHERE id = $1", [c.id])).rows[0]).toMatchObject({ draft_project_id: c.draftProjectId, child_project_id: null });

    // refinar (edição de texto: 1ª escrita ⇒ refining; request.md do rascunho acompanha)
    const p = await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { body: "Exportar entregas em CSV com ponto e vírgula." } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().state).toBe("refining");
    expect(readFileSync(join(s.uploadDir, c.draftProjectId, "tickets/TK-0001/request.md"), "utf-8")).toContain("ponto e vírgula");

    // pronto: sem RFC ⇒ 409 do gate base e o estado não muda
    const no = await post(s, `/api/cards/${c.id}/ready`);
    expect(no.statusCode).toBe(409);
    expect(no.json().code).toBe("EVOLUTION_RFC_REQUIRED");
    expect((await stateOf(c.id)).card_state).toBe("refining");
    await addRfc(s, c.draftProjectId, { compat: "MINOR", nonGoals: true });
    const ok = await post(s, `/api/cards/${c.id}/ready`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().card.state).toBe("ready");
    const extra = (await pool.query("SELECT extra FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].extra;
    expect(extra.card_ready).toMatchObject({ base_head_project_id: s.parentId, base_head_version: 1 });
    expect(extra.card_ready.draft_spec_hash).toMatch(/^[0-9a-f]{64}$/);
    // edição em ready exige refine antes
    expect((await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { body: "z" } })).statusCode).toBe(409);

    // promover
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(201);
    const body = pr.json();
    expect(body).toMatchObject({ ok: true, versionNumber: 2, parentProjectId: s.parentId, cardState: "promoted", cardStatus: "promoted", draftProjectId: c.draftProjectId });
    const kids = await childrenOf(pool, s.parentId);
    expect(kids.length).toBe(1);
    expect(kids[0]).toMatchObject({ id: body.childProjectId, status: "spec_submitted", version_number: 2, budget_owner_project_id: s.parentId });
    expect(kids[0].extra).toMatchObject({ ticket_id: c.id, ticket_kind: "feature", card_draft_project_id: c.draftProjectId, evolution: true, evolution_branch: "evolution/v2" });
    const kf = (await pool.query("SELECT rel_dir, filename, spec_origin FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename", [body.childProjectId])).rows;
    expect(kf).toEqual(expect.arrayContaining([
      expect.objectContaining({ rel_dir: "docs/rfc", filename: "RFC-0001-exportar-csv.md", spec_origin: "card:TK-0001" }),
      expect.objectContaining({ rel_dir: "tickets/TK-0001", filename: "request.md", spec_origin: "card:TK-0001" }),
      expect.objectContaining({ filename: "spec-evolution-v2.md" }),
    ]));
    expect((await stateOf(c.id))).toMatchObject({ card_state: "promoted", status: "promoted", child_project_id: body.childProjectId });
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].status).toBe("card_draft");
    // repetir ⇒ 200 replayed, mesmo filho
    const again = await post(s, `/api/cards/${c.id}/promote`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, childProjectId: body.childProjectId });
    expect((await childrenOf(pool, s.parentId)).length).toBe(1);
    // o filho entra na fábrica ⇒ in_factory pela máquina (gancho do início da fábrica / sync)
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [body.childProjectId]);
    await syncCardForChildProject(pool, body.childProjectId);
    expect(await eventsOf(c.id)).toEqual(["draft", "refining", "ready", "promoted", "in_factory"]);
    const det = (await get(s, `/api/cards/${c.id}`)).json();
    expect(det).toMatchObject({ state: "in_factory", executionStatus: "running", childProjectId: body.childProjectId, actions: { promote: false, edit: false } });
    ev("ciclo", { eventos: await eventsOf(c.id), versao: body.versionNumber, arquivosDoFilho: kf.length });
  });

  it("corrida de promoções do MESMO card ⇒ exatamente 1 filho (1 criado, as demais replayed/em progresso)", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const rs = await raceN(6, () => post(s, `/api/cards/${c.id}/promote`));
    const codes = rs.map((r) => r.statusCode);
    expect(codes.filter((x) => x === 201).length).toBe(1);
    for (const r of rs) if (r.statusCode === 409) expect(r.json().code).toBe("MATERIALIZATION_IN_PROGRESS");
    expect((await childrenOf(pool, s.parentId)).length).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'promoted'", [c.id])).rows[0].n).toBe(1);
    ev("corrida-mesmo-card", { respostas: codes.sort() });
  });

  it("2 cards promovidos em sequência: v2 e v3; o segundo com base vencida ⇒ CARD_BASE_STALE até revalidar", async () => {
    const s = await mk();
    const A = await readyCard(s, { rfc: { n: 1, compat: "MINOR", nonGoals: true } });
    const B = await readyCard(s, { rfc: { n: 1, compat: "MINOR", nonGoals: true, title: "Filtro por data" } });
    const pa = await post(s, `/api/cards/${A.id}/promote`);
    expect(pa.statusCode, pa.body).toBe(201);
    expect(pa.json().versionNumber).toBe(2);
    // v2 ainda não aceita ⇒ 1 filho vivo por serviço; o card B continua ready
    const inflight = await post(s, `/api/cards/${B.id}/promote`);
    expect(inflight.statusCode).toBe(409);
    expect(inflight.json().code).toBe("CARD_PREVIOUS_IN_PROGRESS");
    expect((await stateOf(B.id)).card_state).toBe("ready");
    // v2 aceita ⇒ o HEAD mudou ⇒ base de B vencida
    await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [pa.json().childProjectId]);
    const stale = await post(s, `/api/cards/${B.id}/promote`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CARD_BASE_STALE", expectedHead: s.parentId, currentHead: pa.json().childProjectId, revalidate: `POST /api/cards/${B.id}/revalidate` });
    expect((await stateOf(B.id)).card_state).toBe("refining");
    expect((await post(s, `/api/cards/${B.id}/promote`)).json().code).toBe("CARD_NOT_READY");
    expect((await childrenOf(pool, pa.json().childProjectId)).length).toBe(0);
    // revalidar ⇒ base nova; valida de novo; promove como v3 sobre a v2
    const rv = await post(s, `/api/cards/${B.id}/revalidate`);
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json().base).toMatchObject({ headProjectId: pa.json().childProjectId, headVersion: 2, previousHeadProjectId: s.parentId });
    // Y-02/Y-08: o HEAD agora (v2) já tem o RFC-0001 do card A; o card B não pode reescrevê-lo ⇒ "Validar" recusa até renumerar.
    const clash = await post(s, `/api/cards/${B.id}/ready`);
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().code).toBe("CARD_PATH_COLLIDES_WITH_BASE");
    await pool.query("DELETE FROM project_spec_files WHERE project_id = $1 AND filename = 'RFC-0001-exportar-csv.md'", [B.draftProjectId]);
    await addRfc(s, B.draftProjectId, { n: 2, compat: "MINOR", nonGoals: true, title: "Filtro por data" });
    expect((await post(s, `/api/cards/${B.id}/ready`)).statusCode).toBe(200);
    const pb = await post(s, `/api/cards/${B.id}/promote`);
    expect(pb.statusCode, pb.body).toBe(201);
    expect(pb.json()).toMatchObject({ versionNumber: 3, parentProjectId: pa.json().childProjectId });
    expect((await childrenOf(pool, pa.json().childProjectId))[0].extra).toMatchObject({ evolution_branch: "evolution/v3", ticket_id: B.id });
    ev("sequencia", { v: [pa.json().versionNumber, pb.json().versionNumber], staleCode: stale.json().code });
  });

  it("spec do rascunho alterada depois do 'pronto' ⇒ 409 CARD_NOT_READY e o card volta a refining", async () => {
    const s = await mk();
    const c = await readyCard(s);
    await addDraftFile(s, c.draftProjectId, "docs", "nota.md", "# nota nova\n");
    const r = await post(s, `/api/cards/${c.id}/promote`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "CARD_NOT_READY", state: "refining" });
    expect((await stateOf(c.id)).card_state).toBe("refining");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
  });

  it("crash entre passos da promoção ⇒ a repetição retoma do ponto da falha (lease vencido) sem duplicar", async () => {
    const s = await mk();
    const c = await readyCard(s);
    evolveTestHooks.fault = (point) => { if (point === "before:card_spec") throw new SimulatedCrash(point); };
    const crashed = await post(s, `/api/cards/${c.id}/promote`);
    expect(crashed.statusCode).toBe(500);
    evolveTestHooks.fault = undefined;
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect(kid.status).toBe("materializing");
    expect(Object.keys((kid.extra.materialization as { steps: Record<string, unknown> }).steps)).toEqual(expect.arrayContaining(["spec_tree", "code", "ticket"]));
    expect((await stateOf(c.id)).card_state).toBe("promoted");
    // enquanto o lease vale: em progresso
    const busy = await post(s, `/api/cards/${c.id}/promote`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe("MATERIALIZATION_IN_PROGRESS");
    // lease vencido ⇒ retoma
    await pool.query(`UPDATE projects SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() - interval '1 minute')) WHERE id = $1`, [kid.id]);
    const resumed = await post(s, `/api/cards/${c.id}/promote`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json()).toMatchObject({ resumed: true, childProjectId: kid.id, versionNumber: 2 });
    const done = (await childrenOf(pool, s.parentId));
    expect(done.length).toBe(1);
    expect(done[0].status).toBe("spec_submitted");
    expect((await pool.query("SELECT 1 FROM project_spec_files WHERE project_id = $1 AND rel_dir = 'docs/rfc'", [kid.id])).rowCount).toBe(1);
    ev("crash-retomada", { passos: Object.keys((done[0].extra.materialization as { steps: Record<string, unknown> }).steps) });
  });

  it("falha terminal da materialização ⇒ card blocked (filho failed); resume devolve a ready e promove de novo", async () => {
    const s = await mk();
    const c = await readyCard(s);
    // o arquivo do rascunho some do disco DURANTE a materialização (depois do carimbo "pronto") ⇒ falha TERMINAL do passo card_spec
    const f = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND rel_dir = 'docs/rfc'", [c.draftProjectId])).rows[0].file_path as string;
    const saved = readFileSync(f, "utf-8");
    evolveTestHooks.fault = (point) => { if (point === "before:card_spec") unlinkSync(f); };
    const r = await post(s, `/api/cards/${c.id}/promote`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().code).toBe("CARD_DRAFT_UNREADABLE");
    expect(await stateOf(c.id)).toMatchObject({ card_state: "blocked", status: "promoted" });
    expect((await pool.query("SELECT blocked_reason FROM tickets WHERE id = $1", [c.id])).rows[0].blocked_reason).toBe("materialization_failed:CARD_DRAFT_UNREADABLE");
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect(kid.status).toBe("failed");
    // promover um card bloqueado sem filho vivo: 409 com a instrução
    expect((await post(s, `/api/cards/${c.id}/promote`)).json().code).toBe("CARD_NOT_READY");
    // arquivo de volta (mesmo conteúdo ⇒ mesmo hash); resume: filho morto ⇒ ready (vínculo limpo)
    evolveTestHooks.fault = undefined;
    writeFileSync(f, saved);
    const rs = await post(s, `/api/cards/${c.id}/resume`);
    expect(rs.statusCode, rs.body).toBe(200);
    expect(rs.json().card.state).toBe("ready");
    expect((await stateOf(c.id)).child_project_id).toBeNull();
    const again = await post(s, `/api/cards/${c.id}/promote`);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().versionNumber).toBe(2);
    expect(await eventsOf(c.id)).toEqual(["draft", "ready", "promoted", "blocked", "ready", "promoted"]);
  });

  it("gates por tipo: o gate base é invariante; o tipo só acrescenta exigências", async () => {
    const s = await mk();
    const tryReady = async (kind: string, content: string | null) => {
      const c = await create(s, { kind });
      if (content !== null) await addDraftFile(s, c.draftProjectId, "docs/rfc", "RFC-0001-x.md", content);
      const r = await post(s, `/api/cards/${c.id}/ready`);
      return { code: r.statusCode === 200 ? "OK" : r.json().code as string, message: r.json().message as string | undefined };
    };
    const out: Record<string, string> = {};
    for (const kind of ["evolution", "fix", "feature"]) {
      out[`${kind}/sem-rfc`] = (await tryReady(kind, null)).code;
      out[`${kind}/rfc-invalido`] = (await tryReady(kind, RFC_BAD)).code;
    }
    expect(Object.values(out).filter((v) => v === "EVOLUTION_RFC_REQUIRED").length).toBe(3);
    expect(Object.values(out).filter((v) => v === "EVOLUTION_RFC_INVALID").length).toBe(3);
    // Evolução: rito atual (aceita qualquer compat)
    expect((await tryReady("evolution", rfc({ compat: "MAJOR" }))).code).toBe("OK");
    // Correção: reprodução FAIL_TO_PASS obrigatória; compat > patch ⇒ CARD_KIND_MISMATCH
    const fixNoRepro = await tryReady("fix", rfc({ compat: "PATCH" }));
    expect(fixNoRepro.code).toBe("CARD_KIND_REQUIREMENT");
    expect(fixNoRepro.message).toMatch(/reprodução/);
    expect((await tryReady("fix", rfc({ compat: "MINOR", repro: true }))).code).toBe("CARD_KIND_MISMATCH");
    expect((await tryReady("fix", rfc({ compat: "PATCH", repro: true }))).code).toBe("OK");
    // Recurso novo: Non-goals obrigatório
    const featNo = await tryReady("feature", rfc({ compat: "MINOR" }));
    expect(featNo.code).toBe("CARD_KIND_REQUIREMENT");
    expect(featNo.message).toMatch(/Non-goals/);
    expect((await tryReady("feature", rfc({ compat: "MINOR", nonGoals: true }))).code).toBe("OK");
    // trocar o tipo pelo PATCH muda a exigência (e a request.md/extra.ticket_kind do rascunho acompanham)
    const c = await create(s, { kind: "evolution" });
    await addDraftFile(s, c.draftProjectId, "docs/rfc", "RFC-0001-x.md", rfc({ compat: "MINOR" }));
    expect((await app.inject({ method: "PATCH", url: `/api/cards/${c.id}`, payload: { kind: "feature" } })).statusCode).toBe(200);
    expect((await pool.query("SELECT extra->>'card_ticket_kind' AS k FROM projects WHERE id = $1", [c.draftProjectId])).rows[0].k).toBe("feature");
    expect((await post(s, `/api/cards/${c.id}/ready`)).json().code).toBe("CARD_KIND_REQUIREMENT");
    ev("gates", out);
  });

  it("o tipo chega à Fábrica por extra.ticket_kind (fix) e o rótulo vai no cabeçalho da spec do filho", async () => {
    const s = await mk();
    const c = await readyCard(s, { kind: "fix", rfc: { compat: "PATCH", repro: true } });
    const r = await post(s, `/api/cards/${c.id}/promote`);
    expect(r.statusCode, r.body).toBe(201);
    const kid = (await childrenOf(pool, s.parentId))[0];
    expect(kid.extra.ticket_kind).toBe("fix");
    const prim = (await pool.query("SELECT file_path FROM project_spec_files WHERE project_id = $1 AND is_primary", [kid.id])).rows[0].file_path as string;
    expect(readFileSync(prim, "utf-8")).toContain("(TK-0001 · correção)");
  });

  it("orçamento: sem dono ⇒ 402 BUDGET_MISSING na criação; saldo livre mínimo (config) barra 'pronto' e promoção sem mudar o card", async () => {
    const sNo = await mk({ budgetUsd: null });
    as(sNo);
    const r0 = await post(sNo, `/api/products/${sNo.productId}/cards`, { kind: "feature", body: "x" });
    expect(r0.statusCode).toBe(402);
    expect(r0.json().code).toBe("BUDGET_MISSING");
    const s = await mk({ budgetUsd: 50 });
    const c = await readyCard(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('EVOLVE_MIN_FREE_BUDGET_USD', '60', $1)", [s.tenantId]);
    const p = await post(s, `/api/cards/${c.id}/promote`);
    expect(p.statusCode).toBe(402);
    expect(p.json()).toMatchObject({ code: "BUDGET_FREE_BELOW_MIN", minFreeUsd: 60 });
    expect((await stateOf(c.id)).card_state).toBe("ready");
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    const c2 = await create(s);
    await addRfc(s, c2.draftProjectId, { compat: "MINOR", nonGoals: true });
    expect((await post(s, `/api/cards/${c2.id}/ready`)).statusCode).toBe(402);
    await pool.query("UPDATE genesis_runtime_config SET value = '10' WHERE key = 'EVOLVE_MIN_FREE_BUDGET_USD' AND tenant_id = $1", [s.tenantId]);
    expect((await post(s, `/api/cards/${c.id}/promote`)).statusCode).toBe(201);
  });

  it("serviço: produto com 2 serviços exige projectId (um serviço por card)", async () => {
    const s = await mk();
    const other = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, budget_usd) VALUES ($1,$2,'Outro serviço','accepted',$3,1,30) RETURNING id`,
      [s.tenantId, s.userId, s.productId]);
    const r = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", body: "x" });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("SERVICE_REQUIRED");
    expect(r.json().services.length).toBe(2);
    const ok = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", body: "x", projectId: other.rows[0].id });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().projectId).toBe(other.rows[0].id);
    const bad = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", body: "x", projectId: randomUUID() });
    expect(bad.statusCode).toBe(400);
  });

  it("listagem: filtros por estado/tipo/origem, paginação e total; validação de parâmetros", async () => {
    const s = await mk();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(s, { kind: i % 2 ? "fix" : "feature", title: `Card ${i}` })).id);
    await post(s, `/api/cards/${ids[0]}/refine`);
    await post(s, `/api/cards/${ids[1]}/reject`);
    const l = (await get(s, `/api/products/${s.productId}/cards`)).json();
    expect(l).toMatchObject({ total: 5, limit: 20, offset: 0 });
    expect(l.items.map((x: { title: string }) => x.title)).toEqual(["Card 4", "Card 3", "Card 2", "Card 1", "Card 0"]);
    expect(l.items[0]).toMatchObject({ state: "draft", origin: "manual", code: "TK-0005", draftProjectId: expect.any(String), childProjectId: null });
    expect((await get(s, `/api/products/${s.productId}/cards?state=refining,rejected`)).json().total).toBe(2);
    expect((await get(s, `/api/products/${s.productId}/cards?kind=fix`)).json().total).toBe(2);
    expect((await get(s, `/api/products/${s.productId}/cards?origin=import`)).json().total).toBe(0);
    const pg2 = (await get(s, `/api/products/${s.productId}/cards?limit=2&offset=2`)).json();
    expect(pg2).toMatchObject({ total: 5, limit: 2, offset: 2 });
    expect(pg2.items.map((x: { title: string }) => x.title)).toEqual(["Card 2", "Card 1"]);
    // teto de página vem de genesis_runtime_config
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_LIST_PAGE_MAX', '3', $1)", [s.tenantId]);
    expect((await get(s, `/api/products/${s.productId}/cards?limit=100`)).json().limit).toBe(3);
    expect((await get(s, `/api/products/${s.productId}/cards?state=nada`)).statusCode).toBe(400);
    expect((await get(s, `/api/products/${s.productId}/cards?kind=nada`)).statusCode).toBe(400);
    // tickets legados não aparecem na lista de cards
    await seedTicket(pool, s);
    expect((await get(s, `/api/products/${s.productId}/cards`)).json().total).toBe(5);
  });

  it("transições só pela máquina: refine/ready/reject idempotentes e auditadas; inválidas ⇒ 409 CARD_INVALID_TRANSITION", async () => {
    const s = await mk();
    const c = await create(s);
    expect((await post(s, `/api/cards/${c.id}/refine`)).json()).toMatchObject({ ok: true, replayed: false, card: { state: "refining" } });
    expect((await post(s, `/api/cards/${c.id}/refine`)).json()).toMatchObject({ replayed: true });
    expect((await post(s, `/api/cards/${c.id}/resume`)).statusCode).toBe(409); // não bloqueado
    const prom = await post(s, `/api/cards/${c.id}/promote`);
    expect(prom.statusCode).toBe(409);
    expect(prom.json()).toMatchObject({ code: "CARD_NOT_READY", state: "refining" });
    expect((await post(s, `/api/cards/${c.id}/reject`)).statusCode).toBe(200);
    expect((await post(s, `/api/cards/${c.id}/reject`)).json().replayed).toBe(true);
    const inv = await post(s, `/api/cards/${c.id}/refine`);
    expect(inv.statusCode).toBe(409);
    expect(inv.json()).toMatchObject({ code: "CARD_INVALID_TRANSITION", from: "rejected", to: "refining" });
    expect((await post(s, `/api/cards/${c.id}/ready`)).statusCode).toBe(409);
    expect(await eventsOf(c.id)).toEqual(["draft", "refining", "rejected"]);
    expect((await stateOf(c.id))).toMatchObject({ card_state: "rejected", status: "rejected" });
  });

  it("exclusão só em draft, com CAS no banco (corrida delete × refine: nunca os dois)", async () => {
    const s = await mk();
    const a = await create(s);
    const del = await app.inject({ method: "DELETE", url: `/api/cards/${a.id}` });
    expect(del.statusCode).toBe(204);
    expect((await pool.query("SELECT 1 FROM tickets WHERE id = $1", [a.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM projects WHERE id = $1", [a.draftProjectId])).rowCount).toBe(0);
    const b = await create(s);
    await post(s, `/api/cards/${b.id}/refine`);
    const no = await app.inject({ method: "DELETE", url: `/api/cards/${b.id}` });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toMatchObject({ code: "CARD_NOT_DELETABLE", state: "refining" });
    // corrida
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await create(s);
      as(s);
      const [d, r] = await raceN(2, (k) => k === 0 ? app.inject({ method: "DELETE", url: `/api/cards/${c.id}` }) : app.inject({ method: "POST", url: `/api/cards/${c.id}/refine` }));
      const exists = (await pool.query("SELECT card_state FROM tickets WHERE id = $1", [c.id])).rows[0]?.card_state ?? null;
      if (d.statusCode === 204) { expect(exists).toBeNull(); expect([404, 200].includes(r.statusCode)).toBe(true); outcomes.push("deleted"); }
      else { expect(d.statusCode).toBe(409); expect(exists).toBe("refining"); outcomes.push("refined"); }
    }
    ev("delete-corrida", { outcomes });
  });

  it("PATCH legado de ticket-card passa pela máquina e mantém o contrato de resposta do ticket", async () => {
    const s = await mk();
    const c = await readyCard(s);
    as(s);
    // Fase 3 (3.3): texto em 'ready' NÃO reabre mais sozinho — 409 CARD_SPEC_LOCKED até o `reopen` explícito (antes: ready → refining automático).
    const locked = await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { title: "Novo título", body: "Texto revisado." } });
    expect(locked.statusCode, locked.body).toBe(409);
    expect(locked.json()).toMatchObject({ code: "CARD_SPEC_LOCKED", state: "ready", canReopen: true });
    expect((await stateOf(c.id)).card_state).toBe("ready");
    expect((await post(s, `/api/cards/${c.id}/reopen`)).statusCode).toBe(200);
    // resposta no formato do ticket (code, execution_status, attachments_count)
    const e = await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { title: "Novo título", body: "Texto revisado." } });
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json()).toMatchObject({ id: c.id, title: "Novo título", body: "Texto revisado.", code: "TK-0001", status: "open", execution_status: null, attachments_count: 0, card_state: "refining" });
    expect(readFileSync(join(s.uploadDir, c.draftProjectId, "tickets/TK-0001/request.md"), "utf-8")).toContain("Texto revisado.");
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { status: "open" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { status: "delivered" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { changeKind: "nada" } })).statusCode).toBe(400);
    const rej = await app.inject({ method: "PATCH", url: `/api/tickets/${c.id}`, payload: { status: "rejected" } });
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toMatchObject({ status: "rejected", card_state: "rejected" });
    expect(await eventsOf(c.id)).toEqual(["draft", "ready", "refining", "rejected"]);
    expect((await stateOf(c.id)).card_state).toBe("rejected");
    // promovido ⇒ texto imutável como no legado; entrega manual recusada
    const d = await readyCard(s);
    expect((await post(s, `/api/cards/${d.id}/promote`)).statusCode).toBe(201);
    const imm = await app.inject({ method: "PATCH", url: `/api/tickets/${d.id}`, payload: { body: "tarde demais" } });
    expect(imm.statusCode).toBe(409);
    expect(imm.json().code).toBe("TICKET_IMMUTABLE");
    const del = await app.inject({ method: "PATCH", url: `/api/tickets/${d.id}`, payload: { status: "delivered" } });
    expect(del.json().code).toBe("CARD_DELIVERY_IS_AUTOMATIC");
    // DELETE legado de card promovido: recusa; de card em draft: apaga com o rascunho
    expect((await app.inject({ method: "DELETE", url: `/api/tickets/${d.id}` })).statusCode).toBe(409);
    const e2 = await create(s);
    expect((await app.inject({ method: "DELETE", url: `/api/tickets/${e2.id}` })).statusCode).toBe(204);
    expect((await pool.query("SELECT 1 FROM projects WHERE id = $1", [e2.draftProjectId])).rowCount).toBe(0);
  });

  it("/evolve legado com ticket-card ⇒ 409 USE_CARD_PROMOTE (com ou sem EVOLVE_CLAIM) e nada é criado", async () => {
    const s = await mk();
    const c = await readyCard(s);
    for (const claim of ["off", "on"]) {
      vi.stubEnv("EVOLVE_CLAIM", claim);
      as(s);
      const r = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "x", ticketId: c.id } });
      expect(r.statusCode, `claim=${claim} ${r.body}`).toBe(409);
      expect(r.json()).toMatchObject({ code: "USE_CARD_PROMOTE", cardId: c.id });
    }
    expect((await childrenOf(pool, s.parentId)).length).toBe(0);
    expect((await stateOf(c.id)).card_state).toBe("ready");
    // AB-02: com a flag LIGADA no tenant do projeto, ticket legado também é recusado (USE_CARDS); sem a flag continua promovendo
    const t = await seedTicket(pool, s);
    as(s);
    const legacyOn = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "x", ticketId: t.id } });
    expect(legacyOn.statusCode, legacyOn.body).toBe(409);
    expect(legacyOn.json().code).toBe("USE_CARDS");
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
    expect((await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "x", ticketId: t.id } })).statusCode).toBe(201);
  });

  it("reopenTicketsOfChild e o reconciliador deixam card_state/eventos coerentes (card ⇒ ready; legado intacto)", async () => {
    const s = await mk();
    const c = await readyCard(s);
    const pr = await post(s, `/api/cards/${c.id}/promote`);
    const childId = pr.json().childProjectId as string;
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [childId]);
    await syncCardForChildProject(pool, childId);
    expect((await stateOf(c.id)).card_state).toBe("in_factory");
    // descarte do filho ⇒ card volta a ready, vínculo limpo, evento auditado
    expect(await reopenTicketsOfChild(pool, childId, { strict: true, reason: "child_deleted" })).toBe(1);
    expect(await stateOf(c.id)).toMatchObject({ card_state: "ready", status: "open", child_project_id: null });
    expect(await eventsOf(c.id)).toEqual(["draft", "ready", "promoted", "in_factory", "ready"]);
    expect(await reopenTicketsOfChild(pool, childId)).toBe(0); // repetir: nada
    // o filho aceito move o HEAD ⇒ outro card pronto sobre a base antiga fica com base vencida
    const d = await readyCard(s, { rfc: { n: 2, compat: "MINOR", nonGoals: true } });
    await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [childId]);
    const pd = await post(s, `/api/cards/${d.id}/promote`);
    expect(pd.json().code).toBe("CARD_BASE_STALE"); // o filho aceito (v2) virou o HEAD; o card pronto antes dele tem base vencida
    // Q1: claim vencido sem efeitos de um card promovido ⇒ ready pela máquina
    const e = await readyCard(s, { rfc: { n: 3, compat: "MINOR", nonGoals: true } });
    const claimed = await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id, extra)
       VALUES ($1,$2,'claim','materializing',$3,$4,9,$4, jsonb_build_object('evolution', true, 'ticket_id', $5::text, 'materialization', jsonb_build_object('lease_until', (now() - interval '1 hour'), 'steps', '{}'::jsonb)))
       RETURNING id`, [s.tenantId, s.userId, s.productId, childId, e.id]);
    await pool.query("UPDATE tickets SET card_state = 'promoted', status = 'promoted', child_project_id = $2 WHERE id = $1", [e.id, claimed.rows[0].id]);
    expect(await cleanExpiredClaim(pool, { id: claimed.rows[0].id, root: s.parentId }, resolveReconcilerParams({}))).toBe(true);
    expect(await stateOf(e.id)).toMatchObject({ card_state: "ready", status: "open", child_project_id: null });
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [claimed.rows[0].id])).rows[0].status).toBe("failed");
    ev("reabertura", { eventos: await eventsOf(c.id) });
  });

  it("reconciliador (shadow): divergência card_state × status vira achado card_status_divergence e some quando corrigida", async () => {
    const s = await mk();
    const c = await create(s);
    await pool.query("UPDATE tickets SET status = 'delivered' WHERE id = $1", [c.id]); // escritor antigo mexeu só no status
    const env = { EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv;
    // outro arquivo de teste pode segurar o lock de sessão do job (mesmo banco): tenta de novo até obter a passada
    let r1 = await runReconcilerPass(pool, env);
    for (let i = 0; i < 40 && r1.skipped === "locked"; i++) { await new Promise((res) => setTimeout(res, 250)); r1 = await runReconcilerPass(pool, env); }
    expect(r1.skipped).toBeUndefined();
    expect(r1.byKind.card_status_divergence).toBeGreaterThanOrEqual(1);
    const h = hashId(c.id);
    const f = (await pool.query("SELECT kind, severity, resolved_at, detail FROM evolve_reconciler_findings WHERE kind = 'card_status_divergence' AND entity_hash = $1", [h])).rows;
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0]).toMatchObject({ severity: "warning", resolved_at: null, detail: { expected_status: "open" } });
    // sem limpeza automática: nada foi corrigido
    expect((await stateOf(c.id))).toMatchObject({ card_state: "draft", status: "delivered" });
    // a máquina recusa enquanto diverge
    expect((await post(s, `/api/cards/${c.id}/refine`)).json().code).toBe("CARD_DIVERGED");
    await pool.query("UPDATE tickets SET status = 'open' WHERE id = $1", [c.id]);
    let r2 = await runReconcilerPass(pool, env);
    for (let i = 0; i < 40 && r2.skipped === "locked"; i++) { await new Promise((res) => setTimeout(res, 250)); r2 = await runReconcilerPass(pool, env); }
    expect(r2.skipped).toBeUndefined();
    const f2 = (await pool.query("SELECT resolved_at FROM evolve_reconciler_findings WHERE kind = 'card_status_divergence' AND entity_hash = $1", [h])).rows;
    expect(f2.length).toBe(1);
    expect(f2[0].resolved_at).not.toBeNull();
    ev("q6", { achados: f.length });
  });

  it("spec-base: devolve a spec da versão corrente em modo somente leitura e marca stale quando o HEAD andou", async () => {
    const s = await mk();
    const c = await create(s);
    const r = await get(s, `/api/cards/${c.id}/base-spec`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ readOnly: true, headProjectId: s.parentId, headVersion: 1, stale: false, baseHeadProjectId: s.parentId });
    expect(b.files.map((f: { path: string }) => f.path)).toContain("spec.md");
    expect(b.files.find((f: { path: string }) => f.path === "spec.md")).toMatchObject({ isPrimary: true, truncated: false, content: expect.stringContaining("Spec do pai") });
    expect(b.specHash).toMatch(/^[0-9a-f]{64}$/);
    // não há rota de escrita da spec-base
    expect((await app.inject({ method: "PUT", url: `/api/cards/${c.id}/base-spec`, payload: {} })).statusCode).toBe(404);
    // teto de bytes vem de config: conteúdo omitido com truncated=true
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARD_BASE_SPEC_MAX_BYTES', '1024', $1)", [s.tenantId]);
    await addDraftFile(s, s.parentId, "docs", "grande.md", "x".repeat(4000));
    const t = (await get(s, `/api/cards/${c.id}/base-spec`)).json();
    expect(t.files.find((f: { path: string }) => f.path === "docs/grande.md")).toMatchObject({ truncated: true, content: null });
    // HEAD anda ⇒ stale
    const kid = await pool.query(`INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id) VALUES ($1,$2,'v2','accepted',$3,$4,2,$4) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId]);
    expect((await get(s, `/api/cards/${c.id}/base-spec`)).json()).toMatchObject({ headProjectId: kid.rows[0].id, headVersion: 2, stale: true });
  });

  it("anexos: sem ATTACHMENTS_STRICT recusa arquivo; com ela txt vai à pasta do card no rascunho e pdf fica só no card", async () => {
    const s = await mk();
    const send = (files: Array<{ filename: string; content: Buffer }>) => { as(s); return app.inject({
      method: "POST", url: `/api/products/${s.productId}/cards`,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart({ kind: "feature", title: "Com anexos", body: "Veja os anexos." }, files),
    }); };
    const off = await send([{ filename: "regras.txt", content: TXT }]);
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe("ATTACHMENTS_UNAVAILABLE");
    vi.stubEnv("ATTACHMENTS_STRICT", "on");
    const bad = await send([{ filename: "planilha.xlsx", content: Buffer.from("PK") }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("ATTACHMENT_INVALID");
    const okr = await send([{ filename: "regras.txt", content: TXT }, { filename: "spec.pdf", content: PDF }]);
    expect(okr.statusCode, okr.body).toBe(201);
    const card = okr.json();
    const df = (await pool.query("SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename", [card.draftProjectId])).rows;
    expect(df).toEqual([{ rel_dir: "tickets/TK-0001", filename: "request.md" }, { rel_dir: "tickets/TK-0001/anexos", filename: "regras.txt" }]);
    expect(card.attachmentsCount).toBe(2);
    const det = (await get(s, `/api/cards/${card.id}`)).json();
    expect(det.attachments.map((a: { filename: string; kind: string }) => [a.filename, a.kind])).toEqual([["regras.txt", "spec_text"], ["spec.pdf", "card_only"]]);
    const dl = await get(s, det.attachments[0].downloadUrl);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("ponto e vírgula");
    // a promoção leva a pasta do card (incl. anexos de texto) ao filho; pdf segue só no card
    await addRfc(s, card.draftProjectId, { compat: "MINOR", nonGoals: true });
    expect((await post(s, `/api/cards/${card.id}/ready`)).statusCode).toBe(200);
    const pr = await post(s, `/api/cards/${card.id}/promote`);
    expect(pr.statusCode, pr.body).toBe(201);
    const kf = (await pool.query("SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1 AND rel_dir LIKE 'tickets/%' ORDER BY rel_dir, filename", [pr.json().childProjectId])).rows;
    expect(kf).toEqual([{ rel_dir: "tickets/TK-0001", filename: "request.md" }, { rel_dir: "tickets/TK-0001/anexos", filename: "regras.txt" }]);
  });

  it("capabilities com a flag ligada e produto arquivado recusa novos cards", async () => {
    const s = await mk();
    expect((await get(s, `/api/products/${s.productId}/cards/capabilities`)).json()).toEqual({ cardsBancada: true });
    await pool.query("UPDATE products SET status = 'archived' WHERE id = $1", [s.productId]);
    const r = await post(s, `/api/products/${s.productId}/cards`, { kind: "feature", body: "x" });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("PRODUCT_ARCHIVED");
  });
});
