/**
 * Fase 4 / AK — correções N1–N8 da re-verificação AI, em Postgres REAL e em BANCO DESCARTÁVEL (CREATE DATABASE + migrations): este arquivo
 * dispara passadas GLOBAIS (reconciliador, merge-watch, entrega) e por isso NÃO pode dividir o banco com outras suítes (N9).
 *
 * Diferença para `cardChaos.pg.integration.test.ts`: aqui o `pushEvolutionToGitHub` é o REAL por padrão (só é trocado nos cenários que
 * precisam controlar o resultado); foi isso que escondeu o N1 — o caos antigo simulava o push inteiro.
 * Só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, queryGate, testUser, uid, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
const pushHolder = vi.hoisted(() => ({ impl: null as null | ((id: string, o: unknown) => Promise<unknown>), calls: 0 }));
vi.mock("../services/githubPush.js", async (orig) => {
  const real = await orig<typeof import("../services/githubPush.js")>();
  return {
    ...real,
    pushEvolutionToGitHub: (id: string, o: { versionLabel: string; prBody: string; title?: string }) => {
      pushHolder.calls++;
      return pushHolder.impl ? pushHolder.impl(id, o) : real.pushEvolutionToGitHub(id, o);   // padrão: o REAL
    },
  };
});

import { projectRoutes } from "./projects.js";
import { __setOctokitFactoryForTests } from "../services/github.js";
import { deliverCardsOfChild, deliverAcceptedCards, verifyChildPrMerged } from "../services/cardDelivery.js";
import { legacyStatusFor, type CardState } from "../services/cardState.js";
import { runEvolutionAcceptFlow } from "../services/evolutionAccept.js";
import { runReconcilerPass, findIncompletePublications } from "../services/evolveReconciler.js";
import { reconcileEvolutionMerges } from "../services/evolutionMergeWorker.js";

describePg("Fase 4 / AK — N1–N8 (Postgres real, banco descartável)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const filesTmp = mkdtempSync(join(tmpdir(), "genesis-ak-files-"));
  /** PR por número: `merged` / `closed` (fechado sem merge) / `open`. */
  const prs = new Map<number, "merged" | "closed" | "open">();
  let prGets: number[] = [];
  let mergeCalls = 0;
  let createRepoFails = false;
  const envBackup = { ...process.env };

  beforeAll(async () => {
    scratch = await createScratchDb("evo_ak");
    pool = scratch.pool;
    pool.on("error", () => undefined);
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([projectRoutes]);
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    rmSync(filesTmp, { recursive: true, force: true });
    await scratch?.drop();
  });
  afterEach(() => {
    pushHolder.impl = null; pushHolder.calls = 0; __setOctokitFactoryForTests(null);
    prs.clear(); prGets = []; mergeCalls = 0; createRepoFails = false;
    for (const k of ["EVOLUTION_AUTO_MERGE", "EVOLUTION_AUTO_REDEPLOY"]) delete process.env[k];
  });

  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    repos: {
      createForAuthenticatedUser: async () => { if (createRepoFails) throw Object.assign(new Error("simulado: GitHub 422 name already exists"), { status: 422 }); throw new Error("não esperado"); },
      createInOrg: async () => { if (createRepoFails) throw Object.assign(new Error("simulado: GitHub 422 name already exists"), { status: 422 }); throw new Error("não esperado"); },
    },
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        prGets.push(pull_number);
        const st = prs.get(pull_number) ?? "open";
        return { data: { state: st === "open" ? "open" : "closed", merged: st === "merged", mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: st === "merged" ? `M${pull_number}` : null } };
      },
      merge: async () => { mergeCalls++; throw new Error("o observador NUNCA pode mergear"); },
    },
  }) as never);

  interface Made { s: Seed; ticketId: string; child: string }
  async function mkCard(o: {
    state?: CardState; childStatus?: string; lineageRepo?: boolean; ownRepo?: boolean; installation?: boolean;
    extra?: Record<string, unknown>; legacy?: boolean; flag?: boolean;
  } = {}): Promise<Made> {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    const t = await seedTicket(pool, s);
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, parent_project_id, budget_owner_project_id, extra)
       VALUES ($1,$2,$3,$4,$5,2,$6,$6,$7::jsonb) RETURNING id`,
      [s.tenantId, s.userId, `filho-${uid()}`, o.childStatus ?? "running", s.productId, s.parentId,
        JSON.stringify({ evolution: true, ...(o.legacy ? {} : { evolution_origin: "card" }), ticket_number: t.number, ticket_id: t.id, ...(o.extra ?? {}) })],
    )).rows[0].id as string;
    if (o.legacy) {
      await pool.query("UPDATE tickets SET status = 'promoted', child_project_id = $2 WHERE id = $1", [t.id, child]);
    } else {
      const st = o.state ?? "in_factory";
      await pool.query(`UPDATE tickets SET card_state = $2, status = $3, child_project_id = $4, card_contract_version = 1 WHERE id = $1`, [t.id, st, legacyStatusFor(st), child]);
    }
    // Flag de cards do tenant: ligada por padrão para card; para legado só quando pedido (tenant com a flag ligada e um ticket antigo).
    if (o.legacy ? o.flag === true : o.flag !== false) await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    if (o.lineageRepo || o.ownRepo || o.installation) {
      await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
    }
    if (o.lineageRepo) await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, sha_dev) VALUES ($1,'app','acme/app','https://github.com/acme/app','x','OLD')`, [s.parentId]);
    if (o.ownRepo) await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, pushed_at) VALUES ($1,'app','acme/app','https://github.com/acme/app','x', now() - interval '1 hour')`, [child]);
    return { s, ticketId: t.id, child };
  }
  const card = async (id: string) => (await pool.query("SELECT card_state, status FROM tickets WHERE id = $1", [id])).rows[0];
  const deliveredEvents = async (id: string) => (await pool.query("SELECT reason FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'delivered'", [id])).rows;
  const proj = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [id])).rows[0] as { status: string; extra: Record<string, unknown> };
  const setExtra = (id: string, patch: object) => pool.query("UPDATE projects SET extra = extra || $2::jsonb WHERE id = $1", [id, JSON.stringify(patch)]);
  const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
  const envOn = () => ({ ...process.env, EVOLVE_RECONCILER: "on", PROJECT_FILES_ROOT: filesTmp, UPLOAD_DIR: filesTmp, EVOLVE_RECONCILER_PUBLISH_GRACE_S: "600" }) as NodeJS.ProcessEnv;
  const openFindings = async (kind: string) => (await pool.query("SELECT detail, severity, action_taken FROM evolve_reconciler_findings WHERE kind = $1 AND resolved_at IS NULL", [kind])).rows;
  /** Silencia as evoluções já existentes para a próxima passada global do observador (LIMIT 20) só ver as do cenário. */
  const quiesce = () => pool.query("UPDATE projects SET extra = extra || '{\"evolution_merged_at\":\"2020-01-01T00:00:00Z\"}'::jsonb WHERE extra->>'evolution' = 'true' AND extra->>'evolution_merged_at' IS NULL");
  const pushOk = (prNumber: number) => async (id: string) => {
    await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, pushed_at) VALUES ($1,'app','acme/app','https://github.com/acme/app','x', now())
       ON CONFLICT (project_id) DO UPDATE SET pushed_at = now()`, [id]);
    return { ok: true, mode: "evolution", fullName: "acme/app", branch: "evolution/v2", prNumber, headSha: "H", fileCount: 3 };
  };

  // ── N1 (bloqueante): criação do repositório falha no fallback_new_repo ──────────────────────────
  it("N1 (repro do revisor, push REAL): linhagem sem repositório + App instalada + criação do repo falha (422) ⇒ failed + push_pending; card NÃO é entregue", async () => {
    fakeGithub(); createRepoFails = true;
    const m = await mkCard({ childStatus: "accepted", installation: true, extra: { evolution_publish_state: "pending", evolution_publish_at: new Date().toISOString() } });
    expect(await runEvolutionAcceptFlow(pool, m.child)).toBe(true);
    expect((await proj(m.child)).extra).toMatchObject({ evolution_push_pending: true, evolution_publish_state: "failed" });   // antes: publish_state 'done'
    expect((await pool.query("SELECT 1 FROM project_github_repos WHERE project_id = ANY($1)", [[m.child, m.s.parentId]])).rows).toHaveLength(0);
    expect(await verifyChildPrMerged(pool, m.child)).toMatchObject({ merged: false, detail: "push_pending" });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "pending_merge" })]);
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    expect(await runReconcilerPass(pool, envOn())).toMatchObject({ mode: "on" });
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    expect(await deliveredEvents(m.ticketId)).toEqual([]);
    // o pai NÃO foi superado por um push que não aconteceu
    expect((await proj(m.s.parentId)).status).toBe("accepted");
  });

  it("N1/N6a: republicar e o fallback_new_repo CRIA o repositório ⇒ publish_mode direct_dev (sem PR por desenho); a entrega vale por push direto em dev, uma vez", async () => {
    fakeGithub();
    const m = await mkCard({ childStatus: "accepted", installation: true, extra: { evolution_push_pending: true, evolution_publish_state: "failed" } });
    pushHolder.impl = async (id) => { await pushOk(1)(id); return { ok: true, mode: "fallback_new_repo" }; };
    await runEvolutionAcceptFlow(pool, m.child, { republish: true });
    expect((await proj(m.child)).extra).toMatchObject({ evolution_push_pending: false, evolution_publish_state: "done", evolution_publish_mode: "direct_dev" });
    expect(await verifyChildPrMerged(pool, m.child)).toMatchObject({ merged: true, source: "direct_push" });
    for (let i = 0; i < 3; i++) await deliverAcceptedCards(pool, { tenantId: m.s.tenantId });
    expect(await deliveredEvents(m.ticketId)).toEqual([{ reason: "accepted_direct_push" }]);
    expect(prGets).toEqual([]);                                  // nenhuma consulta de PR: não há PR
  });

  // ── N6b: push skipped com repositório na linhagem ───────────────────────────────────────────────
  it("N6b: push `skipped` (sem App/push desligado) com repositório na LINHAGEM ⇒ card pendente NÃO fica em silêncio: achado crítico no reconciliador; some quando o PR é registrado", async () => {
    fakeGithub();
    const m = await mkCard({ childStatus: "accepted", lineageRepo: true });
    pushHolder.impl = async () => ({ ok: false, mode: "skipped", error: "GENESIS_GITHUB_PUSH=off" });
    await runEvolutionAcceptFlow(pool, m.child);
    expect((await proj(m.child)).extra).toMatchObject({ evolution_publish_state: "done", evolution_publish_mode: "skipped" });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "no_pr" })]);
    await setExtra(m.child, { evolution_accepted_at: hourAgo() });
    await runReconcilerPass(pool, envOn());
    const f = (await openFindings("card_published_without_pr"));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", detail: { publish_mode: "skipped" } });
    // dentro da carência não alerta; não marca push_pending (republicar com push desligado só repetiria o skipped)
    expect((await proj(m.child)).extra.evolution_push_pending).toBe(false);
    // resolução: PR registrado e mergeado ⇒ achado fecha, card entregue
    await setExtra(m.child, { evolution_pr_number: 7 }); prs.set(7, "merged");
    await runReconcilerPass(pool, envOn());
    expect(await openFindings("card_published_without_pr")).toHaveLength(0);
    expect((await card(m.ticketId)).card_state).toBe("delivered");
  });

  // ── N2: detector M1 não toca o fluxo legado ─────────────────────────────────────────────────────
  it("N2 (repro do revisor): evolução LEGADA antiga (sem card, repositório próprio, sem evolution_pr_number) NÃO vira achado, push_pending nem e-mail; filho de card com a flag desligada também não", async () => {
    const legacy = await mkCard({ legacy: true, flag: true, lineageRepo: true, ownRepo: true, childStatus: "accepted" });   // tenant COM a flag ligada, ticket antigo
    const flagOff = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", flag: false });
    const live = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted" });          // controle: card + flag ligada
    const ids = (await findIncompletePublications(pool, { publishGraceS: 600 })).map((x) => x.id);
    expect(ids).not.toContain(legacy.child);
    expect(ids).not.toContain(flagOff.child);
    expect(ids).toContain(live.child);
    await runReconcilerPass(pool, envOn());
    expect((await proj(legacy.child)).extra.evolution_push_pending).toBeUndefined();
    expect((await proj(flagOff.child)).extra.evolution_push_pending).toBeUndefined();
    expect((await proj(live.child)).extra.evolution_push_pending).toBe(true);
    const n = (await pool.query("SELECT count(*)::int AS n FROM project_dialogue WHERE project_id = ANY($1) AND summary_human LIKE '%Publicação da evolução não foi concluída%'", [[legacy.child, flagOff.child]])).rows[0].n;
    expect(n).toBe(0);
    // legado com publish_state 'pending' esquecido (aceite pré-Fase 4 não grava isso, mas nunca é achado)
    const stale = await mkCard({ legacy: true, flag: true, childStatus: "accepted", extra: { evolution_publish_state: "pending", evolution_publish_at: hourAgo() } });
    expect((await findIncompletePublications(pool, { publishGraceS: 600 })).map((x) => x.id)).not.toContain(stale.child);
  });

  // ── N3 / N7: merge-watch ────────────────────────────────────────────────────────────────────────
  it("N3 (repro do revisor): evolução LEGADA superada com PR antigo NÃO é varrida (nem consulta o GitHub, nem auto-merge); legado aceito segue como antes", async () => {
    fakeGithub(); process.env.EVOLUTION_AUTO_MERGE = "on";
    await quiesce();
    const old = await mkCard({ legacy: true, lineageRepo: true, ownRepo: true, childStatus: "archived",
      extra: { superseded_by: "11111111-1111-4111-8111-111111111111", evolution_pr_number: 21, evolution_publish_state: "done", evolution_compat: "patch", evolution_compat_explicit: true } });
    prs.set(21, "merged");
    const r = await reconcileEvolutionMerges(pool as never);
    expect(r.scanned).toBe(0);
    expect(prGets).toEqual([]);
    expect(mergeCalls).toBe(0);
    expect((await proj(old.child)).extra.evolution_merged_at).toBeUndefined();
    expect((await pool.query("SELECT sha_dev FROM project_github_repos WHERE project_id = $1", [old.s.parentId])).rows[0].sha_dev).toBe("OLD");
  });

  it("N3: filho de card SUPERADO é só OBSERVADO — PR mergeado por fora registra o fato e entrega o card, sem auto-merge, sem regravar sha_dev da raiz, sem hooks", async () => {
    fakeGithub(); process.env.EVOLUTION_AUTO_MERGE = "on"; process.env.EVOLUTION_AUTO_REDEPLOY = "on";
    await quiesce();
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "archived",
      extra: { superseded_by: "11111111-1111-4111-8111-111111111111", evolution_pr_number: 22, evolution_publish_state: "done", evolution_compat: "patch", evolution_compat_explicit: true } });
    prs.set(22, "open");
    expect((await reconcileEvolutionMerges(pool as never)).merged).toBe(0);
    expect(mergeCalls).toBe(0);                                  // PR aberto de versão superada: NÃO é mergeado (antes: tryAutoMerge)
    prs.set(22, "merged");
    expect(await reconcileEvolutionMerges(pool as never)).toMatchObject({ scanned: 1, merged: 1 });
    expect((await proj(m.child)).extra).toMatchObject({ evolution_merge_actor: "external" });
    expect((await proj(m.child)).extra.evolution_merged_at).toBeTruthy();
    expect(mergeCalls).toBe(0);
    expect((await pool.query("SELECT sha_dev FROM project_github_repos WHERE project_id = $1", [m.s.parentId])).rows[0].sha_dev).toBe("OLD");   // versão antiga não reescreve a raiz
    expect((await card(m.ticketId)).card_state).toBe("delivered");
  });

  it("N7: com EVOLUTION_AUTO_MERGE desligado, o merge-watch ainda DETECTA o merge externo de filho de card (e nunca mergeia); legado aceito mantém o comportamento anterior", async () => {
    fakeGithub();
    await quiesce();
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 31, evolution_publish_state: "done" } });
    const legacy = await mkCard({ legacy: true, lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 32, evolution_publish_state: "done" } });
    prs.set(31, "merged"); prs.set(32, "merged");
    expect(await reconcileEvolutionMerges(pool as never)).toMatchObject({ scanned: 2, merged: 1 });
    expect((await proj(m.child)).extra.evolution_merged_at).toBeTruthy();
    expect((await card(m.ticketId)).card_state).toBe("delivered");
    expect((await proj(legacy.child)).extra.evolution_merged_at).toBeUndefined();
    expect(mergeCalls).toBe(0);
  });

  // ── N4 ──────────────────────────────────────────────────────────────────────────────────────────
  it("N4: o status muda para outro que não `accepted` entre o SELECT e o UPDATE do aceite ⇒ 409 (antes: 200 \"já aceito\" com o projeto NÃO aceito)", async () => {
    const m = await mkCard({ legacy: true, childStatus: "running" });
    Object.assign(testUser, { id: m.s.userId, tenantId: m.s.tenantId, role: "tenant_admin" });
    const gate = queryGate(pool, /UPDATE projects\s+SET status = \$1/, { mode: "hold-before", arrivals: 1 });
    try {
      const req = app.inject({ method: "POST", url: `/api/projects/${m.child}/accept`, payload: {} });
      await gate.reached;
      await pool.query("UPDATE projects SET status = 'completed' WHERE id = $1", [m.child]);   // o runner terminou no meio
      gate.release();
      const res = await req;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe("CONFLICT");
      expect((await proj(m.child)).status).toBe("completed");
      expect(pushHolder.calls).toBe(0);
    } finally { gate.uninstall(); }
  });

  // ── N5 ──────────────────────────────────────────────────────────────────────────────────────────
  it("N5: push mais LENTO que a carência — o detector marca push_pending com o push em voo; ao terminar com sucesso, push_pending é limpo e publish_state=done", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true, childStatus: "accepted", extra: { evolution_publish_state: "pending", evolution_publish_at: hourAgo() } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    pushHolder.impl = async (id) => { await gate; return pushOk(7)(id); };
    const flow = runEvolutionAcceptFlow(pool, m.child);          // `extra` lido AQUI: push_pending ainda não é true
    await vi.waitFor(() => expect(pushHolder.calls).toBe(1));
    await runReconcilerPass(pool, envOn());                      // passou a carência com o push em voo
    expect((await proj(m.child)).extra.evolution_push_pending).toBe(true);
    release();
    await flow;
    expect((await proj(m.child)).extra).toMatchObject({ evolution_push_pending: false, evolution_publish_state: "done", evolution_pr_number: 7 });   // antes: push_pending=true + done
    prs.set(7, "merged");
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(1);
  });

  // ── N8 ──────────────────────────────────────────────────────────────────────────────────────────
  it("N8: PR da v2 FECHADO sem merge porque a v3 entregou o conteúdo ⇒ v2 entregue por supersessão (só com o sucessor mergeado); sem sucessor mergeado continua pendente", async () => {
    fakeGithub();
    const v3 = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 42, evolution_publish_state: "done" } });
    const v2 = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "archived",
      extra: { superseded_by: v3.child, evolution_pr_number: 41, evolution_publish_state: "done" } });
    prs.set(41, "closed"); prs.set(42, "open");
    expect(await deliverCardsOfChild(pool, v2.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "pr_closed_successor_not_merged" })]);
    expect((await card(v2.ticketId)).card_state).toBe("in_factory");
    prs.set(41, "open");                                          // PR da v2 ainda aberto: ninguém decidiu nada
    prs.set(42, "merged");
    expect(await deliverCardsOfChild(pool, v2.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "pr_not_merged" })]);
    prs.set(41, "closed");                                        // fechado + sucessor mergeado
    expect(await deliverCardsOfChild(pool, v2.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect(await deliveredEvents(v2.ticketId)).toEqual([{ reason: "accepted_successor_merged" }]);
    expect(await deliverCardsOfChild(pool, v2.child)).toEqual([expect.objectContaining({ result: "already_delivered" })]);
    expect(await deliveredEvents(v2.ticketId)).toHaveLength(1);
  });

  it("N8: a cadeia v2→v3→v4 vale — v4 mergeado entrega a v2 com os PRs da v2 (fechado) e da v3 (fechado)", async () => {
    fakeGithub();
    const v4 = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 53, evolution_publish_state: "done" } });
    const v3 = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "archived", extra: { superseded_by: v4.child, evolution_pr_number: 52, evolution_publish_state: "done" } });
    const v2 = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "archived", extra: { superseded_by: v3.child, evolution_pr_number: 51, evolution_publish_state: "done" } });
    prs.set(51, "closed"); prs.set(52, "closed"); prs.set(53, "merged");
    expect(await deliverCardsOfChild(pool, v2.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
  });

  // ── M4: consumidor ──────────────────────────────────────────────────────────────────────────────
  it("M4: ao ENTREGAR, o relatório das tasks executadas (DONE/QA_PASS não herdadas) entra no diálogo do filho, uma vez; o contrato HTTP do card não muda", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    for (const [id, st] of [["TSK-EVO-001", "DONE"], ["TSK-EVO-002", "CANCELLED"], ["TSK-INH-V1-001", "DONE"]]) {
      await pool.query("INSERT INTO project_tasks (project_id, task_id, module, owner_role, status) VALUES ($1,$2,'backend','DEV',$3)", [m.child, id, st]);
    }
    const report = async () => (await pool.query("SELECT summary_human FROM project_dialogue WHERE project_id = $1 AND summary_human LIKE '%Card entregue%'", [m.child])).rows;
    expect(await report()).toHaveLength(0);
    for (let i = 0; i < 3; i++) await deliverCardsOfChild(pool, m.child);
    const rows = await report();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary_human).toContain("1 task(s) executada(s) — TSK-EVO-001");
    expect(rows[0].summary_human).not.toContain("TSK-EVO-002");
  });

  it("B-3: `card_id` EXPLÍCITO de filho DESCARTADO (card religado a outro filho) não liga a task ao card; o filho ativo liga", async () => {
    const m = await mkCard({ childStatus: "running" });
    Object.assign(testUser, { id: m.s.userId, tenantId: m.s.tenantId, role: "tenant_admin" });
    const old = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, parent_project_id, extra)
       VALUES ($1,$2,'filho descartado','failed',$3,2,$4,$5::jsonb) RETURNING id`,
      [m.s.tenantId, m.s.userId, m.s.productId, m.s.parentId, JSON.stringify({ evolution: true, evolution_origin: "card", ticket_id: m.ticketId })])).rows[0].id as string;
    const post = (pid: string) => app.inject({ method: "POST", url: `/api/projects/${pid}/tasks`, payload: { tasks: [{ task_id: "TSK-EVO-001", module: "backend", owner_role: "DEV", card_id: m.ticketId }] } });
    expect((await post(old)).statusCode).toBe(201);
    expect((await pool.query("SELECT card_id FROM project_tasks WHERE project_id = $1", [old])).rows[0].card_id).toBeNull();
    expect((await post(m.child)).statusCode).toBe(201);
    expect((await pool.query("SELECT card_id FROM project_tasks WHERE project_id = $1", [m.child])).rows[0].card_id).toBe(m.ticketId);
  });

  void envBackup;
});
