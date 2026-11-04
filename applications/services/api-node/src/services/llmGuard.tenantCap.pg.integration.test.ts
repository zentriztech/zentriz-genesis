/**
 * AV / A-5 — teto horário POR TENANT: o gasto de um tenant não liga a chave geral da plataforma (o global segue como último recurso).
 * Postgres real em banco descartável (o teto global soma o ledger inteiro); só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type pg from "pg";
import { describePg, createScratchDb, dbClientMock, seedAcceptedProduct, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());

import { preflight, getGuardSettings, setGuardSetting, tenantHourlyCap } from "./llmGuard.js";

describePg("A-5 (AV) — teto horário por tenant (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  const seeds: Seed[] = [];
  const pf = (s: Seed) => preflight(pool, { projectId: s.parentId, model: "claude-opus-4", estInputTokens: 100, maxOutputTokens: 100, purpose: "t", source: "agents" });
  const spend = (s: Seed, usd: number) => pool.query(
    `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model, input_tokens, output_tokens, cost_usd, prompt_hash)
     VALUES ($1,$1,$2,'fabrica','agents','t','x','m',1,1,$3,$4)`, [s.parentId, s.tenantId, usd, `h-${Math.random()}`]);
  const killSwitch = async () => (await getGuardSettings(pool)).kill_switch;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_a5");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
  }, 120_000);
  afterAll(async () => { for (const s of seeds) s.cleanup(); await scratch?.drop(); });
  beforeEach(async () => {
    await pool.query("DELETE FROM llm_call_ledger");
    await pool.query("DELETE FROM llm_guard_events");
    await setGuardSetting(pool, "kill_switch", "off", "test");
    await setGuardSetting(pool, "global_max_usd_per_hour", "40", "test");
    await pool.query("DELETE FROM llm_guard_settings WHERE key = 'tenant_max_usd_per_hour'");
  });
  const mk = async () => { const s = await seedAcceptedProduct(pool, { budgetUsd: 1000 }); seeds.push(s); return s; };

  it("tenantHourlyCap: auto = 50% do global; número fixo; 0 desliga", () => {
    expect(tenantHourlyCap({}, 40)).toBe(20);
    expect(tenantHourlyCap({ tenant_max_usd_per_hour: "auto" }, 12)).toBe(6);
    expect(tenantHourlyCap({ tenant_max_usd_per_hour: "7.5" }, 40)).toBe(7.5);
    expect(tenantHourlyCap({ tenant_max_usd_per_hour: "0" }, 40)).toBe(0);
    expect(tenantHourlyCap({}, 0)).toBe(0);
  });

  it("um tenant que estoura o próprio teto é negado SEM ligar a chave geral; outro tenant segue liberado", async () => {
    const A = await mk(); const B = await mk();
    await spend(A, 21);                        // > 20 (50% de 40), < 40
    const dA = await pf(A);
    expect(dA).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP", scope: "tenant" });
    expect((dA as { message: string }).message).toMatch(/tenant/);
    expect(await killSwitch()).toBe("off");    // plataforma intacta
    expect(await pf(B)).toMatchObject({ allow: true });
    const ev = await pool.query("SELECT detail FROM llm_guard_events WHERE kind = 'tenant_hourly_cap_denied'");
    expect(ev.rows).toHaveLength(1);
    await pf(A);                               // repetir não inunda o log (1 evento por hora)
    expect((await pool.query("SELECT 1 FROM llm_guard_events WHERE kind = 'tenant_hourly_cap_denied'")).rowCount).toBe(1);
  });

  it("teto fixo por setting; 0 desliga (volta a só o global); o global continua sendo o último recurso", async () => {
    const A = await mk(); const B = await mk();
    await setGuardSetting(pool, "tenant_max_usd_per_hour", "5", "test");
    await spend(A, 6);
    expect(await pf(A)).toMatchObject({ allow: false, scope: "tenant" });
    await setGuardSetting(pool, "tenant_max_usd_per_hour", "0", "test");
    expect(await pf(A)).toMatchObject({ allow: true });
    // soma de tenants acima do global ⇒ chave geral liga (último recurso)
    await spend(B, 35);
    const d = await pf(A);
    expect(d).toMatchObject({ allow: false, code: "GLOBAL_HOURLY_CAP" });
    expect((d as { scope?: string }).scope).toBeUndefined();
    expect(await killSwitch()).toBe("on");
  });
});
