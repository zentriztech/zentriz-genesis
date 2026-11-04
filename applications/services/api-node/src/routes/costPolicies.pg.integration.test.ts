/**
 * C3' — `cost_policies` em Postgres REAL: CRUD + versionamento + auditoria, validação, autorização e,
 * principalmente, o aceite do desenho: ALTERAR A LINHA MUDA a leitura do Guard na chamada seguinte.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441).
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { costPolicyRoutes } from "./costPolicies.js";
import { budgetSummary, preflight, setGuardSetting } from "../services/llmGuard.js";

describePg("C3' — cost_policies (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let A: Seed;
  let B: Seed;
  const as = (s: Seed | null, role: string, svc?: string) =>
    Object.assign(testUser, { id: s?.userId ?? "u-admin", email: `${role}@t.test`, role, tenantId: s?.tenantId ?? null, svc });
  const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/cost-policies", payload });
  const advisorGlobal = (pct: unknown, extra: Record<string, unknown> = {}) => ({ key: "advisor_pct", scopeType: "global", pct, ...extra });
  const pf = async (s: Seed) => preflight(pool, { projectId: s.parentId, purpose: "t", source: "agents" });

  beforeAll(async () => {
    scratch = await createScratchDb("evo_costpol");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([costPolicyRoutes]);
    A = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    B = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    A?.cleanup(); B?.cleanup();
    await scratch?.drop();
  });

  it("sem política: o Guard se comporta como antes (sem advisorPolicy, sem mudança em budgetSummary)", async () => {
    const d = await pf(A);
    expect(d.allow).toBe(true);
    expect("advisorPolicy" in d).toBe(false);
    expect("advisorPolicy" in ((await budgetSummary(pool, A.parentId)) as object)).toBe(false);
  });

  it("CRUD + versionamento + auditoria", async () => {
    as(null, "zentriz_admin");
    const r1 = await put(advisorGlobal(10, { source: "conservador" }));
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().policy).toMatchObject({ key: "advisor_pct", pct: 10, base: "project_total_budget", version: 1, calibrated: false, calibratedAt: null, author: "zentriz_admin@t.test" });
    const r2 = await put(advisorGlobal(15, { floorUsd: 1, absCapUsd: 30 }));
    expect(r2.json().policy).toMatchObject({ pct: 15, version: 2, floorUsd: 1, absCapUsd: 30 });
    const r3 = await put(advisorGlobal(15, { calibrated: true, source: "quantis ledger" }));
    expect(r3.json().policy).toMatchObject({ version: 3, calibrated: true });
    expect(r3.json().policy.calibratedAt).toBeTruthy();
    const list = await app.inject({ method: "GET", url: "/api/cost-policies" });
    expect(list.json().policies).toHaveLength(1);
    const hist = (await app.inject({ method: "GET", url: "/api/cost-policies/history?scopeType=global&key=advisor_pct" })).json().history;
    expect(hist.map((h: { version: number; action: string }) => `${h.version}:${h.action}`)).toEqual(["3:update", "2:update", "1:create"]);
    expect(hist[2].before_state).toBeNull();
    expect(hist[1].before_state.pct).toBe(10);
    expect(hist[1].after_state.pct).toBe(15);
    const ev = await pool.query("SELECT count(*)::int AS n FROM llm_guard_events WHERE kind = 'cost_policy_changed'");
    expect(ev.rows[0].n).toBe(3);
    const del = await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" })).statusCode).toBe(404);
    // recriar mantém a versão monotônica (a exclusão consumiu a v4)
    const again = await put(advisorGlobal(20));
    expect(again.json().policy.version).toBe(5);
    const h2 = (await app.inject({ method: "GET", url: "/api/cost-policies/history?scopeType=global&key=advisor_pct" })).json().history;
    expect(h2.map((h: { action: string }) => h.action)).toEqual(["create", "delete", "update", "update", "create"]);
    await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" });
  });

  it("validação: percentual 1–100; piso/teto/disjuntor 0 recusado; chave e escopo inválidos", async () => {
    as(null, "zentriz_admin");
    for (const bad of [0, 101, -5, "abc", null]) {
      const r = await put(advisorGlobal(bad));
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe("INVALID_PCT");
    }
    expect((await put(advisorGlobal(1))).statusCode).toBe(200);
    expect((await put(advisorGlobal(100))).statusCode).toBe(200);
    for (const f of [{ floorUsd: 0 }, { absCapUsd: 0 }, { floorUsd: -1 }, { floorUsd: 5, absCapUsd: 2 }]) {
      const r = await put(advisorGlobal(10, f));
      expect(r.statusCode, JSON.stringify(f)).toBe(400);
      expect(r.json().code).toBe("INVALID_VALUE");
    }
    expect((await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 0 })).statusCode).toBe(400);
    expect((await put({ key: "breaker_hour_usd", scopeType: "global" })).statusCode).toBe(400);
    expect((await put({ key: "breaker_day_usd", scopeType: "tenant", scopeId: A.tenantId, valueUsd: 10 })).json().code).toBe("INVALID_SCOPE");
    expect((await put({ key: "nope", pct: 5 })).json().code).toBe("UNKNOWN_POLICY");
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: "x", pct: 5 })).json().code).toBe("INVALID_SCOPE");
    // o banco também recusa (defesa em profundidade)
    await expect(pool.query("INSERT INTO cost_policies (policy_key, pct, author) VALUES ('advisor_pct', 0, 'x')")).rejects.toThrow();
    await expect(pool.query("INSERT INTO cost_policies (policy_key, value_usd, author) VALUES ('breaker_hour_usd', 0, 'x')")).rejects.toThrow();
    await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" });
  });

  it("autorização: agente/token de serviço negado; tenant_admin só advisor_pct do próprio tenant e nunca calibra; user comum negado", async () => {
    as(A, "tenant_admin", "runner");
    expect((await put(advisorGlobal(10))).statusCode).toBe(403);
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: A.tenantId, pct: 10 })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" })).statusCode).toBe(403);
    as(null, "zentriz_admin", "agents");
    expect((await put(advisorGlobal(10))).statusCode).toBe(403);

    as(A, "user");
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: A.tenantId, pct: 10 })).statusCode).toBe(403);

    as(A, "tenant_admin");
    expect((await put(advisorGlobal(10))).statusCode).toBe(403);
    expect((await put({ key: "advisor_pct", scopeType: "tenant", scopeId: B.tenantId, pct: 10 })).statusCode).toBe(403);
    expect((await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 10 })).statusCode).toBe(403);
    const ok = await put({ key: "advisor_pct", scopeType: "tenant", scopeId: A.tenantId, pct: 12, calibrated: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().policy).toMatchObject({ pct: 12, calibrated: false, scopeType: "tenant" });
    // leitura isolada por tenant
    const mine = (await app.inject({ method: "GET", url: "/api/cost-policies" })).json().policies;
    expect(mine).toHaveLength(1);
    as(B, "tenant_admin");
    expect((await app.inject({ method: "GET", url: "/api/cost-policies" })).json().policies).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/api/cost-policies?scopeType=tenant&scopeId=${A.tenantId}` })).statusCode).toBe(403);
    as(A, "tenant_admin");
    expect((await app.inject({ method: "DELETE", url: `/api/cost-policies?scopeType=tenant&scopeId=${A.tenantId}&key=advisor_pct` })).statusCode).toBe(200);
  });

  it("ACEITE C3': alterar a linha muda a leitura do Guard na chamada SEGUINTE (preflight e budgetSummary)", async () => {
    as(null, "zentriz_admin");
    expect((await put(advisorGlobal(10))).statusCode).toBe(200);
    let d = await pf(A);
    expect(d.allow && d.advisorPolicy).toMatchObject({ pct: 10, baseUsd: 50, capUsd: 5, calibrated: false, scopeType: "global" });
    expect((await put(advisorGlobal(40))).statusCode).toBe(200);
    const v1 = d.allow ? d.advisorPolicy!.version : -1;
    d = await pf(A);
    expect(d.allow && d.advisorPolicy).toMatchObject({ pct: 40, capUsd: 20, version: v1 + 1 });
    expect(((await budgetSummary(pool, A.parentId)) as { advisorPolicy: { capUsd: number } }).advisorPolicy.capUsd).toBe(20);
    // teto absoluto limita
    await put(advisorGlobal(40, { absCapUsd: 8 }));
    d = await pf(A);
    expect(d.allow && d.advisorPolicy?.capUsd).toBe(8);
    // a linha do tenant vence a global, só para aquele tenant
    as(A, "tenant_admin");
    await put({ key: "advisor_pct", scopeType: "tenant", scopeId: A.tenantId, pct: 2 });
    const dA = await pf(A);
    const dB = await pf(B);
    expect(dA.allow && dA.advisorPolicy).toMatchObject({ pct: 2, capUsd: 1, scopeType: "tenant" });
    expect(dB.allow && dB.advisorPolicy).toMatchObject({ pct: 40, scopeType: "global" });
    // excluir a linha ⇒ volta ao comportamento de antes
    await app.inject({ method: "DELETE", url: `/api/cost-policies?scopeType=tenant&scopeId=${A.tenantId}&key=advisor_pct` });
    as(null, "zentriz_admin");
    await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" });
    d = await pf(A);
    expect(d.allow).toBe(true);
    expect("advisorPolicy" in d).toBe(false);
  });

  it("disjuntor: breaker_hour_usd vence o setting; BUDGET_MISSING e kill switch seguem valendo", async () => {
    as(null, "zentriz_admin");
    // gasto de US$ 3 na última hora no ledger
    await pool.query(
      `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, prompt_hash, duration_ms)
       VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,0,0,3,'h-c3',1)`, [A.parentId, A.tenantId],
    );
    expect((await pf(A)).allow).toBe(true); // setting padrão: teto alto
    expect((await put({ key: "breaker_hour_usd", scopeType: "global", valueUsd: 2 })).statusCode).toBe(200);
    const denied = await pf(A);
    expect(denied.allow).toBe(false);
    expect(!denied.allow && denied.code).toBe("GLOBAL_HOURLY_CAP");
    await app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=breaker_hour_usd" });
    await setGuardSetting(pool, "kill_switch", "off", "test");
    expect((await pf(A)).allow).toBe(true);
    await pool.query("UPDATE projects SET budget_usd = NULL WHERE id = $1", [B.parentId]);
    const miss = await pf(B);
    expect(!miss.allow && miss.code).toBe("BUDGET_MISSING");
  });
});
