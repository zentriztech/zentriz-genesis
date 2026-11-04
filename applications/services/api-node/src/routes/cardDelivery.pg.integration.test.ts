/**
 * Fase 4 / 4.3 — marcação automática de EXECUTADO em Postgres REAL (efêmero): card → aceite do filho → (PR mergeado) → `delivered`,
 * carimbo `executed_*` nos arquivos de spec do card, idempotência e corrida, falha/orçamento ⇒ `blocked`, rejeição humana ⇒ `rejected`,
 * ticket legado intocado. O repositório GitHub é SIMULADO (Octokit injetado por `__setOctokitFactoryForTests`; nenhuma rede).
 * Só roda com PG_TEST_URL (src/testing/evolvePg.ts).
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, raceN, uid, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());
// O aceite real publica no GitHub (rede). Aqui o fluxo de evolução é um stub que "publicou" (handled = true); o PR é semeado no `extra`.
vi.mock("../services/evolutionAccept.js", async (orig) => ({
  ...(await orig<typeof import("../services/evolutionAccept.js")>()),
  runEvolutionAcceptFlow: async () => true,
}));

import { projectRoutes } from "./projects.js";
import { __setOctokitFactoryForTests } from "../services/github.js";
import { deliverCardsOfChild, deliverAcceptedCards, verifyChildPrMerged } from "../services/cardDelivery.js";
import { syncCardWithChild } from "../services/cardPromote.js";
import { transitionCard, legacyStatusFor, type CardState } from "../services/cardState.js";

const ev = (tag: string, data: unknown) => console.log(`[F4B-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 4 / 4.3 — card delivered + executed_* (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  let prState: { merged: boolean } = { merged: false };
  const prCalls: Array<{ pull_number: number; owner: string; repo: string }> = [];

  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes]);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    await pool.end();
  });
  afterEach(() => { __setOctokitFactoryForTests(null); prState = { merged: false }; prCalls.length = 0; });

  /** Repositório simulado: `pulls.get` devolve o PR conforme `prState`. */
  const fakeGithub = () => __setOctokitFactoryForTests(async () => ({
    pulls: {
      get: async (o: { pull_number: number; owner: string; repo: string }) => {
        prCalls.push(o);
        return { data: { state: prState.merged ? "closed" : "open", merged: prState.merged, mergeable: true, mergeable_state: "clean", head: { sha: "H" }, base: { ref: "dev" }, merge_commit_sha: prState.merged ? "M" : null } };
      },
    },
  }) as never);

  const mkSeed = async () => { const s = await seedAcceptedProduct(pool, { budgetUsd: 50 }); seeds.push(s); return s; };

  interface Made { s: Seed; ticketId: string; code: string; child: string; draft: string }
  /** Card em `state` ligado a um filho `childStatus` (evolução); `repo` = filho com repositório + PR nº 7. */
  async function mkCard(o: { state?: CardState; childStatus?: string; repo?: boolean; installation?: boolean; legacy?: boolean } = {}): Promise<Made> {
    const s = await mkSeed();
    const t = await seedTicket(pool, s);
    const code = `TK-${String(t.number).padStart(4, "0")}`;
    const extra = { evolution: true, ticket_number: t.number, ...(o.repo ? { evolution_pr_number: 7 } : {}) };
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number, parent_project_id, budget_owner_project_id, extra)
       VALUES ($1,$2,$3,$4,$5,2,$6,$6,$7::jsonb) RETURNING id`,
      [s.tenantId, s.userId, `filho-${uid()}`, o.childStatus ?? "running", s.productId, s.parentId, JSON.stringify(extra)],
    )).rows[0].id as string;
    const draft = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'rascunho','card_draft',$3,0) RETURNING id`,
      [s.tenantId, s.userId, s.productId],
    )).rows[0].id as string;
    if (o.legacy) {
      await pool.query("UPDATE tickets SET status = 'promoted', child_project_id = $2 WHERE id = $1", [t.id, child]);
    } else {
      const st = o.state ?? "in_factory";
      await pool.query(
        `UPDATE tickets SET card_state = $2, status = $3, child_project_id = $4, draft_project_id = $5, blocked_reason = $6, card_contract_version = 1 WHERE id = $1`,
        [t.id, st, legacyStatusFor(st), child, draft, st === "blocked" ? "seed" : null],
      );
    }
    // Arquivos de spec: 2 do card (filho), 1 do card no rascunho, 1 `initial`, 1 de OUTRO card — só os 3 primeiros do card devem ser carimbados.
    const f = (proj: string, name: string, origin: string | null) => pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256, spec_origin) VALUES ($1,$2,$3,'text/markdown','',false,'x',$4)`,
      [proj, name, `/tmp/f4b/${uid()}-${name}`, origin]);
    await f(child, "rfc-1.md", `card:${code}`);
    await f(child, "req.md", `card:${code}`);
    await f(draft, "rascunho.md", `card:${code}`);
    await f(child, "base.md", "initial");
    await f(child, "outro.md", "card:TK-9999");
    if (o.repo) {
      await pool.query(
        `INSERT INTO project_github_repos (project_id, repo_name, repo_full_name, repo_url, clone_url) VALUES ($1,'app','acme/app','https://github.com/acme/app','https://github.com/acme/app.git')`, [child]);
      if (o.installation !== false) {
        await pool.query(`INSERT INTO tenant_github_installations (tenant_id, installation_id, github_login) VALUES ($1, 4242, 'acme') ON CONFLICT (tenant_id) DO NOTHING`, [s.tenantId]);
      }
    }
    return { s, ticketId: t.id, code, child, draft };
  }
  const card = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason, delivered_at, child_project_id FROM tickets WHERE id = $1", [id])).rows[0];
  const events = async (id: string) => (await pool.query("SELECT from_state, to_state, actor_kind, reason FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows;
  const stamps = async (m: Made) => (await pool.query(
    "SELECT filename, executed_in_project, executed_at FROM project_spec_files WHERE project_id = ANY($1::uuid[]) ORDER BY filename", [[m.child, m.draft]])).rows;
  const accept = async (m: Made) => {
    const r = await app.inject({ method: "POST", url: `/api/projects/${m.child}/accept`, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
  };
  const stampedNames = (rows: Array<{ filename: string; executed_in_project: string | null }>) => rows.filter((r) => r.executed_in_project).map((r) => r.filename);

  it("ponta a ponta: card in_factory → aceite do filho (sem repositório) → delivered, auditado, executed_* só nos arquivos do card", async () => {
    const m = await mkCard();
    await accept(m);
    await vi.waitFor(async () => expect((await card(m.ticketId)).card_state).toBe("delivered"), { timeout: 5000 });
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
    expect((await card(m.ticketId)).delivered_at).not.toBeNull();
    expect((await events(m.ticketId)).filter((e) => e.to_state === "delivered")).toEqual([{ from_state: "in_factory", to_state: "delivered", actor_kind: "system", reason: "accepted_no_repo" }]);
    const st = await stamps(m);
    expect(stampedNames(st).sort()).toEqual(["rascunho.md", "req.md", "rfc-1.md"]);
    expect(st.filter((r) => r.executed_in_project).every((r) => r.executed_in_project === m.child)).toBe(true);
    expect(st.filter((r) => r.executed_in_project).every((r) => r.executed_at !== null)).toBe(true);
    ev("e2e", { eventos: (await events(m.ticketId)).map((e) => `${e.from_state}>${e.to_state}:${e.actor_kind}`), carimbados: stampedNames(st) });
  });

  it("com repositório: aceite com PR ABERTO não entrega; depois do merge (simulado) entrega — e só então carimba", async () => {
    fakeGithub();
    const m = await mkCard({ repo: true });
    await accept(m);
    await new Promise((r) => setTimeout(r, 300));          // dá tempo ao gancho assíncrono do aceite
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    expect(stampedNames(await stamps(m))).toEqual([]);
    expect(prCalls.length).toBeGreaterThanOrEqual(1);       // verificou o PR de verdade (nº 7 do repo simulado)
    expect(prCalls[0]).toMatchObject({ owner: "acme", repo: "app", pull_number: 7 });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "pending_merge", detail: "pr_not_merged" })]);
    prState.merged = true;                                  // alguém mergeou direto no GitHub
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "delivered", stamped: 3 })]);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
    expect((await events(m.ticketId)).find((e) => e.to_state === "delivered")).toMatchObject({ reason: "accepted_github" });
  });

  it("evolution_merged_at (merge feito pelo Genesis) basta, sem consultar o GitHub; sem PR/instalação ⇒ não entrega", async () => {
    fakeGithub();
    const a = await mkCard({ repo: true, childStatus: "accepted" });
    await pool.query("UPDATE projects SET extra = extra || '{\"evolution_merged_at\":\"2026-11-04T00:00:00Z\"}'::jsonb WHERE id = $1", [a.child]);
    expect(await deliverCardsOfChild(pool, a.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect(prCalls).toHaveLength(0);
    const b = await mkCard({ repo: true, childStatus: "accepted", installation: false });
    expect(await verifyChildPrMerged(pool, b.child)).toMatchObject({ merged: false, detail: "no_installation" });
    await pool.query("UPDATE projects SET extra = extra - 'evolution_pr_number' WHERE id = $1", [b.child]);
    expect(await verifyChildPrMerged(pool, b.child)).toMatchObject({ merged: false, detail: "no_pr" });
    expect((await card(b.ticketId)).card_state).toBe("in_factory");
  });

  it("idempotência: repetir o aceite/entrega N vezes e em CORRIDA não duplica evento, não regride estado e não move executed_at", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    const res = await raceN(10, () => deliverCardsOfChild(pool, m.child));
    const flat = res.flat();
    expect(flat.filter((r) => r.result === "delivered")).toHaveLength(1);
    expect(flat.every((r) => r.result === "delivered" || r.result === "already_delivered")).toBe(true);
    expect((await events(m.ticketId)).filter((e) => e.to_state === "delivered")).toHaveLength(1);
    const before = await stamps(m);
    for (let i = 0; i < 3; i++) await accept(m);            // aceite repetido (HTTP) — o projeto já está accepted
    await deliverCardsOfChild(pool, m.child);
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);
    expect(await stamps(m)).toEqual(before);                // mesmas datas
    expect((await events(m.ticketId)).filter((e) => e.to_state === "delivered")).toHaveLength(1);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "delivered", status: "delivered" });
    ev("corrida", { resultados: flat.map((r) => r.result) });
  });

  it("reparo: card já delivered sem carimbo (queda entre a transição e o carimbo) é carimbado na repetição, sem novo evento", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    await deliverCardsOfChild(pool, m.child);
    await pool.query("UPDATE project_spec_files SET executed_in_project = NULL, executed_at = NULL WHERE project_id = ANY($1::uuid[])", [[m.child, m.draft]]);
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "already_delivered", stamped: 3 })]);
    expect((await events(m.ticketId)).filter((e) => e.to_state === "delivered")).toHaveLength(1);
  });

  it("reconciliador: card in_factory com filho accepted e PR mergeado no GitHub é entregue por deliverAcceptedCards", async () => {
    fakeGithub();
    const m = await mkCard({ repo: true, childStatus: "accepted" });
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(0);   // PR aberto: nada
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
    prState.merged = true;
    expect(await deliverAcceptedCards(pool, { tenantId: m.s.tenantId })).toBe(1);
    expect((await card(m.ticketId)).card_state).toBe("delivered");
  });

  it("card promoted/blocked cujo filho já foi aceito e mergeado passa por in_factory (child_accepted) e entrega, tudo auditado", async () => {
    const p = await mkCard({ state: "promoted", childStatus: "accepted" });
    const b = await mkCard({ state: "blocked", childStatus: "accepted" });
    for (const m of [p, b]) {
      expect(await deliverCardsOfChild(pool, m.child)).toEqual([expect.objectContaining({ result: "delivered" })]);
      // as duas linhas nascem na MESMA transação (mesmo created_at): compara como conjunto
      expect((await events(m.ticketId)).map((e) => `${e.from_state}>${e.to_state}`).sort()).toEqual(["in_factory>delivered", `${m === p ? "promoted" : "blocked"}>in_factory`].sort());
    }
  });

  it("falha da Fábrica ⇒ card blocked com motivo (nunca failed); o filho failed não entrega; retomada blocked → in_factory", async () => {
    const m = await mkCard({ childStatus: "failed" });
    expect((await syncCardWithChild(pool, m.ticketId))?.kind).toBe("applied");
    expect(await card(m.ticketId)).toMatchObject({ card_state: "blocked", status: "promoted", blocked_reason: "child_failed" });
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([]);
    expect(stampedNames(await stamps(m))).toEqual([]);
    await pool.query("UPDATE projects SET status = 'running' WHERE id = $1", [m.child]);       // filho religado
    expect((await syncCardWithChild(pool, m.ticketId))?.kind).toBe("applied");
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
  });

  it("orçamento: negativa do Guard ⇒ blocked 'budget:*' (ator guard), não failed; sem saldo não entrega nem carimba", async () => {
    const m = await mkCard({ childStatus: "running" });
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'orçamento esgotado' WHERE id = $1 OR budget_owner_project_id = $1", [m.s.parentId]);
    await pool.query("UPDATE projects SET status = 'stopped', stopped_by = 'budget' WHERE id = $1", [m.child]);
    expect((await syncCardWithChild(pool, m.ticketId))?.kind).toBe("applied");
    expect(await card(m.ticketId)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:BUDGET_PAUSED" });
    expect((await events(m.ticketId)).at(-1)).toMatchObject({ to_state: "blocked", actor_kind: "guard", reason: "budget:BUDGET_PAUSED" });
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [m.child])).rows[0].status).toBe("stopped");
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([]);
    expect((await events(m.ticketId)).some((e) => e.to_state === "delivered")).toBe(false);
  });

  it("rejeição humana ⇒ rejected (card blocked); depois disso nem o aceite do filho nem a entrega o reabrem", async () => {
    const m = await mkCard({ state: "blocked", childStatus: "stopped" });
    const r = await transitionCard(pool, { ticketId: m.ticketId, to: "rejected", actorKind: "user", actorId: m.s.userId, reason: "manual" });
    expect(r.kind).toBe("applied");
    expect(await card(m.ticketId)).toMatchObject({ card_state: "rejected", status: "rejected" });
    // O filho foi arquivado pela rejeição; mesmo se aparecesse `accepted`, o card rejeitado não é entregue.
    await pool.query("UPDATE projects SET status = 'accepted' WHERE id = $1", [m.child]);
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([]);
    expect(await card(m.ticketId)).toMatchObject({ card_state: "rejected", status: "rejected" });
    expect(stampedNames(await stamps(m))).toEqual([]);
  });

  it("entrega a filho trocado: card religado a OUTRO filho sob o lock não é entregue pelo aceite do filho antigo", async () => {
    const m = await mkCard({ childStatus: "accepted" });
    const other = await mkCard({ childStatus: "running" });
    await pool.query("UPDATE tickets SET child_project_id = $2 WHERE id = $1", [m.ticketId, other.child]);
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([]);
    expect((await card(m.ticketId)).card_state).toBe("in_factory");
  });

  it("flag/ticket legado: sem card_state nada muda (status, eventos e colunas executed_*), pelo aceite HTTP e pela passada do reconciliador", async () => {
    const m = await mkCard({ legacy: true });
    await accept(m);
    await new Promise((r) => setTimeout(r, 300));
    expect(await deliverCardsOfChild(pool, m.child)).toEqual([]);
    await deliverAcceptedCards(pool, { tenantId: m.s.tenantId });
    expect(await card(m.ticketId)).toMatchObject({ card_state: null, status: "promoted", delivered_at: null });
    expect(await events(m.ticketId)).toEqual([]);
    expect(stampedNames(await stamps(m))).toEqual([]);
  });
});
