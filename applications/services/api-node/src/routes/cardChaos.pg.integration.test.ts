/**
 * Fase 4 / AG — correções B1, A1, M1, M4 e CAOS (tarefa 4.6, lado api-node) em Postgres REAL (efêmero).
 *
 * "Kill" é simulado como nos testes de crash do `evolveClaim`: a função é INTERROMPIDA no meio (promessa que nunca resolve, cliente que
 * lança antes do COMMIT, estado gravado exatamente como a rota o deixaria) e o passo seguinte roda sobre o que ficou no banco.
 * Invariantes verificados em todos os cenários: nenhum `delivered` sem PR mergeado de repositório que existe na linhagem; no máximo um
 * evento `delivered` por card; um único push/PR por aceite; estado final correto. O GitHub é simulado (Octokit injetado + push stub).
 * Só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, raceN, uid, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
// O aceite da evolução é o REAL; só o push ao GitHub (rede) é simulado e controlável por cenário.
const pushHolder = vi.hoisted(() => ({ impl: null as null | ((id: string, o: unknown) => Promise<unknown>), calls: 0 }));
vi.mock("../services/githubPush.js", async (orig) => ({
  ...(await orig<typeof import("../services/githubPush.js")>()),
  pushEvolutionToGitHub: (id: string, o: unknown) => {
    pushHolder.calls++;
    return pushHolder.impl ? pushHolder.impl(id, o) : Promise.resolve({ ok: false, mode: "skipped", error: "stub: sem publicação" });
  },
}));

import { projectRoutes } from "./projects.js";
import { __setOctokitFactoryForTests } from "../services/github.js";
import { deliverCardsOfChild, deliverAcceptedCards, verifyChildPrMerged, listExecutedTasksOfCard } from "../services/cardDelivery.js";
import { syncCardWithChild, syncCardsWithChildren } from "../services/cardPromote.js";
import { legacyStatusFor, type CardState } from "../services/cardState.js";
import { runEvolutionAcceptFlow } from "../services/evolutionAccept.js";
import { runReconcilerPass, findIncompletePublications } from "../services/evolveReconciler.js";
import { reconcileEvolutionMerges } from "../services/evolutionMergeWorker.js";

describePg("Fase 4 / AG — B1, A1, M1, M4 e caos 4.6 (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const filesTmp = mkdtempSync(join(tmpdir(), "genesis-chaos-files-"));
  let prState = { merged: false };
  let prCalls = 0;

  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes]);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    rmSync(filesTmp, { recursive: true, force: true });
    await pool.end();
  });
  afterEach(() => { pushHolder.impl = null; pushHolder.calls = 0; __setOctokitFactoryForTests(null); prState = { merged: false }; prCalls = 0; });

  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    pulls: {
      get: async () => {
        prCalls++;
        return { data: { state: prState.merged ? "closed" : "open", merged: prState.merged, mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: prState.merged ? "M" : null } };
      },
    },
  }) as never);

  interface Made { s: Seed; ticketId: string; child: string; draft: string }
  /**
   * Card ligado a um filho (evolução). `lineageRepo`: o PAI tem repositório e o tenant tem GitHub App (linhagem publicada) — o filho NÃO tem
   * linha própria (ela só nasce depois do push). `ownRepo`: o filho também tem linha própria (push já feito).
   */
  async function mkCard(o: { state?: CardState; childStatus?: string; lineageRepo?: boolean; ownRepo?: boolean; extra?: Record<string, unknown> } = {}): Promise<Made> {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    const t = await seedTicket(pool, s);
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, parent_project_id, budget_owner_project_id, extra)
       VALUES ($1,$2,$3,$4,$5,2,$6,$6,$7::jsonb) RETURNING id`,
      [s.tenantId, s.userId, `filho-${uid()}`, o.childStatus ?? "running", s.productId, s.parentId,
        JSON.stringify({ evolution: true, ticket_number: t.number, ticket_id: t.id, ...(o.extra ?? {}) })],
    )).rows[0].id as string;
    const draft = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'rascunho','card_draft',$3,0) RETURNING id`,
      [s.tenantId, s.userId, s.productId],
    )).rows[0].id as string;
    const st = o.state ?? "in_factory";
    await pool.query(
      `UPDATE tickets SET card_state = $2, status = $3, child_project_id = $4, draft_project_id = $5, blocked_reason = $6, card_contract_version = 1 WHERE id = $1`,
      [t.id, st, legacyStatusFor(st), child, draft, st === "blocked" ? "child_archived" : null],
    );
    if (o.lineageRepo || o.ownRepo) {
      await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
    }
    if (o.lineageRepo) await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [s.parentId]);
    if (o.ownRepo) await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, pushed_at) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git', now() - interval '1 hour')`, [child]);
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256, spec_origin)
       VALUES ($1,'rfc.md',$2,'text/markdown','',false,'x',$3)`, [child, `/tmp/chaos/${uid()}`, `card:TK-${String(t.number).padStart(4, "0")}`]);
    return { s, ticketId: t.id, child, draft };
  }
  const card = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason, delivered_at FROM tickets WHERE id = $1", [id])).rows[0];
  const deliveredEvents = async (id: string) => (await pool.query("SELECT reason FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'delivered'", [id])).rows;
  const stamped = async (m: Made) => (await pool.query("SELECT count(*)::int AS n FROM project_spec_files WHERE project_id = $1 AND executed_in_project IS NOT NULL", [m.child])).rows[0].n as number;
  const extraOf = async (id: string) => (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [id])).rows[0] as { status: string; extra: Record<string, unknown> };
  const setExtra = (id: string, patch: object) => pool.query("UPDATE projects SET extra = extra || $2::jsonb WHERE id = $1", [id, JSON.stringify(patch)]);
  const dialogues = async (id: string, like: string) => (await pool.query("SELECT count(*)::int AS n FROM project_dialogue WHERE project_id = $1 AND summary_human LIKE $2", [id, like])).rows[0].n as number;
  const accept = async (m: Made) => app.inject({ method: "POST", url: `/api/projects/${m.child}/accept`, payload: {} });
  const envOn = { ...process.env, EVOLVE_RECONCILER: "on", PROJECT_FILES_ROOT: filesTmp, UPLOAD_DIR: filesTmp, EVOLVE_RECONCILER_PUBLISH_GRACE_S: "600" } as NodeJS.ProcessEnv;
  const pushOk = (prNumber: number) => async (id: string) => {
    await pool.query(
      `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url, pushed_at) VALUES ($1,'app','acme/app','https://github.com/acme/app','x', now())
       ON CONFLICT (project_id) DO UPDATE SET pushed_at = now()`, [id]);
    return { ok: true, mode: "evolution", fullName: "acme/app", branch: "evolution/v2", prNumber, prUrl: `https://github.com/acme/app/pull/${prNumber}`, headSha: "H", fileCount: 3 };
  };

  // ── B1 ──────────────────────────────────────────────────────────────────────────────────────────
  it("B1 (repro do revisor): pai com repositório + filho aceito com push pendente e SEM linha própria ⇒ NÃO entrega (antes: delivered/accepted_no_repo)", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true, childStatus: "accepted", extra: { evolution_push_pending: true } });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "push_pending" })]);
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    expect(await deliveredEvents(m.ticketId)).toEqual([]);
    expect(await stamped(m)).toBe(0);
    expect(prCalls).toBe(0);                                   // precedência: nem consulta o GitHub
  });

  it("B1: sem PR registrado numa linhagem COM repositório ⇒ pending_merge (no_pr); só linhagem SEM repositório algum vira no_repo", async () => {
    fakeGithub();
    const withRepo = await mkCard({ lineageRepo: true, childStatus: "accepted" });
    expect(await verifyChildPrMerged(pool, withRepo.child)).toMatchObject({ merged: false, detail: "no_pr" });
    const none = await mkCard({ childStatus: "accepted" });
    expect(await verifyChildPrMerged(pool, none.child)).toMatchObject({ merged: true, source: "no_repo" });
    expect(await deliverCardsOfChild(pool, none.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect((await card(withRepo.ticketId)).card_state).toBe("in_factory");
  });

  it("B1: a máquina de estados também decide pela linhagem (childPrecondition): sem prova de merge, in_factory → delivered é recusado", async () => {
    const { transitionCard } = await import("../services/cardState.js");
    const m = await mkCard({ lineageRepo: true, childStatus: "accepted" });
    const r = await transitionCard(pool, { ticketId: m.ticketId, to: "delivered", actorKind: "system", reason: "x", mergeCheck: async () => false });
    expect(r).toMatchObject({ kind: "precondition_failed", code: "merge_unverified" });
    const nope = await transitionCard(pool, { ticketId: m.ticketId, to: "delivered", actorKind: "system", reason: "x" });
    expect(nope).toMatchObject({ kind: "precondition_failed", code: "merge_unverified" });
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
  });

  it("B1 ponta a ponta REAL (sem mock do aceite): push falha ⇒ push_pending, card não entrega; republicar com sucesso + merge ⇒ entrega uma vez", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true });
    pushHolder.impl = async () => ({ ok: false, mode: "evolution", error: "rede" });
    expect((await accept(m)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await extraOf(m.child)).extra.evolution_push_pending).toBe(true), { timeout: 5000 });
    expect((await extraOf(m.child)).extra.evolution_publish_state).toBe("failed");
    await new Promise((r) => setTimeout(r, 200));
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    expect(await deliveredEvents(m.ticketId)).toEqual([]);
    prState.merged = true;                                      // mesmo que "alguém" mergeie um PR qualquer, push pendente prevalece
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    pushHolder.impl = pushOk(7);
    await runEvolutionAcceptFlow(pool, m.child, { republish: true });
    expect((await extraOf(m.child)).extra).toMatchObject({ evolution_push_pending: false, evolution_publish_state: "done", evolution_pr_number: 7 });
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(1);
    expect(await deliveredEvents(m.ticketId)).toEqual([{ reason: "accepted_github" }]);
  });

  // ── C1: API morre entre o aceite e o push ───────────────────────────────────────────────────────
  it("C1: API morre entre o UPDATE accepted e o push ⇒ marcador pending gravado NO aceite; não entrega; reconciliador repara; republicar fecha", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true });
    pushHolder.impl = () => new Promise(() => { /* o processo morreu aqui: o push nunca termina */ });
    expect((await accept(m)).statusCode).toBe(200);
    await vi.waitFor(() => expect(pushHolder.calls).toBe(1), { timeout: 5000 });
    let st = await extraOf(m.child);
    expect(st.status).toBe("accepted");
    expect(st.extra.evolution_publish_state).toBe("pending");     // gravado na MESMA escrita do aceite
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    expect(await deliveredEvents(m.ticketId)).toEqual([]);
    // dentro da carência o reconciliador NÃO mexe (push legítimo pode levar minutos)
    await runReconcilerPass(pool, envOn);
    expect((await extraOf(m.child)).extra.evolution_push_pending).not.toBe(true);
    // passada a carência: detecta, marca republicável e registra
    await setExtra(m.child, { evolution_publish_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await findIncompletePublications(pool, { publishGraceS: 600 })).map((x) => x.id)).toContain(m.child);
    for (let i = 0; i < 3; i++) await runReconcilerPass(pool, envOn);   // retomada repetida: idempotente
    st = await extraOf(m.child);
    expect(st.extra).toMatchObject({ evolution_push_pending: true, evolution_publish_state: "failed" });
    expect(await dialogues(m.child, "%Publicação da evolução não foi concluída%")).toBe(1);
    const f = (await pool.query("SELECT count(*)::int AS n, max(seen_count) AS seen FROM evolve_reconciler_findings WHERE kind = 'evolution_publish_incomplete'")).rows[0];
    expect(f.n).toBeGreaterThanOrEqual(1);
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    // republicação (rota "Republicar") fecha o ciclo sem duplicar entrega
    pushHolder.impl = pushOk(7);
    await runEvolutionAcceptFlow(pool, m.child, { republish: true });
    prState.merged = true;
    await deliverAcceptedCards(pool, { tenantId: m.s.tenantId });
    await deliverAcceptedCards(pool, { tenantId: m.s.tenantId });
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
  });

  // ── C2: push em voo + reconciliador ─────────────────────────────────────────────────────────────
  it("C2: reconciliador roda com o push EM VOO (aceite gravado, branch parcial) ⇒ pending_merge; ao terminar, PR aberto ⇒ ainda não; mergeado ⇒ entrega", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    pushHolder.impl = async (id) => { await gate; return pushOk(7)(id); };
    expect((await accept(m)).statusCode).toBe(200);
    await vi.waitFor(() => expect(pushHolder.calls).toBe(1), { timeout: 5000 });
    prState.merged = true;                                        // até um merge "estranho" no GitHub não entrega durante o push
    for (let i = 0; i < 3; i++) {
      await runReconcilerPass(pool, envOn);
      expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    }
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    expect((await extraOf(m.child)).extra.evolution_push_pending).not.toBe(true);   // dentro da carência, nada marcado
    prState.merged = false;
    release();
    await vi.waitFor(async () => expect((await extraOf(m.child)).extra.evolution_publish_state).toBe("done"), { timeout: 5000 });
    expect((await extraOf(m.child)).extra.evolution_pr_number).toBe(7);
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);   // PR aberto
    prState.merged = true;
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(1);
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
    expect(pushHolder.calls).toBe(1);
  });

  // ── C3 / M1: queda entre o registro do repositório e o número do PR ─────────────────────────────
  it("C3/M1: queda entre INSERT project_github_repos e evolution_pr_number ⇒ detectado, marcado republicável e notificado no diálogo; sem PR duplicado", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_publish_state: "pending", evolution_publish_at: new Date(Date.now() - 3_600_000).toISOString() } });
    // estado deixado pela queda: linha do filho existe, número do PR NÃO, push_pending NÃO
    expect(await verifyChildPrMerged(pool, m.child)).toMatchObject({ merged: false, detail: "push_pending" });
    for (let i = 0; i < 4; i++) await runReconcilerPass(pool, envOn);
    expect((await extraOf(m.child)).extra).toMatchObject({ evolution_push_pending: true, evolution_publish_state: "failed" });
    expect(await dialogues(m.child, "%Publicação da evolução não foi concluída%")).toBe(1);   // 4 passadas ⇒ 1 aviso
    const finding = (await pool.query("SELECT severity, action_taken FROM evolve_reconciler_findings WHERE kind = 'evolution_publish_incomplete' AND detail->>'reason' = 'publish_pending_stale' ORDER BY detected_at DESC LIMIT 1")).rows[0];
    expect(finding).toMatchObject({ severity: "critical", action_taken: "cleaned_marked_push_pending" });
    // retomada: republicar reusa o PR (o stub devolve sempre o MESMO número, como openPullRequest faz com PR aberto) — N vezes
    pushHolder.impl = pushOk(9);
    for (let i = 0; i < 3; i++) await runEvolutionAcceptFlow(pool, m.child, { republish: true });
    expect((await extraOf(m.child)).extra).toMatchObject({ evolution_pr_number: 9, evolution_push_pending: false, evolution_publish_state: "done" });
    expect((await pool.query("SELECT count(*)::int AS n FROM project_github_repos WHERE project_id = $1", [m.child])).rows[0].n).toBe(1);
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "pr_not_merged" })]);
    prState.merged = true;
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
  });

  it("M1: filho aceito com repositório da linhagem registrado, SEM número de PR e sem marcador (aceite antigo) também é detectado; fallback_new_repo (sem PR por desenho) não", async () => {
    const stale = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted" });
    const fb = await mkCard({ ownRepo: true, childStatus: "accepted" });                     // linhagem sem repositório: o filho criou o seu (fallback)
    const ids = (await findIncompletePublications(pool, { publishGraceS: 600 })).map((x) => x.id);
    expect(ids).toContain(stale.child);
    expect(ids).not.toContain(fb.child);
    expect((await findIncompletePublications(pool, { publishGraceS: 600 })).find((x) => x.id === stale.child)?.reason).toBe("pr_not_registered");
  });

  // ── C4 / M7: dois aceites simultâneos ───────────────────────────────────────────────────────────
  it("C4/M7: N aceites simultâneos (Cyborg + humano) ⇒ UM fluxo de aceite (1 push/PR), 1 evento delivered, 1 carimbo", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true });
    pushHolder.impl = pushOk(7);
    const res = await raceN(6, () => accept(m));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    await vi.waitFor(async () => expect((await extraOf(m.child)).extra.evolution_publish_state).toBe("done"), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(pushHolder.calls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM project_tasks WHERE project_id = $1", [m.child])).rows[0].n).toBe(0);
    prState.merged = true;
    await raceN(5, () => deliverCardsOfChild(pool, m.child));
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
    expect(await stamped(m)).toBe(1);
    for (let i = 0; i < 3; i++) expect((await accept(m)).statusCode).toBe(200);              // retomada repetida
    expect(pushHolder.calls).toBe(1);
  });

  // ── C5: merge no GitHub com a API fora ──────────────────────────────────────────────────────────
  it("C5: merge feito direto no GitHub com a API fora; ao voltar, o reconciliador em `on` entrega e `shadow` não age (pré-requisito documentado)", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 7, evolution_publish_state: "done" } });
    prState.merged = true;
    await runReconcilerPass(pool, { ...envOn, EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv);
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    await runReconcilerPass(pool, envOn);
    expect((await card(m.ticketId)).card_state).toBe("delivered");
    await runReconcilerPass(pool, envOn);
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
  });

  // ── C6 / A1: supersessão antes do merge ─────────────────────────────────────────────────────────
  it("C6/A1 (repro do revisor): filho aceito com PR aberto e depois ARQUIVADO por supersessão ⇒ card NÃO fica blocked; o merge posterior entrega", async () => {
    fakeGithub();
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "accepted", extra: { evolution_pr_number: 7, evolution_publish_state: "done" } });
    await pool.query("UPDATE projects SET status = 'archived', extra = extra || '{\"superseded_by\":\"11111111-1111-4111-8111-111111111111\"}'::jsonb WHERE id = $1", [m.child]);
    expect(await syncCardWithChild(pool, m.ticketId)).toBeNull();
    expect(await syncCardsWithChildren(pool)).toBeGreaterThanOrEqual(0);
    expect((await card(m.ticketId)).card_state).toBe("in_factory");                          // antes: blocked child_archived
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);            // PR ainda aberto
    prState.merged = true;                                                                   // o merge da v2 chega depois
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(1);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "already_delivered" })]);
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
  });

  it("A1: card que JÁ ficou blocked(child_archived) com filho superado é recuperado pelo merge (blocked → in_factory → delivered); filho arquivado por REJEIÇÃO segue morto", async () => {
    fakeGithub();
    const m = await mkCard({ state: "blocked", lineageRepo: true, ownRepo: true, childStatus: "archived", extra: { superseded_by: "11111111-1111-4111-8111-111111111111", evolution_pr_number: 7, evolution_publish_state: "done" } });
    prState.merged = true;
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect((await card(m.ticketId)).card_state).toBe("delivered");
    const rej = await mkCard({ state: "blocked", lineageRepo: true, ownRepo: true, childStatus: "archived", extra: { card_rejected: { ticket_id: "x" }, evolution_pr_number: 7 } });
    expect(await deliverCardsOfChild(pool, rej.child)).toEqual([]);
    expect(await deliverAcceptedCards(pool, { tenantId: rej.s.tenantId })).toBe(0);
    expect((await card(rej.ticketId)).card_state).toBe("blocked");
  });

  it("A1: o merge-watch também observa filho superado (antes só `accepted`)", async () => {
    const m = await mkCard({ lineageRepo: true, ownRepo: true, childStatus: "archived", extra: { superseded_by: "11111111-1111-4111-8111-111111111111", evolution_pr_number: 7, evolution_publish_state: "done" } });
    const spy = vi.fn(async () => ({ rows: [{ id: m.child }] }));
    const r = await reconcileEvolutionMerges({ query: spy } as never).catch(() => ({ scanned: -1, merged: 0 }));
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain("superseded_by");
    expect(r.scanned).toBe(1);
  });

  // ── C7: queda dentro de deliverOne ──────────────────────────────────────────────────────────────
  it("C7: API cai dentro de deliverOne (depois da transição, antes do COMMIT) ⇒ rollback total; repetir entrega e carimba UMA vez", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    const crashing = {
      query: (...a: unknown[]) => (pool.query as (...x: unknown[]) => unknown)(...a),
      connect: async () => {
        const c = await pool.connect();
        const real = c.query.bind(c) as (...x: unknown[]) => Promise<unknown>;
        const origQuery = c.query, origRelease = c.release.bind(c);
        (c as unknown as { release: unknown }).release = (...a: unknown[]) => { (c as unknown as { query: unknown }).query = origQuery; (c as unknown as { release: unknown }).release = origRelease; return origRelease(...(a as [])); };
        (c as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) => {
          if (typeof sql === "string" && sql.includes("UPDATE project_spec_files")) return Promise.reject(new Error("KILL: processo morreu antes do COMMIT"));
          return real(sql, ...rest);
        };
        return c;
      },
    } as unknown as pg.Pool;
    expect(await deliverCardsOfChild(crashing, m.child)).toEqual([]);                        // erro engolido; nada vaza
    expect(await card(m.ticketId)).toMatchObject({ card_state: "in_factory" });
    expect(await deliveredEvents(m.ticketId)).toEqual([]);
    expect(await stamped(m)).toBe(0);
    for (let i = 0; i < 3; i++) await deliverCardsOfChild(pool, m.child);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
    expect(await deliveredEvents(m.ticketId)).toHaveLength(1);
    expect(await stamped(m)).toBe(1);
  });

  // ── M4 ──────────────────────────────────────────────────────────────────────────────────────────
  it("M4: tasks 'executadas' de um card entregue não contam CANCELLED/QA_FAIL/BLOCKED/pendentes nem herdadas; card não entregue ⇒ vazio", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    const ins = (id: string, status: string) => pool.query("INSERT INTO project_tasks (project_id, task_id, module, owner_role, status) VALUES ($1,$2,'backend','DEV',$3)", [m.child, id, status]);
    for (const [id, st] of [["TSK-EVO-001", "DONE"], ["TSK-EVO-002", "QA_PASS"], ["TSK-EVO-003", "CANCELLED"], ["TSK-EVO-004", "QA_FAIL"],
      ["TSK-EVO-005", "BLOCKED"], ["TSK-EVO-006", "ASSIGNED"], ["TSK-INH-V1-001", "DONE"]]) await ins(id, st);
    expect(await listExecutedTasksOfCard(pool, m.ticketId)).toEqual([]);                      // não entregue
    await deliverCardsOfChild(pool, m.child);
    expect((await listExecutedTasksOfCard(pool, m.ticketId)).map((t) => t.taskId)).toEqual(["TSK-EVO-001", "TSK-EVO-002"]);
  });
});
