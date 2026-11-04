/**
 * Fase 2 / 2.2, 2.3 e 2.5 — flag CARDS_BANCADA por tenant + backfill de card_state e spec_origin + leitura do vínculo task→card,
 * em Postgres REAL, pela rota real `PUT /api/admin/runtime-config/:key`.
 * Roda num BANCO DESCARTÁVEL (a flag GLOBAL e o backfill de todos os tenants não podem tocar dados das outras suítes).
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441). Sem ele: skip.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, uid, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { runtimeConfigRoutes } from "../routes/runtimeConfig.js";
import { projectRoutes } from "../routes/projects.js";
import { backfillCardState, backfillSpecOrigin, runCardsFlagBackfill, awaitCardsBackfillJob, BACKFILL_DEFAULTS } from "./cardsBackfill.js";

const ev = (tag: string, data: unknown) => console.log(`[F2-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 2 / 2.5 — CARDS_BANCADA por tenant + backfill (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let A: Seed;
  let B: Seed;
  const seeds: Seed[] = [];
  const admin = () => Object.assign(testUser, { id: A.userId, role: "zentriz_admin", tenantId: null });
  const tenantAdmin = () => Object.assign(testUser, { id: A.userId, role: "tenant_admin", tenantId: A.tenantId });
  const put = (key: string, value: number, tenantId?: string) =>
    app.inject({ method: "PUT", url: `/api/admin/runtime-config/${key}`, payload: { value, ...(tenantId ? { tenantId } : {}) } });
  const del = (key: string, tenantId: string) => app.inject({ method: "DELETE", url: `/api/admin/runtime-config/${key}?tenantId=${tenantId}` });

  const mkChild = async (s: Seed, status: string): Promise<string> =>
    (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
      [s.tenantId, s.userId, `filho-${status}-${uid()}`, status, s.productId],
    )).rows[0].id as string;
  const cardRow = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason, card_contract_version, updated_at FROM tickets WHERE id = $1", [id])).rows[0];
  const evCount = async (id: string) => Number((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id = $1", [id])).rows[0].n);

  beforeAll(async () => {
    scratch = await createScratchDb("evo_cards");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    A = await seedAcceptedProduct(pool, { budgetUsd: 50, extraFiles: [{ relDir: "docs", filename: "a.md", content: "# a\n" }] });
    B = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(A, B);
    app = await buildApp([runtimeConfigRoutes, projectRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    await scratch?.drop();
  });

  const T: Record<string, string> = {};
  it("preparação: tickets legados de A (todos os status/filhos) e de B; spec com linhagem v1→v2→v3", async () => {
    const mk = async (name: string, status: string, childStatus: string | "missing" | null) => {
      const child = childStatus === null ? null : childStatus === "missing" ? "00000000-0000-4000-8000-0000000000aa" : await mkChild(A, childStatus);
      T[name] = (await seedTicket(pool, A, { status, childProjectId: child })).id;
    };
    await mk("open", "open", null);
    await mk("rejected", "rejected", null);
    await mk("delivered", "delivered", null);
    await mk("prom_pre", "promoted", "spec_submitted");
    await mk("prom_mat", "promoted", "materializing");
    await mk("prom_run", "promoted", "running");
    await mk("prom_acc", "promoted", "accepted");
    await mk("prom_fail", "promoted", "failed");
    await mk("prom_arch", "promoted", "archived");
    await mk("prom_miss", "promoted", "missing");
    T.b_open = (await seedTicket(pool, B)).id;

    // linhagem de spec: P1 (seed) ← P2 (evolução v2) ← P3 (evolução v3)
    const addF = (pid: string, relDir: string, filename: string, primary = false) =>
      pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, rel_dir, is_primary) VALUES ($1,$2,$3,$4,$5)`, [pid, filename, `/tmp/x/${pid}/${relDir}/${filename}`, relDir, primary]);
    const p2 = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'v2','accepted',$3,$4,2,$5::jsonb) RETURNING id`,
      [A.tenantId, A.userId, A.productId, A.parentId, JSON.stringify({ evolution: true, evolution_inherited_spec: [{ path: "docs/a.md", sha: "x" }] })],
    )).rows[0].id as string;
    await addF(p2, "", "spec-evolution-v2.md", true); await addF(p2, "docs", "a.md"); await addF(p2, "tickets/TK-0001", "request.md");
    const p3 = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'v3','spec_submitted',$3,$4,3,$5::jsonb) RETURNING id`,
      [A.tenantId, A.userId, A.productId, p2, JSON.stringify({ evolution: true, evolution_inherited_spec: [{ path: "docs/a.md" }, { path: "tickets/TK-0001/request.md" }] })],
    )).rows[0].id as string;
    await addF(p3, "", "spec-evolution-v3.md", true); await addF(p3, "docs", "a.md"); await addF(p3, "tickets/TK-0001", "request.md");
    T.p2 = p2; T.p3 = p3;
    // rascunho de card (não entra no backfill de origem)
    T.draft = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'rascunho','card_draft',$3,0) RETURNING id`,
      [A.tenantId, A.userId, A.productId],
    )).rows[0].id as string;
    await addF(T.draft, "tickets/TK-0009", "request.md");
    // arquivo de B (tenant sem a flag)
    await addF(B.parentId, "", "extra.md");
    // tarefa de P1 ligada a um card, para a leitura 2.3
    await pool.query(`INSERT INTO project_tasks (project_id, task_id, module, owner_role, card_id, origin_spec_file) VALUES ($1,'TSK-EVO-001','backend','DEV',$2,'docs/a.md')`, [A.parentId, T.open]);
    await pool.query(`INSERT INTO project_tasks (project_id, task_id, module, owner_role) VALUES ($1,'TSK-BE-001','backend','DEV')`, [A.parentId]);
  });

  it("flag OFF: runCardsFlagBackfill não faz nada e as colunas novas seguem NULL; tenant_admin não consegue ligar (403) e nada roda", async () => {
    expect(await runCardsFlagBackfill(pool as never, A.tenantId)).toEqual([]);
    tenantAdmin();
    const r = await put("CARDS_BANCADA", 1);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("ADMIN_ONLY_KEY");
    expect((await del("CARDS_BANCADA", A.tenantId)).statusCode).toBe(403);
    const nulls = await pool.query("SELECT count(*)::int AS n FROM tickets WHERE tenant_id = ANY($1) AND card_state IS NOT NULL", [[A.tenantId, B.tenantId]]);
    expect(nulls.rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM project_spec_files WHERE spec_origin IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE tenant_id = ANY($1))", [[A.tenantId, B.tenantId]])).rows[0].n).toBe(0);
    // leitura 2.3 com a flag off: resposta sem as chaves novas
    const tasks = await app.inject({ method: "GET", url: `/api/projects/${A.parentId}/tasks` });
    expect(tasks.statusCode).toBe(200);
    for (const t of tasks.json()) { expect(t).not.toHaveProperty("cardId"); expect(t).not.toHaveProperty("originSpecFile"); }
  });

  let before: Record<string, { status: string; updated_at: Date }> = {};
  it("liga para A pela rota (zentriz_admin): backfill de card_state — open→draft, promoted conforme o filho, status/updated_at intactos", async () => {
    before = {};
    for (const [k, id] of Object.entries(T)) if (!["p2", "p3", "draft"].includes(k)) before[k] = await cardRow(id);
    admin();
    const r = await put("CARDS_BANCADA", 1, A.tenantId);
    expect(r.statusCode).toBe(200);
    const bf = r.json().cardsBackfill as Array<{ tenantId: string; error?: string; cardState: { byState: Record<string, number>; total: number } }>;
    ev("backfill-card-state", bf);
    expect(bf).toHaveLength(1);
    expect(bf[0].error).toBeUndefined();
    const want: Record<string, [string, string | null]> = {
      open: ["draft", null], rejected: ["rejected", null], delivered: ["delivered", null],
      prom_pre: ["promoted", null], prom_mat: ["promoted", null], prom_run: ["in_factory", null], prom_acc: ["in_factory", null],
      prom_fail: ["blocked", "backfill:child_failed"], prom_arch: ["blocked", "backfill:child_archived"], prom_miss: ["blocked", "backfill:child_missing"],
    };
    for (const [k, [state, reason]] of Object.entries(want)) {
      const row = await cardRow(T[k]);
      expect({ k, state: row.card_state, reason: row.blocked_reason }).toEqual({ k, state, reason });
      expect(row.status).toBe(before[k].status);           // tickets.status NÃO mudou
      expect(row.updated_at).toEqual(before[k].updated_at); // nem updated_at
      expect(row.card_contract_version).toBe(1);
      expect(await evCount(T[k])).toBe(1);
    }
    expect(bf[0].cardState.total).toBe(Object.keys(want).length);
    expect((await cardRow(T.b_open)).card_state).toBeNull(); // outro tenant não é afetado
    const e = (await pool.query("SELECT from_state, actor_kind, dedupe_key FROM ticket_card_events WHERE ticket_id = $1", [T.open])).rows[0];
    expect(e).toEqual({ from_state: null, actor_kind: "backfill", dedupe_key: "backfill:v1" });
  });

  it("2.2 — spec_origin: raiz initial; herdado = origem do pai; pedido e arquivos do ticket = card:legacy; rascunho e outro tenant intactos", async () => {
    const originsOf = async (pid: string) => Object.fromEntries((await pool.query(
      `SELECT CASE WHEN rel_dir = '' THEN filename ELSE rel_dir || '/' || filename END AS p, spec_origin FROM project_spec_files WHERE project_id = $1`, [pid])).rows.map((r) => [r.p, r.spec_origin]));
    const o1 = await originsOf(A.parentId), o2 = await originsOf(T.p2), o3 = await originsOf(T.p3);
    ev("spec-origin", { o1, o2, o3 });
    expect(o1).toEqual({ "spec.md": "initial", "docs/a.md": "initial" });
    expect(o2).toEqual({ "spec-evolution-v2.md": "card:legacy", "docs/a.md": "initial", "tickets/TK-0001/request.md": "card:legacy" });
    expect(o3).toEqual({ "spec-evolution-v3.md": "card:legacy", "docs/a.md": "initial", "tickets/TK-0001/request.md": "card:legacy" });
    expect(await originsOf(T.draft)).toEqual({ "tickets/TK-0009/request.md": null });
    expect(await originsOf(B.parentId)).toEqual({ "spec.md": null, "extra.md": null });
    // as colunas de execução não são tocadas
    expect((await pool.query("SELECT count(*)::int AS n FROM project_spec_files WHERE executed_in_project IS NOT NULL OR executed_at IS NOT NULL")).rows[0].n).toBe(0);
  });

  it("idempotência: segunda chamada (PUT repetido e função direta) não altera nada nem duplica eventos", async () => {
    const snap = async () => JSON.stringify({
      t: (await pool.query("SELECT id, card_state, blocked_reason FROM tickets WHERE tenant_id = $1 ORDER BY id", [A.tenantId])).rows,
      e: Number((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id IN (SELECT id FROM tickets WHERE tenant_id = $1)", [A.tenantId])).rows[0].n),
      f: (await pool.query("SELECT f.id, f.spec_origin FROM project_spec_files f JOIN projects p ON p.id = f.project_id WHERE p.tenant_id = $1 ORDER BY f.id", [A.tenantId])).rows,
    });
    const s1 = await snap();
    const r = await put("CARDS_BANCADA", 1, A.tenantId);
    const out = r.json().cardsBackfill[0];
    expect(out.cardState.total).toBe(0);
    expect(out.specOrigin.total).toBe(0);
    expect(await backfillCardState(pool, A.tenantId)).toMatchObject({ total: 0 });
    expect(await backfillSpecOrigin(pool, A.tenantId)).toMatchObject({ total: 0 });
    expect(await snap()).toBe(s1);
  });

  it("2.3 — leitura: com a flag on o GET de tasks traz cardId/originSpecFile; sem vínculo vem null; tenant B (off) não os tem", async () => {
    const tasks = (await app.inject({ method: "GET", url: `/api/projects/${A.parentId}/tasks` })).json() as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(tasks.map((t) => [t.taskId, t]));
    expect(byId["TSK-EVO-001"]).toMatchObject({ cardId: T.open, originSpecFile: "docs/a.md" });
    expect(byId["TSK-BE-001"]).toMatchObject({ cardId: null, originSpecFile: null });
    Object.assign(testUser, { id: B.userId, role: "tenant_admin", tenantId: B.tenantId });
    const tb = await app.inject({ method: "GET", url: `/api/projects/${B.parentId}/tasks` });
    expect(tb.statusCode).toBe(200);
    for (const t of tb.json()) expect(t).not.toHaveProperty("cardId");
    // apagar o card não apaga a task (ON DELETE SET NULL)
    admin();
    const t2 = (await seedTicket(pool, A)).id;
    await pool.query(`INSERT INTO project_tasks (project_id, task_id, module, owner_role, card_id) VALUES ($1,'TSK-EVO-002','backend','DEV',$2)`, [A.parentId, t2]);
    await pool.query("DELETE FROM tickets WHERE id = $1", [t2]);
    expect((await pool.query("SELECT card_id FROM project_tasks WHERE task_id = 'TSK-EVO-002' AND project_id = $1", [A.parentId])).rows[0].card_id).toBeNull();
  });

  it("on → off → on: ticket criado com a flag off fica NULL; ao religar só ele é preenchido; os já migrados não mudam", async () => {
    admin();
    const frozen = await cardRow(T.prom_run);
    expect((await put("CARDS_BANCADA", 0, A.tenantId)).json().cardsBackfill).toEqual([]);
    const late = (await seedTicket(pool, A)).id;
    expect((await cardRow(late)).card_state).toBeNull();
    const r = await put("CARDS_BANCADA", 1, A.tenantId);
    expect(r.json().cardsBackfill[0].cardState).toMatchObject({ total: 1, byState: { draft: 1 } });
    expect((await cardRow(late)).card_state).toBe("draft");
    expect(await cardRow(T.prom_run)).toEqual(frozen);
    // remover o override do tenant volta ao global (off) e não roda nada
    const d = await del("CARDS_BANCADA", A.tenantId);
    expect(d.statusCode).toBe(200);
    expect(d.json().cardsBackfill).toEqual([]);
    // chave comum: sem campo cardsBackfill
    const other = await put("AGENT_TIMEOUT_PM", 600, A.tenantId);
    expect(other.json()).not.toHaveProperty("cardsBackfill");
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'AGENT_TIMEOUT_PM' AND tenant_id = $1", [A.tenantId]);
  });

  it("padrão GLOBAL ligado: todos os tenants sem override desligado são migrados; um override 0 do tenant B o poupa", async () => {
    admin();
    const bTickets = [T.b_open];
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','0',$1)", [B.tenantId]);
    try {
      const r = await put("CARDS_BANCADA", 1); // global
      expect(r.statusCode).toBe(200);
      // S-11: o modo global NÃO roda dentro do PUT — responde na hora com o job, e o relatório vem por consulta
      const started = r.json().cardsBackfill as Array<{ tenantId: string; mode?: string; jobId?: string; status?: string }>;
      expect(started).toEqual([{ tenantId: "*", mode: "async", jobId: expect.any(String), status: "started" }]);
      const job = (await awaitCardsBackfillJob(started[0].jobId!))!;
      expect(job.status).toBe("done");
      const bf = job.outcomes!;
      expect(bf.map((x) => x.tenantId)).toContain(A.tenantId);
      expect(bf.map((x) => x.tenantId)).not.toContain(B.tenantId);
      const rep = await app.inject({ method: "GET", url: `/api/admin/runtime-config/cards-backfill/${job.id}` });
      expect(rep.statusCode).toBe(200);
      expect(rep.json()).toMatchObject({ id: job.id, status: "done", tenantId: null });
      expect((await app.inject({ method: "GET", url: "/api/admin/runtime-config/cards-backfill" })).json().jobs.length).toBeGreaterThan(0);
      expect((await app.inject({ method: "GET", url: "/api/admin/runtime-config/cards-backfill/cbf_inexistente" })).statusCode).toBe(404);
      tenantAdmin();
      expect((await app.inject({ method: "GET", url: `/api/admin/runtime-config/cards-backfill/${job.id}` })).statusCode).toBe(403);
      admin();
      for (const id of bTickets) expect((await cardRow(id)).card_state).toBeNull();
    } finally {
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id IS NULL");
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [B.tenantId]);
    }
  });

  // ── S-11: lotes, statement_timeout e corrida do snapshot ─────────────────────────────────────────────────
  it("S-11 — lotes: 5 tickets com batchSize 2 são todos preenchidos (3 comandos), idempotente depois", async () => {
    expect(BACKFILL_DEFAULTS.batchSize).toBe(500);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedTicket(pool, A)).id);
    const rep = await backfillCardState(pool, A.tenantId, { batchSize: 2 });
    expect(rep).toMatchObject({ total: 5, byState: { draft: 5 } });
    for (const id of ids) expect((await cardRow(id)).card_state).toBe("draft");
    expect((await backfillCardState(pool, A.tenantId, { batchSize: 2 })).total).toBe(0);
  });

  it("S-11 — cada transação do backfill aplica SET LOCAL statement_timeout (padrão 120000 ms)", async () => {
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','1',$1)", [A.tenantId]);
    try {
      const log: string[] = [];
      const spy = {
        query: pool.query.bind(pool),
        connect: async () => { const c = await pool.connect(); return { query: (sql: string, p?: unknown[]) => { log.push(sql); return c.query(sql, p); }, release: () => c.release() }; },
      };
      const out = await runCardsFlagBackfill(spy as never, A.tenantId);
      expect(out[0].error).toBeUndefined();
      expect(log.some((q) => /^SET LOCAL statement_timeout = 120000$/.test(q))).toBe(true);
      expect(log.indexOf("BEGIN")).toBeLessThan(log.findIndex((q) => q.startsWith("SET LOCAL statement_timeout")));
    } finally { await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [A.tenantId]); }
  });

  it("S-11 — corrida: PATCH concorrente open→rejected no meio do backfill NÃO deixa [rejected, draft]", async () => {
    const race = (await seedTicket(pool, A)).id;
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE tickets SET status = 'rejected' WHERE id = $1", [race]); // escritor legado, ainda não commitado
      const running = backfillCardState(pool, A.tenantId); // lê o snapshot com status 'open' e tenta travar a linha
      await new Promise((r) => setTimeout(r, 400));
      const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%card_state%'");
      expect(waiting.rows[0].n).toBeGreaterThan(0); // o backfill está de fato esperando o escritor
      await holder.query("COMMIT");
      await running;
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); }
    const row = await cardRow(race);
    ev("backfill-corrida", { status: row.status, card_state: row.card_state });
    expect({ status: row.status, card_state: row.card_state }).toEqual({ status: "rejected", card_state: "rejected" });
  });

  // ── S-12: filho de evolução antigo (sem evolution_inherited_spec) ────────────────────────────────────────
  it("S-12 — sem lista de herdados: tickets/TK-NNNN/request.md ⇒ card:legacy (não 'initial'); demais não primários seguem herdados", async () => {
    const p4 = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, extra)
       VALUES ($1,$2,'v4 antigo','accepted',$3,$4,4,$5::jsonb) RETURNING id`,
      [A.tenantId, A.userId, A.productId, T.p3, JSON.stringify({ evolution: true })],
    )).rows[0].id as string;
    const add = (relDir: string, filename: string, primary = false) =>
      pool.query(`INSERT INTO project_spec_files (project_id, filename, file_path, rel_dir, is_primary) VALUES ($1,$2,$3,$4,$5)`, [p4, filename, `/tmp/x/${p4}/${relDir}/${filename}`, relDir, primary]);
    await add("", "spec-evolution-v4.md", true); await add("docs", "a.md"); await add("tickets/TK-0042", "request.md");
    await backfillSpecOrigin(pool, A.tenantId);
    const o = Object.fromEntries((await pool.query(
      `SELECT CASE WHEN rel_dir = '' THEN filename ELSE rel_dir || '/' || filename END AS p, spec_origin FROM project_spec_files WHERE project_id = $1`, [p4])).rows.map((r) => [r.p, r.spec_origin]));
    expect(o).toEqual({ "spec-evolution-v4.md": "card:legacy", "docs/a.md": "initial", "tickets/TK-0042/request.md": "card:legacy" });
  });
});
