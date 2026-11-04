/**
 * AO — correções da revisão adversarial AN do Guard de custo (C3'/C4') e das fases 5/6. Postgres real.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441). Cada teste reproduz o achado (falha SEM a correção) e prova a correção.
 *
 *  A1 leitura de `cost_policies` que FALHA ≠ "sem política" (fail-closed no Advisor, no card e no disjuntor)
 *  A2 `CARD_BUDGET_CAP` leva o card a `blocked` sozinho (gancho da rota + reconciliador, filho em status de Bancada)
 *  A3 rotas internas do Guard: `tenant_admin` só opera projeto do PRÓPRIO tenant (404 sem vazar existência)
 *  A4 gate de retomada usa a estimativa da próxima chamada (sem laço de retomadas)
 *  M1 Advisor com política e `LLM_ROLES_MODE=off` na API ⇒ negado com evento · M2 escalada negada não conta como gasto do Advisor
 *  M3 tenant não é mais permissivo que a global · M4 disjuntor da política também no pós-registro
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
import { llmGuardInternalRoutes } from "../routes/llmGuard.js";
import { signToken } from "../auth.js";
import {
  advisorGate, advisorSpentUsd, cardBudgetCheck, checkProjectBudgetGate, getGuardSettings, preflight, recordCall, setGuardSetting,
} from "./llmGuard.js";
import { syncCardWithChild, syncCardsWithChildren } from "./cardPromote.js";
import { getEffectivePolicy, resetBreakerCache } from "./costPolicies.js";

describePg("AO — correções AN do Guard (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  let ver = 1;
  const prevRoles = process.env.LLM_ROLES_MODE;
  const admin = () => Object.assign(testUser, { id: "u-admin", email: "admin@t.test", role: "zentriz_admin", tenantId: null });
  const put = (payload: Record<string, unknown>) => { admin(); return app.inject({ method: "PUT", url: "/api/cost-policies", payload }); };
  const clearPolicies = () => pool.query("DELETE FROM cost_policies");

  const mk = async (budgetUsd: number | null = 100) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd });
    seeds.push(s);
    return s;
  };
  const mkChild = async (s: Seed, status = "running") => (await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id)
     VALUES ($1,$2,'filho',$3,$4,$5,$6,$5) RETURNING id`, [s.tenantId, s.userId, status, s.productId, s.parentId, ++ver + 300],
  )).rows[0].id as string;
  const mkCard = async (s: Seed, o: { state: string; child?: string | null }) => {
    const t = await seedTicket(pool, s, { status: "open" });
    await pool.query(
      `UPDATE tickets SET card_state = $2, child_project_id = $3,
              status = CASE WHEN $2 IN ('promoted','in_factory','blocked') THEN 'promoted' ELSE 'open' END WHERE id = $1`,
      [t.id, o.state, o.child ?? null],
    );
    return t;
  };
  const ledger = (s: Seed, projectId: string, usd: number, extra: { role?: string | null; eff?: string | null; ago?: string } = {}) => pool.query(
    `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model, input_tokens, output_tokens, cost_usd, prompt_hash, llm_role, effective_role, created_at)
     VALUES ($1,$2,$3,'fabrica','agents','t','x','m',1,1,$4,$5,$6,$7, now() - $8::interval)`,
    [projectId, s.parentId, s.tenantId, usd, `h-${Math.random()}`, extra.role ?? null, extra.eff ?? extra.role ?? null, extra.ago ?? "0 seconds"],
  );
  const pf = (db: unknown, projectId: string) => preflight(db as never, { projectId, model: "claude-sonnet-4", estInputTokens: 1000, maxOutputTokens: 1000, purpose: "t" });
  const cardRow = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason FROM tickets WHERE id = $1", [id])).rows[0];
  const events = async (kind: string, projectId: string) =>
    (await pool.query("SELECT detail FROM llm_guard_events WHERE kind = $1 AND project_id = $2 ORDER BY id", [kind, projectId])).rows;
  /** Quebra SÓ a tabela `cost_policies` (o resto do banco funciona): é o que separa "sem política" de "erro de leitura". */
  const brokenPolicies = () => ({
    query: (sql: string, params?: unknown[]) => (/cost_policies/.test(sql) ? Promise.reject(new Error("cost_policies indisponível")) : pool.query(sql, params)),
  });
  const killSwitch = async () => (await getGuardSettings(pool)).kill_switch;
  const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> => {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 50)); v = await fn(); }
    return v;
  };

  beforeAll(async () => {
    process.env.LLM_ROLES_MODE = "on";
    scratch = await createScratchDb("evo_ao");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([costPolicyRoutes, llmGuardInternalRoutes]);
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterEach(async () => {
    await clearPolicies();
    await pool.query("DELETE FROM llm_call_ledger");
    await setGuardSetting(pool, "kill_switch", "off", "test");
    resetBreakerCache();
    process.env.LLM_ROLES_MODE = "on";
    delete process.env.GENESIS_API_TOKEN;
  });
  afterAll(async () => {
    if (prevRoles === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = prevRoles;
    await app?.close();
    for (const s of seeds) s.cleanup();
    await scratch?.drop();
  });

  // ═══ A1 ═══════════════════════════════════════════════════════════════════════════════════════
  it("A1: 'sem linha' continua legado, mas ERRO ao ler cost_policies NEGA o Advisor (com evento), não libera", async () => {
    const s = await mk(50);
    expect(await getEffectivePolicy(pool as never, "advisor_pct", s.tenantId)).toBeNull(); // sem linha ⇒ null
    expect(await advisorGate(pool, { projectId: s.parentId })).toEqual({ allow: true, mode: "legacy" });
    await expect(getEffectivePolicy(brokenPolicies() as never, "advisor_pct", s.tenantId)).rejects.toThrow(/indisponível/); // erro ⇒ lança
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10 })).statusCode).toBe(200);
    const g = await advisorGate(brokenPolicies() as never, { projectId: s.parentId, projectedUsd: 0.01 });
    expect(g).toMatchObject({ allow: false, mode: "policy", code: "advisor_denied_policy_error" });
    const ev = await events("advisor_denied_policy_error", s.parentId);
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ reason: "policy_read_error", ownerId: s.parentId });
  });

  it("A1: ERRO ao ler cost_policies nega a chamada do CARD (GUARD_ERROR) no preflight e no gate; projeto que não é card segue", async () => {
    const s = await mk(100);
    const child = await mkChild(s);
    await mkCard(s, { state: "in_factory", child });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 10 });
    await ledger(s, child, 10.5); // acima do teto de US$ 10
    expect(await pf(pool, child)).toMatchObject({ allow: false, code: "CARD_BUDGET_CAP" }); // saudável: nega por teto
    await pool.query("UPDATE projects SET status = 'running', stopped_by = NULL WHERE id = $1", [child]);
    expect(await pf(brokenPolicies(), child)).toMatchObject({ allow: false, code: "GUARD_ERROR" }); // antes: allow:true (teto ignorado)
    expect(await checkProjectBudgetGate(brokenPolicies() as never, child)).toMatchObject({ ok: false, code: "GUARD_ERROR" });
    // a falha da política não derruba o que não é card nem a exposição informativa: o dono (não é card) só perde a exposição
    expect(await pf(brokenPolicies(), s.parentId)).toMatchObject({ allow: true });
  });

  it("A1: leitura do disjuntor que FALHA mantém o valor MAIS RESTRITIVO conhecido (nunca afrouxa)", async () => {
    const s = await mk(100);
    await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 5 }); // política mais restritiva que o setting (40/h)
    await ledger(s, s.parentId, 6); // US$ 6 na última hora
    expect(await pf(pool, s.parentId)).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP" }); // leitura OK: 6 ≥ 5
    await setGuardSetting(pool, "kill_switch", "off", "test"); // o disjuntor ligou a chave; religa p/ isolar o teste
    expect(await pf(brokenPolicies(), s.parentId)).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP" }); // antes: voltava a 40 e liberava
    // sem valor conhecido (processo novo) a falha cai no setting — que continua sendo um teto, nunca "sem teto"
    resetBreakerCache();
    await setGuardSetting(pool, "kill_switch", "off", "test");
    await ledger(s, s.parentId, 50);
    expect(await pf(brokenPolicies(), s.parentId)).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP" });
  });

  // ═══ A2 ═══════════════════════════════════════════════════════════════════════════════════════
  it("A2: preflight negado por CARD_BUDGET_CAP aciona a sincronização e o card vai a blocked com filho em status de BANCADA", async () => {
    const s = await mk(100);
    const child = await mkChild(s, "spec_submitted"); // Bancada: o Guard NÃO para este status
    const card = await mkCard(s, { state: "promoted", child });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 10 });
    await ledger(s, child, 10.5);
    const r = await app.inject({ method: "POST", url: "/api/internal/llm-guard/preflight",
      payload: { projectId: child, model: "claude-sonnet-4", estInputTokens: 1000, maxOutputTokens: 1000, purpose: "t", source: "agents" } });
    expect(r.json()).toMatchObject({ allow: false, code: "CARD_BUDGET_CAP" });
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [child])).rows[0].status).toBe("spec_submitted"); // não foi parado
    const row = await waitFor(() => cardRow(card.id), (c) => c.card_state === "blocked");
    expect(row).toMatchObject({ card_state: "blocked", status: "promoted", blocked_reason: "budget:CARD_BUDGET_CAP" });
  });

  it("A2: o RECONCILIADOR cobre o filho vivo na Bancada com card_cap_reached recente (sem depender do gancho)", async () => {
    const s = await mk(100);
    const child = await mkChild(s, "spec_submitted");
    const card = await mkCard(s, { state: "in_factory", child });
    const healthy = await mkCard(s, { state: "in_factory", child: await mkChild(s, "spec_submitted") });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 10 });
    await ledger(s, child, 10.5);
    expect(await pf(pool, child)).toMatchObject({ allow: false, code: "CARD_BUDGET_CAP" }); // chamada direta: sem gancho de rota
    expect((await cardRow(card.id)).card_state).toBe("in_factory");
    expect(await syncCardsWithChildren(pool as never)).toBeGreaterThanOrEqual(1);
    expect(await cardRow(card.id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:CARD_BUDGET_CAP" });
    expect((await cardRow(healthy.id)).card_state).toBe("in_factory"); // card saudável intocado
  });

  // ═══ A3 ═══════════════════════════════════════════════════════════════════════════════════════
  it("A3: tenant_admin NÃO lê o advisor-gate, NÃO para o filho e NÃO grava custo em projeto de OUTRO tenant (404 igual ao inexistente)", async () => {
    const A = await mk(50);
    const B = await mk(50);
    await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 10 });
    const bChild = await mkChild(B);
    await mkCard(B, { state: "in_factory", child: bChild });
    const tokA = signToken({ sub: A.userId, email: "a@a.test", role: "tenant_admin", tenantId: A.tenantId });
    const tokB = signToken({ sub: B.userId, email: "b@b.test", role: "tenant_admin", tenantId: B.tenantId });
    const call = (path: string, token: string | null, payload: Record<string, unknown>) => app.inject({
      method: "POST", url: `/api/internal/llm-guard/${path}`, payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    // advisor-gate: A pedindo o projeto de B ⇒ 404 (sem baseUsd/capUsd/policyAuthor) e nenhum evento em B
    const gate = await call("advisor-gate", tokA, { projectId: B.parentId, projectedUsd: 1 });
    expect(gate.statusCode).toBe(404);
    expect(gate.body).not.toMatch(/baseUsd|capUsd|policyAuthor|admin@t\.test/);
    const unknown = await call("advisor-gate", tokA, { projectId: "00000000-0000-4000-8000-000000000000", projectedUsd: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(gate.json()); // mesma resposta: não vaza se o projeto existe
    expect((await call("advisor-gate", tokA, { projectId: "nao-e-uuid" })).statusCode).toBe(404);
    // preflight inflado do filho de B por A ⇒ 404 e o filho de B continua vivo
    const pfx = await call("preflight", tokA, { projectId: bChild, model: "claude-opus-4", estInputTokens: 900_000, maxOutputTokens: 64_000, purpose: "t" });
    expect(pfx.statusCode).toBe(404);
    expect((await pool.query("SELECT status, stopped_by FROM projects WHERE id = $1", [bChild])).rows[0]).toMatchObject({ status: "running", stopped_by: null });
    expect((await pool.query("SELECT budget_paused_at FROM projects WHERE id = $1", [B.parentId])).rows[0].budget_paused_at).toBeNull();
    // record fictício
    const rec = await call("record", tokA, { projectId: B.parentId, model: "claude-opus-4", inputTokens: 1_000_000, outputTokens: 100_000, llmRole: "advisor" });
    expect(rec.statusCode).toBe(404);
    expect(await advisorSpentUsd(pool, B.parentId)).toBe(0);
    // o dono do projeto (B) e o token estático/plataforma continuam operando
    expect((await call("advisor-gate", tokB, { projectId: B.parentId, projectedUsd: 0.5 })).statusCode).toBe(200);
    expect((await call("advisor-gate", tokB, { projectId: B.parentId, projectedUsd: 0.5 })).json()).toMatchObject({ allow: true, mode: "policy" });
    process.env.GENESIS_API_TOKEN = "tok-plataforma";
    const svc = await app.inject({ method: "POST", url: "/api/internal/llm-guard/advisor-gate", payload: { projectId: B.parentId, projectedUsd: 0.5 }, headers: { "x-internal-token": "tok-plataforma" } });
    expect(svc.statusCode).toBe(200);
    expect(svc.json()).toMatchObject({ allow: true, mode: "policy" });
    // token de máquina do run (svc:"runner") segue amarrado ao PRÓPRIO projeto, também em outro tenant
    const runner = signToken({ sub: "r", email: "r@r", role: "tenant_admin", tenantId: A.tenantId, svc: "runner", projectId: B.parentId });
    expect((await call("advisor-gate", runner, { projectId: A.parentId, projectedUsd: 0.5 })).json()).toMatchObject({ allow: true, mode: "policy" }); // debita em B (forçado), não em A
  });

  // ═══ A4 ═══════════════════════════════════════════════════════════════════════════════════════
  it("A4: com teto − estimativa < gasto ≤ teto o preflight nega e o GATE também (card não volta a in_factory para ser negado de novo)", async () => {
    const s = await mk(100);
    const child = await mkChild(s);
    const card = await mkCard(s, { state: "in_factory", child });
    await put({ key: "card_budget_pct", scopeType: "global", pct: 10 }); // teto US$ 10
    for (let i = 0; i < 9; i++) await ledger(s, child, 1);
    await ledger(s, child, 0.995); // 9,995: a chamada de teste (~US$ 0,01) estoura; gasto ainda ≤ teto
    expect(await cardBudgetCheck(pool, child, 0)).toMatchObject({ applies: true, ok: true }); // estimativa 0 libera (era o gate antigo)
    expect(await pf(pool, child)).toMatchObject({ allow: false, code: "CARD_BUDGET_CAP" });
    expect(await checkProjectBudgetGate(pool, child)).toMatchObject({ ok: false, code: "CARD_BUDGET_CAP" });
    expect((await syncCardWithChild(pool, card.id))?.kind).toBe("applied");
    expect((await cardRow(card.id)).card_state).toBe("blocked");
    // laço: sincronizar de novo NÃO libera o card (antes: budget_released ⇒ in_factory ⇒ negado ⇒ blocked ⇒ …)
    expect(await syncCardWithChild(pool, card.id)).toBeNull();
    expect(await syncCardWithChild(pool, card.id)).toBeNull();
    expect(await cardRow(card.id)).toMatchObject({ card_state: "blocked", blocked_reason: "budget:CARD_BUDGET_CAP" });
    expect((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id = $1 AND reason = 'budget_released'", [card.id])).rows[0].n).toBe(0);
  });

  // ═══ M1 / M2 ══════════════════════════════════════════════════════════════════════════════════
  it("M1: com política e LLM_ROLES_MODE=off na API, o gate NEGA com evento (o gasto do Advisor não seria contado)", async () => {
    const s = await mk(50);
    await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
    process.env.LLM_ROLES_MODE = "off";
    const g = await advisorGate(pool, { projectId: s.parentId, projectedUsd: 0.1 });
    expect(g).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
    expect((await events("advisor_denied_no_base", s.parentId))[0].detail).toMatchObject({ reason: "roles_off" });
    // sem política o legado segue igual, em qualquer modo
    await clearPolicies();
    expect(await advisorGate(pool, { projectId: s.parentId })).toEqual({ allow: true, mode: "legacy" });
    process.env.LLM_ROLES_MODE = "on";
    await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
    expect(await advisorGate(pool, { projectId: s.parentId, projectedUsd: 0.1 })).toMatchObject({ allow: true, mode: "policy" });
  });

  it("M2: escalada NEGADA (llm_role=advisor, effective_role=orchestrator) não conta como gasto do Advisor", async () => {
    const s = await mk(50);
    await ledger(s, s.parentId, 3, { role: "advisor", eff: "advisor" });
    await ledger(s, s.parentId, 2, { role: "advisor", eff: "orchestrator" });
    await pool.query(
      `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model, input_tokens, output_tokens, cost_usd, prompt_hash, llm_role)
       VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,1,'h-legacy','advisor')`, [s.parentId, s.tenantId]); // linha antiga sem effective_role
    expect(await advisorSpentUsd(pool, s.parentId)).toBeCloseTo(4, 6); // 3 + 1 legado; os 2 do Orchestrator ficam de fora
    // pelo caminho real: o recordCall grava effective_role=orchestrator quando o plano devolve
    const before = await advisorSpentUsd(pool, s.parentId);
    await recordCall(pool, { projectId: s.parentId, purpose: "t", source: "agents", model: "us.anthropic.claude-opus-5-5",
      inputTokens: 100_000, outputTokens: 40_000, llmRole: "advisor", effectiveRole: "orchestrator", promptHash: "h-m2" });
    expect(await advisorSpentUsd(pool, s.parentId)).toBe(before);
  });

  // ═══ M3 ═══════════════════════════════════════════════════════════════════════════════════════
  it("M3: política de tenant NÃO é mais permissiva que a global (PUT recusado) e a leitura limita ao mais restritivo", async () => {
    const s = await mk(100);
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10 })).statusCode).toBe(200);
    const bad = await put({ key: "advisor_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 100 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "TENANT_POLICY_EXCEEDS_GLOBAL" });
    expect(bad.json().message).toContain("mais restritivo");
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 5 })).statusCode).toBe(200);
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 10 })).statusCode).toBe(200); // igual à global: ok
    // teto absoluto: o do tenant não pode ser maior que o da global; sem o dele, herda o da global na leitura
    await put({ key: "card_budget_pct", scopeType: "global", pct: 50, absCapUsd: 20 });
    expect((await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 30, absCapUsd: 25 })).statusCode).toBe(400);
    expect((await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 30, absCapUsd: 15 })).statusCode).toBe(200);
    expect((await put({ key: "card_budget_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 30 })).statusCode).toBe(200);
    expect(await getEffectivePolicy(pool as never, "card_budget_pct", s.tenantId)).toMatchObject({ pct: 30, absCapUsd: 20, clampedByGlobal: true });
    // sem global para a chave, o tenant grava livremente; e baixar a global DEPOIS não deixa o tenant escapar na leitura
    await clearPolicies();
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: s.tenantId, pct: 80 })).statusCode).toBe(200);
    await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
    expect(await getEffectivePolicy(pool as never, "advisor_pct", s.tenantId)).toMatchObject({ pct: 10, scopeType: "tenant", clampedByGlobal: true });
    expect(await advisorGate(pool, { projectId: s.parentId, projectedUsd: 11 })).toMatchObject({ allow: false, code: "advisor_cap_reached", capUsd: 10 });
  });

  // ═══ M4 ═══════════════════════════════════════════════════════════════════════════════════════
  it("M4: o disjuntor da POLÍTICA vale também no pós-registro (sobe: não liga a chave; desce: liga na hora)", async () => {
    const s = await mk(1000);
    await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 80 }); // sobe o teto (setting = 40/h)
    await ledger(s, s.parentId, 45);
    await recordCall(pool, { projectId: s.parentId, purpose: "t", source: "agents", model: "claude-sonnet-4", inputTokens: 10, outputTokens: 10, promptHash: "h-m4a" });
    expect(await killSwitch()).toBe("off"); // antes: ligava nos 40 do setting e derrubava a plataforma
    await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 30 }); // desce o teto
    await recordCall(pool, { projectId: s.parentId, purpose: "t", source: "agents", model: "claude-sonnet-4", inputTokens: 10, outputTokens: 10, promptHash: "h-m4b" });
    expect(await killSwitch()).toBe("on"); // antes: 45 > 40 do setting ligava; com 35 do ledger só a política (30) acusaria
  });

  // ═══ M7 ═══════════════════════════════════════════════════════════════════════════════════════
  it("M7: índice em llm_call_ledger(project_id) existe; sem política o preflight de card não consulta tickets nem o ledger do card", async () => {
    const idx = (await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'llm_call_ledger' AND indexname = 'idx_llm_ledger_project'")).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(project_id\)/);
    const s = await mk(100);
    const child = await mkChild(s);
    await mkCard(s, { state: "in_factory", child });
    const seen: string[] = [];
    const spy = { query: (sql: string, params?: unknown[]) => { seen.push(sql); return pool.query(sql, params); } };
    expect(await pf(spy, child)).toMatchObject({ allow: true });
    expect(seen.some((q) => /FROM tickets/.test(q))).toBe(false);
    expect(seen.some((q) => /project_id = ANY/.test(q))).toBe(false);
  });
});
