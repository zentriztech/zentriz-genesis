/**
 * F5 (5.1 e 5.2) — orçamento do card em PERCENTUAL aplicado pelo Guard + métricas versionadas dos cards. Postgres real.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441).
 *
 * 5.1 (D-E10): sem política `card_budget_pct` o card COMPARTILHA o orçamento do dono (comportamento anterior, sem regressão);
 *   com política: gasto do card (ledger dos projetos do card) ≤ pct × orçamento total do dono; estouro ⇒ negativa do Guard
 *   (`CARD_BUDGET_CAP`) ⇒ card `blocked` por orçamento (`budget:CARD_BUDGET_CAP`), nunca `failed`; o dono NÃO é pausado.
 * 5.2: GET /api/products/:id/cards/metrics — contrato v1, valores em cenário semeado, isolamento por tenant.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { costPolicyRoutes } from "../routes/costPolicies.js";
import { cardRoutes } from "../routes/cards.js";
import { cardBudgetCheck, checkProjectBudgetGate, preflight, setGuardSetting } from "./llmGuard.js";
import { syncCardWithChild } from "./cardPromote.js";
import { validatePolicy } from "./costPolicies.js";

describePg("F5 — teto percentual do card no Guard + métricas (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  let ver = 1;
  const admin = () => Object.assign(testUser, { id: "u-admin", email: "admin@t.test", role: "zentriz_admin", tenantId: null });
  const as = (s: Seed) => Object.assign(testUser, { id: s.userId, email: `u@${s.tenantId}.test`, role: "tenant_admin", tenantId: s.tenantId });
  const put = (payload: Record<string, unknown>) => { admin(); return app.inject({ method: "PUT", url: "/api/cost-policies", payload }); };
  const clearPolicies = () => pool.query("DELETE FROM cost_policies");

  const mk = async (budgetUsd: number | null = 100) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd });
    seeds.push(s);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    return s;
  };
  const mkChild = async (s: Seed, status = "running") => (await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
     VALUES ($1,$2,'filho',$3,$4,$5,$6,$5) RETURNING id`, [s.tenantId, s.userId, status, s.productId, s.parentId, ++ver + 100],
  )).rows[0].id as string;
  const mkDraft = async (s: Seed) => (await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
     VALUES ($1,$2,'rascunho','card_draft',$3,NULL,0,$4) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId],
  )).rows[0].id as string;
  /** Card (ticket com `card_state`) com filho e/ou rascunho opcionais. */
  const mkCard = async (s: Seed, o: { state: string; reason?: string | null; child?: string | null; draft?: string | null }) => {
    const t = await seedTicket(pool, s, { status: "open" });
    await pool.query(
      `UPDATE tickets SET card_state = $2, blocked_reason = $3, child_project_id = $4, draft_project_id = $5,
              status = CASE WHEN $2 IN ('promoted','in_factory','blocked') THEN 'promoted' WHEN $2 = 'delivered' THEN 'delivered' WHEN $2 = 'rejected' THEN 'rejected' ELSE 'open' END
        WHERE id = $1`, [t.id, o.state, o.reason ?? null, o.child ?? null, o.draft ?? null],
    );
    return t;
  };
  const ledger = (s: Seed, projectId: string, usd: number, budgetOwner?: string) => pool.query(
    `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model, input_tokens, output_tokens, cost_usd, prompt_hash)
     VALUES ($1,$2,$3,'fabrica','agents','t','x','m',1,1,$4,$5)`, [projectId, budgetOwner ?? s.parentId, s.tenantId, usd, `h-${Math.random()}`],
  );
  const pf = (projectId: string) => preflight(pool, { projectId, model: "claude-sonnet-4", estInputTokens: 1000, maxOutputTokens: 1000, purpose: "t" });
  const cardRow = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0];

  beforeAll(async () => {
    scratch = await createScratchDb("evo_f5");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([costPolicyRoutes, cardRoutes]);
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterEach(async () => { await clearPolicies(); });
  afterAll(async () => {
    await app?.close();
    for (const s of seeds) s.cleanup();
    await scratch?.drop();
  });

  // ═══ 5.1 ══════════════════════════════════════════════════════════════════════════════════════
  it("validação: pct 1–100, sem piso/valor, calibrado=false por padrão, escopo tenant, histórico/auditoria como as demais", async () => {
    expect(validatePolicy({ key: "card_budget_pct", pct: 0 })).toMatchObject({ ok: false, code: "INVALID_PCT" });
    expect(validatePolicy({ key: "card_budget_pct", pct: 101 })).toMatchObject({ ok: false, code: "INVALID_PCT" });
    expect(validatePolicy({ key: "card_budget_pct" })).toMatchObject({ ok: false, code: "INVALID_PCT" });
    expect(validatePolicy({ key: "card_budget_pct", pct: 20, floorUsd: 1 })).toMatchObject({ ok: false, code: "INVALID_VALUE" });
    expect(validatePolicy({ key: "card_budget_pct", pct: 20, valueUsd: 1 })).toMatchObject({ ok: false, code: "INVALID_VALUE" });
    const s = await mk();
    expect((await put({ key: "card_budget_pct", scopeType: "global", pct: 20, calibrated: false })).statusCode).toBe(200);
    expect((await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 30 })).statusCode).toBe(200);
    const r = await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 35 });
    expect(r.json().policy).toMatchObject({ key: "card_budget_pct", pct: 35, calibrated: false, version: 2, base: "project_total_budget" });
    admin();
    const h = await app.inject({ method: "GET", url: `/api/cost-policies/history?scopeType=tenant&scopeId=${s.tenantId}&key=card_budget_pct` });
    expect(h.json().history.map((x: { action: string }) => x.action)).toEqual(["update", "create"]);
    expect((await put({ key: "card_budget_pct", scopeType: "global", pct: 150 })).statusCode).toBe(400);
    // tenant_admin escreve só o PRÓPRIO tenant e nunca calibra
    as(s);
    const own = await app.inject({ method: "PUT", url: "/api/cost-policies", payload: { key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 10, calibrated: true } });
    expect(own.statusCode).toBe(200);
    expect(own.json().policy.calibrated).toBe(false);
    const glob = await app.inject({ method: "PUT", url: "/api/cost-policies", payload: { key: "card_budget_pct", scopeType: "global", pct: 10 } });
    expect(glob.statusCode).toBe(403);
  });

  it("COM política: dentro do teto passa; estourou ⇒ Guard nega CARD_BUDGET_CAP, para só o filho (dono NÃO pausa) e o card vira blocked por orçamento (nunca failed)", async () => {
    const s = await mk(100);
    const child = await mkChild(s);
    const draft = await mkDraft(s);
    const card = await mkCard(s, { state: "in_factory", child, draft });
    // segundo card do MESMO dono: não é afetado pelo teto do primeiro
    const child2 = await mkChild(s);
    const card2 = await mkCard(s, { state: "in_factory", child: child2 });
    expect((await put({ key: "card_budget_pct", scopeType: "global", pct: 10 })).statusCode).toBe(200); // teto = US$ 10
    await ledger(s, draft, 4);   // refino (rascunho) conta para o card
    await ledger(s, child, 5);
    expect(await cardBudgetCheck(pool, child)).toMatchObject({ applies: true, ok: true, capUsd: 10, spentUsd: 9 });
    expect(await pf(child)).toMatchObject({ allow: true });
    expect(await checkProjectBudgetGate(pool, child)).toEqual({ ok: true });
    await ledger(s, child, 1.5); // 10,5 > 10
    const denied = await pf(child);
    expect(denied).toMatchObject({ allow: false, code: "CARD_BUDGET_CAP", budgetProjectId: s.parentId });
    expect(await checkProjectBudgetGate(pool, child)).toMatchObject({ ok: false, code: "CARD_BUDGET_CAP" });
    const ev = (await pool.query("SELECT detail FROM llm_guard_events WHERE kind = 'card_cap_reached' AND project_id = $1", [child])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ capUsd: 10, ticketId: card.id });
    // dono segue vivo e o outro card também
    expect((await pool.query("SELECT budget_paused_at FROM projects WHERE id = $1", [s.parentId])).rows[0].budget_paused_at).toBeNull();
    expect(await pf(child2)).toMatchObject({ allow: true });
    expect((await pool.query("SELECT status, stopped_by FROM projects WHERE id = $1", [child])).rows[0]).toMatchObject({ status: "stopped", stopped_by: "budget" });
    // a máquina de estados leva o card a blocked (ator guard), nunca failed
    const tr = await syncCardWithChild(pool, card.id);
    expect(tr?.kind).toBe("applied");
    expect(await cardRow(card.id)).toMatchObject({ card_state: "blocked", status: "promoted", blocked_reason: "budget:CARD_BUDGET_CAP" });
    expect((await cardRow(card2.id)).card_state).toBe("in_factory");
    expect((await pool.query("SELECT actor_kind FROM ticket_card_events WHERE ticket_id = $1 AND to_state = 'blocked'", [card.id])).rows[0].actor_kind).toBe("guard");
    // aumentar o percentual libera: o bloqueio de orçamento cai para in_factory
    expect((await put({ key: "card_budget_pct", scopeType: "global", pct: 50 })).statusCode).toBe(200);
    expect((await syncCardWithChild(pool, card.id))?.kind).toBe("applied");
    expect((await cardRow(card.id)).card_state).toBe("in_factory");
  });

  it("COM política e filho vivo NÃO parado (Bancada): syncCardWithChild bloqueia o card pelo Guard; escopo tenant vence o global", async () => {
    const s = await mk(100);
    const child = await mkChild(s, "running");
    const card = await mkCard(s, { state: "in_factory", child });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 90 });
    await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 5 }); // teto = US$ 5 (vence o global de 90)
    await ledger(s, child, 6);
    expect((await syncCardWithChild(pool, card.id))?.kind).toBe("applied");
    expect(await cardRow(card.id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:CARD_BUDGET_CAP" });
  });

  it("SEM política = comportamento atual (card compartilha o orçamento do dono); BUDGET_MISSING inalterado; projeto que não é card nunca é tocado", async () => {
    const s = await mk(100);
    const child = await mkChild(s);
    const card = await mkCard(s, { state: "in_factory", child });
    for (let i = 0; i < 8; i++) await ledger(s, child, 1.5); // US$ 12 no card (> 10 %): sem política nada muda (cuidado: teto global US$ 40/h)
    expect(await cardBudgetCheck(pool, child)).toEqual({ applies: false });
    expect(await pf(child)).toMatchObject({ allow: true });
    expect(await checkProjectBudgetGate(pool, child)).toEqual({ ok: true });
    expect(await syncCardWithChild(pool, card.id)).toBeNull();
    expect((await cardRow(card.id)).card_state).toBe("in_factory");
    expect((await pool.query("SELECT count(*)::int AS n FROM llm_guard_events WHERE kind = 'card_cap_reached' AND project_id = $1", [child])).rows[0].n).toBe(0);
    // com política, o projeto-dono (não é card) nunca recebe o teto do card
    await put({ key: "card_budget_pct", scopeType: "global", pct: 1 });
    expect(await cardBudgetCheck(pool, s.parentId)).toEqual({ applies: false });
    expect(await pf(s.parentId)).toMatchObject({ allow: true });
    // BUDGET_MISSING (dono sem orçamento) continua sendo do preflight, com ou sem política
    const m = await mk(null);
    const mChild = await mkChild(m);
    await mkCard(m, { state: "in_factory", child: mChild });
    expect(await pf(mChild)).toMatchObject({ allow: false, code: "BUDGET_MISSING" });
    // fail-closed: erro ao ler o vínculo do card ⇒ o Guard NEGA (GUARD_ERROR), nunca libera
    const broken = { query: (sql: string, params?: unknown[]) => (/FROM tickets/.test(sql) ? Promise.reject(new Error("boom")) : pool.query(sql, params)) } as never;
    expect(await preflight(broken, { projectId: child, model: "claude-sonnet-4", estInputTokens: 1000, maxOutputTokens: 1000 })).toMatchObject({ allow: false, code: "GUARD_ERROR" });
    expect(await checkProjectBudgetGate(broken, child)).toMatchObject({ ok: false, code: "GUARD_ERROR" });
  });

  // ═══ 5.2 ══════════════════════════════════════════════════════════════════════════════════════
  it("métricas: contrato v1, valores exatos em cenário semeado e isolamento por tenant", async () => {
    const A = await mk(100);
    const B = await mk(100);
    const base = Date.now() - 3_600_000;
    const evt = (ticketId: string, secs: number, to: string, reason?: string) => pool.query(
      "INSERT INTO ticket_card_events (ticket_id, to_state, actor_kind, reason, created_at) VALUES ($1,$2,'system',$3,$4)",
      [ticketId, to, reason ?? null, new Date(base + secs * 1000).toISOString()],
    );
    const cA1 = await mkChild(A); const dA1 = await mkDraft(A);
    const t1 = await mkCard(A, { state: "delivered", child: cA1, draft: dA1 });
    for (const [at, st, why] of [[0, "draft"], [100, "ready"], [160, "promoted"], [200, "in_factory"], [300, "blocked", "budget:CARD_BUDGET_CAP"], [400, "in_factory"], [500, "delivered"]] as const) await evt(t1.id, at, st, why);
    const cA2 = await mkChild(A);
    const t2 = await mkCard(A, { state: "blocked", reason: "child_failed", child: cA2 });
    for (const [at, st, why] of [[0, "draft"], [50, "ready"], [80, "promoted"], [100, "in_factory"], [200, "blocked", "child_failed"]] as const) await evt(t2.id, at, st, why);
    const t3 = await mkCard(A, { state: "rejected" });
    await evt(t3.id, 0, "draft"); await evt(t3.id, 30, "rejected");
    const t4 = await mkCard(A, { state: "promoted", child: await mkChild(A) });
    for (const [at, st] of [[0, "draft"], [10, "ready"], [20, "promoted"]] as const) await evt(t4.id, at, st);
    await ledger(A, cA1, 3.5); await ledger(A, dA1, 0.5); await ledger(A, cA2, 1);
    // tenant B: um card bloqueado caro — NÃO pode aparecer em A
    const tB = await mkCard(B, { state: "blocked", reason: "budget:BUDGET_PAUSED", child: await mkChild(B) });
    await evt(tB.id, 0, "draft"); await evt(tB.id, 10, "promoted"); await evt(tB.id, 20, "blocked", "budget:BUDGET_PAUSED");
    await ledger(B, (await pool.query("SELECT child_project_id FROM tickets WHERE id = $1", [tB.id])).rows[0].child_project_id, 99);

    as(A);
    const r = await app.inject({ method: "GET", url: `/api/products/${A.productId}/cards/metrics` });
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json();
    expect(m).toMatchObject({ version: 1, productId: A.productId, since: null, totalCards: 4 });
    expect(m.byState).toMatchObject({ delivered: 1, blocked: 1, rejected: 1, promoted: 1, draft: 0, in_factory: 0 });
    expect(m.timeInState.draft).toEqual({ cards: 4, totalSeconds: 190, avgSeconds: 47.5 });
    expect(m.timeInState.ready).toEqual({ cards: 3, totalSeconds: 100, avgSeconds: 33.3 });
    expect(m.timeInState.in_factory).toEqual({ cards: 2, totalSeconds: 300, avgSeconds: 150 });
    expect(m.timeInState.blocked.cards).toBe(2);
    expect(m.timeInState.blocked.totalSeconds).toBeGreaterThanOrEqual(100);
    expect(m.cost).toMatchObject({ totalUsd: 5, avgUsdPerCard: 1.25, cardsWithCost: 2 });
    expect(m.cost.items[0]).toMatchObject({ ticketId: t1.id, number: t1.number, costUsd: 4, calls: 2, state: "delivered" });
    expect(m.cost.items[1]).toMatchObject({ ticketId: t2.id, costUsd: 1, calls: 1 });
    expect(m.blocked).toMatchObject({ promotedCards: 3, everBlockedCards: 2, currentlyBlocked: 1, rate: 0.6667 });
    expect(m.blocked.reasons).toEqual(expect.arrayContaining([
      { reason: "budget:CARD_BUDGET_CAP", cards: 1, kind: "budget" }, { reason: "child_failed", cards: 1, kind: "other" },
    ]));
    expect(JSON.stringify(m)).not.toContain(tB.id);
    expect(m.cost.totalUsd).toBeLessThan(99);
    // filtros e validação
    expect((await app.inject({ method: "GET", url: `/api/products/${A.productId}/cards/metrics?limit=1` })).json().cost.items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/products/${A.productId}/cards/metrics?since=${new Date(Date.now() + 86_400_000).toISOString()}` })).json()).toMatchObject({ totalCards: 0, blocked: { rate: null } });
    expect((await app.inject({ method: "GET", url: `/api/products/${A.productId}/cards/metrics?since=ontem` })).statusCode).toBe(400);
    // isolamento: A pedindo o produto de B ⇒ 404 igual ao de produto inexistente; B enxerga só o que é seu
    expect((await app.inject({ method: "GET", url: `/api/products/${B.productId}/cards/metrics` })).statusCode).toBe(404);
    as(B);
    const mb = (await app.inject({ method: "GET", url: `/api/products/${B.productId}/cards/metrics` })).json();
    expect(mb).toMatchObject({ totalCards: 1, cost: { totalUsd: 99 }, blocked: { rate: 1, currentlyBlocked: 1 } });
    // flag desligada ⇒ 404 "Recurso indisponível" (igual às demais rotas de cards)
    const C = await seedAcceptedProduct(pool, { budgetUsd: 10 }); seeds.push(C);
    as(C);
    expect((await app.inject({ method: "GET", url: `/api/products/${C.productId}/cards/metrics` })).statusCode).toBe(404);
  });
});
