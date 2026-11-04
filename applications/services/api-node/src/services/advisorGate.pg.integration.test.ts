/**
 * C4' — teto do Advisor = X % × orçamento TOTAL do projeto-dono, aplicado PELO GUARD (`advisorGate`), gasto = ledger.
 * Postgres real. Só roda com PG_TEST_URL (localhost:55432|55440|55441).
 *
 * Aceites do desenho 27 (§4, C4'): (a) com a env `ADVISOR_MAX_USD_PER_RUN` removida o teto continua valendo; (b) reinício
 * não zera o gasto do Advisor (nova instância/pool lê o MESMO ledger); (c) sem base ⇒ `advisor_denied_no_base` persistido e visível;
 * (d) `BUDGET_MISSING` inalterado; (e) teto estourado nega só o Advisor (evento, nunca erro da task).
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { costPolicyRoutes } from "../routes/costPolicies.js";
import { advisorGate, advisorSpentUsd, preflight, recordCall, setGuardSetting } from "./llmGuard.js";
import { advisorFloorUsd } from "../lib/advisorFloor.js";

describePg("C4' — teto percentual do Advisor no Guard (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let A: Seed; // orçamento US$ 50
  let C: Seed; // orçamento US$ 2 (teto abaixo do piso com 10 %)
  const admin = () => Object.assign(testUser, { id: "u-admin", email: "admin@t.test", role: "zentriz_admin", tenantId: null });
  const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/cost-policies", payload });
  const clearPolicy = () => app.inject({ method: "DELETE", url: "/api/cost-policies?scopeType=global&key=advisor_pct" });
  const advisorLedger = (s: Seed, usd: number, role: string | null = "advisor") =>
    pool.query(
      `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model,
         input_tokens, output_tokens, cost_usd, prompt_hash, llm_role)
       VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,$3,$4,$5)`,
      [s.parentId, s.tenantId, usd, `h-${Math.random()}`, role],
    );
  const events = async (kind: string, projectId?: string) =>
    (await pool.query("SELECT detail, project_id FROM llm_guard_events WHERE kind = $1 AND ($2::uuid IS NULL OR project_id = $2) ORDER BY id", [kind, projectId ?? null])).rows;

  const prevRolesMode = process.env.LLM_ROLES_MODE;
  beforeAll(async () => {
    process.env.LLM_ROLES_MODE = "on"; // AN/M1: com política, o gate exige o registro de papéis ligado nesta API
    scratch = await createScratchDb("evo_c4");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([costPolicyRoutes]);
    A = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    C = await seedAcceptedProduct(pool, { budgetUsd: 2 });
    await setGuardSetting(pool, "kill_switch", "off", "test");
    admin();
  }, 120_000);
  afterAll(async () => {
    if (prevRolesMode === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = prevRolesMode;
    await app?.close();
    A?.cleanup(); C?.cleanup();
    await scratch?.drop();
  });

  it("sem política: mode legacy (fallback explícito em env no chamador), sem evento e sem dólar novo", async () => {
    const g = await advisorGate(pool, { projectId: A.parentId, projectedUsd: 100 });
    expect(g).toEqual({ allow: true, mode: "legacy" });
    expect(await events("advisor_cap_reached", A.parentId)).toHaveLength(0);
  });

  it("ACEITE: teto = pct % × orçamento total do dono; gasto vem do ledger (sem env, sem memória); estourar nega SÓ o Advisor com evento", async () => {
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10 })).statusCode).toBe(200); // teto = 5
    delete process.env.ADVISOR_MAX_USD_PER_RUN; // env REMOVIDA
    await advisorLedger(A, 3);
    await advisorLedger(A, 1.5, "orchestrator"); // outro papel não conta
    expect(await advisorSpentUsd(pool, A.parentId)).toBeCloseTo(3, 6);
    const ok = await advisorGate(pool, { projectId: A.parentId, projectedUsd: 1.9 });
    expect(ok).toMatchObject({ allow: true, mode: "policy", capUsd: 5, spentUsd: 3, baseUsd: 50, pct: 10, policyAuthor: "admin@t.test", policyVersion: expect.any(Number) });
    expect((ok as { policyUpdatedAt: string }).policyUpdatedAt).toBeTruthy();
    const over = await advisorGate(pool, { projectId: A.parentId, projectedUsd: 2.5 });
    expect(over).toMatchObject({ allow: false, code: "advisor_cap_reached", capUsd: 5, spentUsd: 3 });
    const ev = await events("advisor_cap_reached", A.parentId);
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ reason: "cap_reached", capUsd: 5, spentUsd: 3, policyAuthor: "admin@t.test", ownerId: A.parentId });
    // em voo conta (reservas do chamador)
    expect((await advisorGate(pool, { projectId: A.parentId, projectedUsd: 1, inflightUsd: 1.5 })).allow).toBe(false);
    // o resto do Guard NÃO foi afetado: o preflight comum segue liberando o projeto (nunca BLOCKED/failed pelo Advisor)
    expect((await preflight(pool, { projectId: A.parentId, purpose: "t", source: "agents" })).allow).toBe(true);
    // mudar a política muda a próxima decisão (base persistida, nada no código)
    await put({ key: "advisor_pct", scopeType: "global", pct: 20 });
    expect(await advisorGate(pool, { projectId: A.parentId, projectedUsd: 2.5 })).toMatchObject({ allow: true, capUsd: 10 });
  });

  it("ACEITE: reinício não zera o gasto do Advisor — uma NOVA instância (outro pool, outro processo lógico) lê o mesmo ledger", async () => {
    const before = await advisorGate(pool, { projectId: A.parentId, projectedUsd: 0 });
    const url = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
    const fresh = new pg.Pool({ connectionString: url, max: 2 });
    fresh.on("error", () => undefined);
    try {
      const after = await advisorGate(fresh, { projectId: A.parentId, projectedUsd: 0 });
      expect(after).toMatchObject({ allow: true, spentUsd: 3 });
      expect((after as { spentUsd: number }).spentUsd).toBe((before as { spentUsd: number }).spentUsd);
      await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
      expect(await advisorGate(fresh, { projectId: A.parentId, projectedUsd: 2.5 })).toMatchObject({ allow: false, code: "advisor_cap_reached" });
    } finally {
      await fresh.end();
    }
  });

  it("o gasto real entra pelo recordCall (llm_role='advisor' no ledger) e conta no teto", async () => {
    const prev = process.env.LLM_ROLES_MODE;
    process.env.LLM_ROLES_MODE = "on";
    try {
      const before = await advisorSpentUsd(pool, A.parentId);
      await recordCall(pool, { projectId: A.parentId, purpose: "t", source: "agents", model: "us.anthropic.claude-opus-5-5",
        inputTokens: 100_000, outputTokens: 40_000, llmRole: "advisor", promptHash: "h-rec" });
      expect(await advisorSpentUsd(pool, A.parentId)).toBeGreaterThan(before);
    } finally {
      if (prev === undefined) delete process.env.LLM_ROLES_MODE; else process.env.LLM_ROLES_MODE = prev;
    }
  });

  it("ACEITE: base ausente/inválida ⇒ advisor_denied_no_base persistido e visível, só o Advisor; BUDGET_MISSING inalterado", async () => {
    await put({ key: "advisor_pct", scopeType: "global", pct: 10 });
    const D = await seedAcceptedProduct(pool, { budgetUsd: 40 });
    try {
      await pool.query("UPDATE projects SET budget_usd = NULL WHERE id = $1", [D.parentId]);
      const g = await advisorGate(pool, { projectId: D.parentId, projectedUsd: 0.1 });
      expect(g).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
      const ev = await events("advisor_denied_no_base", D.parentId);
      expect(ev).toHaveLength(1);
      expect(ev[0].detail).toMatchObject({ reason: "budget_missing", ownerId: D.parentId });
      // BUDGET_MISSING do preflight, exatamente como antes (nega tudo)
      const pf = await preflight(pool, { projectId: D.parentId, purpose: "t", source: "agents" });
      expect(!pf.allow && pf.code).toBe("BUDGET_MISSING");
    } finally {
      D.cleanup();
    }
    // projeto desconhecido
    const unk = await advisorGate(pool, { projectId: "00000000-0000-4000-8000-000000000000", projectedUsd: 0.1 });
    expect(unk).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
    // teto abaixo do piso calculado = base inválida (10 % de US$ 2 = 0,20 < piso)
    expect(advisorFloorUsd()).toBeGreaterThan(0.2);
    const low = await advisorGate(pool, { projectId: C.parentId, projectedUsd: 0.01 });
    expect(low).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
    expect((await events("advisor_denied_no_base", C.parentId))[0].detail).toMatchObject({ reason: "cap_below_floor" });
    // sem política e sem orçamento: também sem base (e nada passa no preflight de qualquer jeito)
    await clearPolicy();
    const E = await seedAcceptedProduct(pool, { budgetUsd: 10 });
    try {
      await pool.query("UPDATE projects SET budget_usd = NULL WHERE id = $1", [E.parentId]);
      expect(await advisorGate(pool, { projectId: E.parentId })).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
    } finally { E.cleanup(); }
  });

  it("falha de leitura ⇒ nega o Advisor (fail-closed), não libera", async () => {
    const broken = { query: async () => { throw new Error("db fora"); } };
    const g = await advisorGate(broken as never, { projectId: A.parentId, projectedUsd: 0.1 });
    expect(g).toMatchObject({ allow: false, code: "advisor_denied_no_base" });
  });

  it("piso na gravação: advisor_pct com baseBudgetUsd que gera teto abaixo do piso é RECUSADO; sem a base, grava", async () => {
    const floor = advisorFloorUsd();
    expect(floor).toBeCloseTo(0.6, 4); // 40k × US$5/Mtok + 16k × US$25/Mtok (assunção calibrado=false)
    admin();
    const bad = await put({ key: "advisor_pct", scopeType: "global", pct: 10, baseBudgetUsd: 5 }); // 0,50 < 0,60
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("ADVISOR_BELOW_FLOOR");
    expect(bad.json().message).toContain("calibrado=false");
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10, baseBudgetUsd: 6 })).statusCode).toBe(200); // 0,60 ok
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10, baseBudgetUsd: 0 })).statusCode).toBe(400);
    // piso declarado na política (maior que o calculado) também vale
    expect((await put({ key: "advisor_pct", scopeType: "global", pct: 10, baseBudgetUsd: 100, floorUsd: 20 })).statusCode).toBe(400);
    await clearPolicy();
  });
});
