/**
 * N-8 (AU) — retomada humana, idempotente e auditada da pausa por orçamento (`POST /api/projects/:id/budget/resume`).
 * Postgres real; só roda com PG_TEST_URL. Antes: religar após `BUDGET_PAUSED` pedia o PUT do MESMO orçamento só para disparar a liberação,
 * depois `POST /cards/:id/resume` e `POST /projects/:id/run`.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { llmGuardUserRoutes } from "../routes/llmGuard.js";
import { setGuardSetting } from "./llmGuard.js";

describePg("N-8 — POST /api/projects/:id/budget/resume (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  let ver = 1;
  const as = (s: Seed, role = "tenant_admin", id = s.userId) => Object.assign(testUser, { id, email: `u-${id}@t.test`, role, tenantId: s.tenantId });

  const mk = async (budgetUsd = 30, spentUsd = 29.95) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd });
    seeds.push(s);
    await pool.query(
      `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model, input_tokens, output_tokens, cost_usd, prompt_hash)
       VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,$3,$4)`, [s.parentId, s.tenantId, spentUsd, `h-${Math.random()}`]);
    // pausa do Guard (equivalente ao `pauseForBudget`, sem o e-mail): dono pausado + filho parado por orçamento + card bloqueado
    await pool.query("UPDATE projects SET budget_paused_at = now(), budget_paused_reason = 'saldo insuficiente' WHERE id = $1", [s.parentId]);
    const child = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, stopped_by, product_id, parent_project_id, version_number, budget_owner_project_id)
       VALUES ($1,$2,'filho','stopped','budget',$3,$4,$5,$4) RETURNING id`, [s.tenantId, s.userId, s.productId, s.parentId, ++ver + 100],
    )).rows[0].id as string;
    const t = await seedTicket(pool, s, { status: "open" });
    await pool.query(
      `UPDATE tickets SET card_state = 'blocked', blocked_reason = 'budget:BUDGET_PAUSED', child_project_id = $2, status = 'promoted' WHERE id = $1`, [t.id, child]);
    return { s, child, ticket: t.id };
  };
  const post = (id: string) => app.inject({ method: "POST", url: `/api/projects/${id}/budget/resume` });
  const events = async (owner: string, kind: string) => (await pool.query("SELECT detail FROM llm_guard_events WHERE project_id = $1 AND kind = $2", [owner, kind])).rows;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_n8");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([llmGuardUserRoutes]);
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const s of seeds) s.cleanup();
    await scratch?.drop();
  });

  it("sem saldo: 402 BUDGET_STILL_INSUFFICIENT, a pausa CONTINUA, o orçamento não muda e nada é auditado como retomada", async () => {
    const { s } = await mk(30, 29.95);
    as(s);
    const r = await post(s.parentId);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: "BUDGET_STILL_INSUFFICIENT", ownerProjectId: s.parentId, budgetUsd: 30 });
    expect(r.json().message).toMatch(/PUT \/api\/projects\/.*\/budget/);
    const o = (await pool.query("SELECT budget_usd, budget_paused_at FROM projects WHERE id = $1", [s.parentId])).rows[0];
    expect(Number(o.budget_usd)).toBe(30);
    expect(o.budget_paused_at).not.toBeNull();
    expect(await events(s.parentId, "budget_resume_manual")).toHaveLength(0);
  });

  it("com saldo: libera dono e filhos, alinha o card, audita quem/quando/porquê, NÃO religa a execução e é idempotente", async () => {
    const { s, child, ticket } = await mk(30, 5);
    const me = as(s);
    const r = await post(s.parentId);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ ok: true, resumed: true, ownerProjectId: s.parentId, budgetUsd: 30 });
    // não religa: o filho segue stopped e vem listado com o passo seguinte
    expect(body.childrenToRestart).toEqual([{ projectId: child, status: "stopped", next: `POST /api/projects/${child}/run` }]);
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [child])).rows[0].status).toBe("stopped");
    const o = (await pool.query("SELECT budget_usd, budget_paused_at, budget_paused_reason FROM projects WHERE id = $1", [s.parentId])).rows[0];
    expect(o.budget_paused_at).toBeNull();
    expect(o.budget_paused_reason).toBeNull();
    expect(Number(o.budget_usd)).toBe(30); // orçamento intacto (sem "PUT do mesmo valor")
    // card alinhado sem passo extra
    expect((await pool.query("SELECT card_state FROM tickets WHERE id = $1", [ticket])).rows[0].card_state).toBe("in_factory");
    // trilha
    const audit = await events(s.parentId, "budget_resume_manual");
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ by: me.email, byUserId: me.id, pausedReason: "saldo insuficiente", budgetUsd: 30 });
    expect(audit[0].detail.at).toBeTruthy();
    // idempotente: repetir não faz nada nem grava evento novo
    const again = await post(s.parentId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, resumed: false, replayed: true });
    expect(await events(s.parentId, "budget_resume_manual")).toHaveLength(1);
    expect(await events(s.parentId, "budget_resumed")).toHaveLength(1);
  });

  it("quem pode: só admin do tenant, dono do projeto ou gestão Zentriz; usuário comum, outro tenant e agente (svc) → 403 e a pausa fica", async () => {
    const { s } = await mk(30, 5);
    const stillPaused = async () => (await pool.query("SELECT budget_paused_at FROM projects WHERE id = $1", [s.parentId])).rows[0].budget_paused_at !== null;
    as(s, "user", "00000000-0000-4000-8000-0000000000aa");
    expect((await post(s.parentId)).statusCode).toBe(403);
    const other = await mk(30, 5);
    as(other.s, "tenant_admin");
    expect((await post(s.parentId)).statusCode).toBe(403);
    as(s);
    Object.assign(testUser, { svc: "runner" });
    expect((await post(s.parentId)).statusCode).toBe(403);
    delete (testUser as { svc?: string }).svc;
    expect(await stillPaused()).toBe(true);
    // dono do projeto (role user, mas autor) pode
    as(s, "user", s.userId);
    expect((await post(s.parentId)).statusCode).toBe(200);
    expect(await stillPaused()).toBe(false);
  });
});
