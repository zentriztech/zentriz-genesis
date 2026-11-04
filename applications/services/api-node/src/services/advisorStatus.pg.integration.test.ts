/**
 * D-9 (AR) — Advisor em `shadow` consome orçamento e LLM_ROLES_MODE divergente (API×runner) quebra a premissa "Advisor desligado":
 * o Guard conta o gasto, o teto legado opt-in limita sem política, e a divergência/gasto aparecem no GET de settings.
 * Postgres real, banco descartável. Só com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { llmGuardUserRoutes } from "../routes/llmGuard.js";
import { advisorGate, advisorStatus, noteCallerRolesMode, setGuardSetting } from "./llmGuard.js";

describePg("D-9 — Advisor: gasto contado, teto legado opt-in e divergência de LLM_ROLES_MODE detectável (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let A: Seed;
  const prevMode = process.env.LLM_ROLES_MODE;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_d9");
    pool = scratch.pool;
    pool.on("error", () => undefined);
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([llmGuardUserRoutes]);
    A = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    await setGuardSetting(pool, "kill_switch", "off", "test");
  }, 120_000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = prevMode;
    delete process.env.ADVISOR_LEGACY_CAP_USD;
    await app?.close(); A?.cleanup(); await scratch?.drop();
  });
  afterEach(() => { delete process.env.ADVISOR_LEGACY_CAP_USD; });

  const advisorLedger = (usd: number) => pool.query(
    `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model,
       input_tokens, output_tokens, cost_usd, prompt_hash, llm_role)
     VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,$3,$4,'advisor')`, [A.parentId, A.tenantId, usd, `h-${Math.random()}`]);

  it("teto legado opt-in: sem política e com ADVISOR_LEGACY_CAP_USD o Guard LIMITA pelo ledger; sem a env nada muda", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    await advisorLedger(0.9);
    expect(await advisorGate(pool, { projectId: A.parentId, projectedUsd: 100 })).toEqual({ allow: true, mode: "legacy" });   // default inalterado
    process.env.ADVISOR_LEGACY_CAP_USD = "1";
    const denied = await advisorGate(pool, { projectId: A.parentId, projectedUsd: 0.5 });
    expect(denied).toMatchObject({ allow: false, mode: "policy", code: "advisor_cap_reached", capUsd: 1, spentUsd: 0.9 });
    expect(await advisorGate(pool, { projectId: A.parentId, projectedUsd: 0.05 })).toEqual({ allow: true, mode: "legacy" });
  });

  it("advisorStatus: shadow na API avisa que o Advisor NÃO está desligado; gasto sem política vira aviso com o valor do ledger", async () => {
    process.env.LLM_ROLES_MODE = "shadow";
    const st = await advisorStatus(pool);
    expect(st.apiRolesMode).toBe("shadow");
    expect(st.spend24hUsd).toBeCloseTo(0.9, 6);
    expect(st.calls24h).toBe(1);
    expect(st.warnings.some((w) => /NÃO está desligado/.test(w))).toBe(true);
    expect(st.warnings.some((w) => /não há política advisor_pct/.test(w) && /0\.90/.test(w))).toBe(true);
    process.env.LLM_ROLES_MODE = "off";
    expect((await advisorStatus(pool)).warnings.some((w) => /NÃO está desligado/.test(w))).toBe(false);
  });

  it("divergência API (on) × runner (shadow): vira evento roles_mode_divergence (uma vez) e aparece no GET de settings", async () => {
    process.env.LLM_ROLES_MODE = "on";
    await noteCallerRolesMode(pool, "shadow", A.parentId);
    await noteCallerRolesMode(pool, "shadow", A.parentId);   // mesma transição: não duplica
    const ev = (await pool.query("SELECT detail FROM llm_guard_events WHERE kind = 'roles_mode_divergence'")).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ apiRolesMode: "on", callerRolesMode: "shadow" });
    await noteCallerRolesMode(pool, "lixo", null);           // valor inválido é ignorado (chamador antigo)
    testUser.id = A.userId; testUser.tenantId = null; testUser.role = "zentriz_admin";
    const res = await app.inject({ method: "GET", url: "/api/admin/llm-guard/settings" });
    expect(res.statusCode).toBe(200);
    const adv = res.json().advisor;
    expect(adv).toMatchObject({ apiRolesMode: "on", divergent: true });
    expect(adv.callerRolesModes).toContain("shadow");
    expect(adv.warnings.some((w: string) => /diverge entre a API \(on\)/.test(w))).toBe(true);
  });
});
