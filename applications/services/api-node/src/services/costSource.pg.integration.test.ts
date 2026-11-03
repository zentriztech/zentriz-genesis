/**
 * C8' — integração em Postgres REAL (efêmero): fonte única de custo, reconciliação e cota diária.
 *
 *   docker run --rm -d --name g-c8-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t -p 55432:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/t npx tsx scripts/apply-migrations-test.ts
 *   PG_TEST_URL=postgres://postgres:pw@localhost:55432/t npx vitest run src/services/costSource.pg.integration.test.ts
 *
 * Só roda com PG_TEST_URL e recusa qualquer URL que não seja localhost:55432. Usa meses de 2019 e remove o que cria.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { costUsd } from "../lib/modelPricing.js";
import { checkTenantBudget, getTenantMonthSpendUsd } from "./tenantCostCap.js";
import { reconcileCostSources } from "./costReconcile.js";
import { preflight } from "./llmGuard.js";

const URL = process.env.PG_TEST_URL;
const d = URL ? describe : describe.skip;

d("C8' — Postgres real (efêmero)", () => {
  let pool: pg.Pool;
  let tenantA: string; let tenantB: string; let userId: string; let projA: string; let projB: string;
  let prevKill: string | undefined;
  const MODEL = "claude-haiku-4-5";
  const metricsCost = costUsd(MODEL, 1_000_000, 0);
  const uid = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    if (!/@(localhost|127\.0\.0\.1):55432\//.test(URL!)) throw new Error("PG_TEST_URL deve apontar para localhost:55432");
    pool = new pg.Pool({ connectionString: URL, max: 4 });
    const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_llm_ledger_tenant_created'");
    expect(idx.rowCount).toBe(1); // migration 140 aplicada
    tenantA = (await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('c8a-'||$1, 'plan_prata') RETURNING id`, [uid()])).rows[0].id;
    tenantB = (await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('c8b-'||$1, 'plan_prata') RETURNING id`, [uid()])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name) VALUES ($1,'u') RETURNING id`, [`u-${uid()}@t.test`])).rows[0].id;
    const mk = async (t: string) => {
      const prod = (await pool.query(`INSERT INTO products (tenant_id, created_by, name) VALUES ($1,$2,'p') RETURNING id`, [t, userId])).rows[0].id;
      return (await pool.query(
        `INSERT INTO projects (tenant_id, created_by, title, product_id, budget_usd) VALUES ($1,$2,'p',$3,1000) RETURNING id`, [t, userId, prod])).rows[0].id;
    };
    projA = await mk(tenantA); projB = await mk(tenantB);
    const ks = await pool.query("SELECT value FROM llm_guard_settings WHERE key='kill_switch'");
    prevKill = ks.rows[0]?.value;
    const led = (t: string, ts: string, usd: number) => pool.query(
      `INSERT INTO llm_call_ledger (created_at, tenant_id, phase, model, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,'fabrica',$3,10,5,$4)`,
      [ts, t, MODEL, usd]);
    const met = (p: string, ts: string) => pool.query(
      `INSERT INTO project_agent_metrics (project_id, agent, input_tokens, output_tokens, model, created_at) VALUES ($1,'dev',1000000,0,$2,$3)`,
      [p, MODEL, ts]);
    // Cobertura do ledger começa em 2019-07-10 12:00 (linha do tenant B: a cobertura é GLOBAL).
    await led(tenantB, "2019-07-10T12:00:00Z", 1);
    await led(tenantA, "2019-07-15T00:00:00Z", 2);   // julho, depois da cobertura
    await led(tenantA, "2019-08-05T00:00:00Z", 4);   // agosto
    await met(projA, "2019-06-20T00:00:00Z");        // junho: anterior à cobertura
    await met(projA, "2019-07-05T00:00:00Z");        // julho ANTES da cobertura (conta no híbrido)
    await met(projA, "2019-07-20T00:00:00Z");        // julho DEPOIS (ledger já cobre: não duplica)
    await met(projA, "2019-08-06T00:00:00Z");        // agosto
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM llm_call_ledger WHERE tenant_id = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM llm_guard_events WHERE detail->>'tenantId' = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM tenant_llm_configs WHERE tenant_id = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM projects WHERE tenant_id = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM products WHERE tenant_id = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [[tenantA, tenantB]]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      if (prevKill != null) await pool.query("UPDATE llm_guard_settings SET value=$1 WHERE key='kill_switch'", [prevKill]);
      await pool.end();
    }
  });
  afterEach(() => { delete process.env.COST_SOURCE_LEDGER; delete process.env.DAILY_TOKEN_QUOTA; });

  it("off: só project_agent_metrics (julho = 2 linhas)", async () => {
    expect(await getTenantMonthSpendUsd(pool, tenantA, "2019-07")).toBeCloseTo(2 * metricsCost, 6);
  });

  it("on: junho só metrics · julho = metrics antes da cobertura + ledger depois · agosto só ledger", async () => {
    process.env.COST_SOURCE_LEDGER = "on";
    expect(await getTenantMonthSpendUsd(pool, tenantA, "2019-06")).toBeCloseTo(metricsCost, 6);
    expect(await getTenantMonthSpendUsd(pool, tenantA, "2019-07")).toBeCloseTo(metricsCost + 2, 6);
    expect(await getTenantMonthSpendUsd(pool, tenantA, "2019-08")).toBeCloseTo(4, 6);
    expect(await getTenantMonthSpendUsd(pool, tenantB, "2019-07")).toBeCloseTo(1, 6);
  });

  it("shadow devolve o valor de metrics", async () => {
    process.env.COST_SOURCE_LEDGER = "shadow";
    expect(await getTenantMonthSpendUsd(pool, tenantA, "2019-08")).toBeCloseTo(metricsCost, 6);
  });

  it("reconciliação: linhas, divergência e cobertura", async () => {
    const rep = await reconcileCostSources(pool, { tenantId: tenantA });
    const by = Object.fromEntries(rep.rows.map((r) => [r.month, r]));
    expect(by["2019-06"]).toMatchObject({ coverage: "none", ledgerUsd: 0, metricsRows: 1 });
    expect(by["2019-07"]).toMatchObject({ coverage: "partial", ledgerUsd: 2, metricsRows: 2 });
    expect(by["2019-08"]).toMatchObject({ coverage: "full", ledgerUsd: 4, metricsRows: 1 });
    expect(by["2019-08"].deltaUsd).toBeCloseTo(4 - metricsCost, 6);
    const one = await reconcileCostSources(pool, { tenantId: tenantA, month: "2019-08" });
    expect(one.rows).toHaveLength(1);
    const flat = await reconcileCostSources(pool, { tenantId: tenantA, month: "2019-08", flatInPerMTok: 1, flatOutPerMTok: 2 });
    expect(flat.rows[0].metricsUsd).toBeCloseTo(1, 6);
  });

  it("cap do tenant (on) barra pelo ledger e fail-open registra evento real", async () => {
    process.env.COST_SOURCE_LEDGER = "on";
    await pool.query("UPDATE tenants SET monthly_llm_budget_usd = 0.5 WHERE id = $1", [tenantB]);
    // gasto do mês corrente de B: sem linhas ⇒ ok
    expect(await checkTenantBudget(pool, tenantB)).toEqual({ ok: true });
    await pool.query(`INSERT INTO llm_call_ledger (tenant_id, phase, model, cost_usd) VALUES ($1,'fabrica',$2,0.75)`, [tenantB, MODEL]);
    expect(await checkTenantBudget(pool, tenantB)).toMatchObject({ ok: false, budgetUsd: 0.5 });
    const broken = { query: async (sql: string, p?: unknown[]) => {
      if (sql.includes("INSERT INTO llm_guard_events")) return pool.query(sql, p);
      throw new Error("falha simulada");
    } };
    expect(await checkTenantBudget(broken, tenantB)).toEqual({ ok: true });
    const ev = await pool.query("SELECT 1 FROM llm_guard_events WHERE kind='tenant_cap_fail_open' AND detail->>'tenantId' = $1", [tenantB]);
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("cota diária: on nega, shadow só registra, off libera; NULL = sem cota", async () => {
    await pool.query("UPDATE llm_guard_settings SET value='off' WHERE key='kill_switch'");
    await pool.query(`INSERT INTO tenant_llm_configs (tenant_id, provider, model_id, daily_token_quota, priority) VALUES ($1,'bedrock','m',1000,0)`, [tenantA]);
    await pool.query(`INSERT INTO llm_call_ledger (tenant_id, budget_project_id, project_id, phase, model, input_tokens, output_tokens, cost_usd)
                      VALUES ($1,$2,$2,'fabrica',$3,900,100,0)`, [tenantA, projA, MODEL]);
    // um dia atrás NÃO conta
    await pool.query(`INSERT INTO llm_call_ledger (created_at, tenant_id, phase, model, input_tokens, output_tokens, cost_usd)
                      VALUES (now() - interval '30 hours', $1,'fabrica',$2,5000,5000,0)`, [tenantA, MODEL]);
    const call = { projectId: projA, model: MODEL, estInputTokens: 10, maxOutputTokens: 10 };

    expect(await preflight(pool, call)).toMatchObject({ allow: true });           // off
    process.env.DAILY_TOKEN_QUOTA = "shadow";
    expect(await preflight(pool, call)).toMatchObject({ allow: true });
    process.env.DAILY_TOKEN_QUOTA = "on";
    const denied = await preflight(pool, call);
    expect(denied).toMatchObject({ allow: false, code: "GLOBAL_DAILY_CAP" });
    const kinds = (await pool.query("SELECT kind FROM llm_guard_events WHERE detail->>'tenantId' = $1 AND kind LIKE 'daily_token_quota%'", [tenantA])).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["daily_token_quota_shadow", "daily_token_quota_denied"]));
    const paused = await pool.query("SELECT budget_paused_at FROM projects WHERE id = $1", [projA]);
    expect(paused.rows[0].budget_paused_at).toBeNull();                              // a cota NÃO pausa o projeto
    await pool.query("UPDATE tenant_llm_configs SET daily_token_quota = NULL WHERE tenant_id = $1", [tenantA]);
    expect(await preflight(pool, call)).toMatchObject({ allow: true });
  });
});
