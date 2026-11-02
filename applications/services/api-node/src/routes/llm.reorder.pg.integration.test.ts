/**
 * Integração em Postgres REAL (efêmero) — plano v2, 2A.1 a 2A.3:
 *  1. o reorder (rota real, `UPDATE priority`) preserva TODAS as colunas — papéis, verify_<papel>_*,
 *     verify_*, cyborg_*, credenciais e o próprio `id` — para permutação cíclica de 4 slots;
 *  2. o backfill SQL da migration 139 produz exatamente `backfillRolesFromLegacy`;
 *  3. a UNIQUE (tenant_id, priority) continua valendo e o CHECK impede persistir prioridade negativa fora de transação útil.
 *
 * Só roda com PG_TEST_URL (Postgres EFÊMERO já migrado 1→139, ver scripts/apply-migrations-test.ts):
 *   docker run --rm -d --name g2a-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
 *   PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run src/routes/llm.reorder.pg.integration.test.ts
 * Recusa qualquer URL que não seja localhost:55432. Sem PG_TEST_URL o bloco é skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const URL = process.env.PG_TEST_URL;
const here = path.dirname(fileURLToPath(import.meta.url));

// A rota importa `pool` de db/client.js: apontamos esse módulo para o Postgres efêmero.
const holder = vi.hoisted(() => ({ pool: null as unknown as pg.Pool }));
vi.mock("../db/client.js", () => ({
  get pool() { return holder.pool; },
}));
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { id: "u1", email: "a@x", role: "zentriz_admin", tenantId: null };
  },
}));
vi.mock("../services/llmSlotProbe.js", () => ({
  probeSlot: async () => ({ ok: true, kind: "", message: "", latencyMs: 1, model: "m" }),
  recordProbe: async () => {},
  listModels: async () => null,
}));

import Fastify from "fastify";

const d = URL ? describe : describe.skip;

const SONNET = "us.anthropic.claude-sonnet-4-6";
const OPUS48 = "us.anthropic.claude-opus-4-8";
const OPUS47 = "us.anthropic.claude-opus-4-7";
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

d("reorder + backfill — Postgres real (efêmero)", () => {
  let pool: pg.Pool;
  let tenantId: string;
  let seq = 0;
  const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    if (!/@(localhost|127\.0\.0\.1):55432\//.test(URL!)) {
      throw new Error("PG_TEST_URL deve apontar para o Postgres efêmero em localhost:55432");
    }
    pool = new pg.Pool({ connectionString: URL, max: 6 });
    holder.pool = pool;
    const t = await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('t-'||$1, 'plan_prata') RETURNING id`, [uid()]);
    tenantId = t.rows[0].id;
  });
  afterAll(async () => { await pool?.end(); });

  const seedSlot = (priority: number, extra: Record<string, unknown> = {}) => pool.query(
    `INSERT INTO tenant_llm_configs
       (tenant_id, priority, provider, model_id, model_id_fallback, credentials, cyborg_model_id, cyborg_model_id_fallback,
        model_orchestrator, model_advisor, model_staff,
        verified_at, verify_status, verify_error, verify_model, verify_latency_ms,
        verify_orchestrator_status, verify_orchestrator_at, verify_orchestrator_error,
        verify_advisor_status, verify_advisor_at, verify_advisor_error,
        verify_staff_status, verify_staff_at, verify_staff_error, max_concurrent_projects, daily_token_quota, deadpool_token_reserve)
     VALUES ($1,$2,'bedrock',$3::varchar,$4,$5,$6,$7,$8,$9,$10,
        now(),'ok',NULL,$3::text,${100 + priority},
        'ok',now(),NULL, 'model',now(),'sem direito ao modelo', 'ok',now(),NULL, ${5 + priority}, ${1000 * (priority + 1)}, ${priority})`,
    [tenantId, priority, extra.model ?? `model-${priority}`, extra.fb ?? `fb-${priority}`,
     JSON.stringify({ aws_access_key_id: `AKIA_${priority}`, aws_secret_access_key: `SEC_${priority}`, aws_region: "us-east-1" }),
     `cy-${priority}`, `cyfb-${priority}`, `orq-${priority}`, `adv-${priority}`, `stf-${priority}`]);

  const snapshot = async () => (await pool.query(
    `SELECT * FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority`, [tenantId])).rows as Record<string, unknown>[];

  const reorder = async (order: number[]) => {
    const { llmRoutes } = await import("./llm.js");
    const app = Fastify(); await app.register(llmRoutes); await app.ready();
    const res = await app.inject({ method: "POST", url: `/api/tenant/llm-config/reorder?tenantId=${tenantId}`, payload: { order } });
    await app.close();
    return res;
  };

  it("a migration 138 criou as colunas e a faixa -4..3; a 139 está aplicada", async () => {
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('tenant_llm_configs','zentriz_llm_config')
         AND column_name ~ '^(model_(orchestrator|advisor|staff)|verify_(orchestrator|advisor|staff)_(status|at|error))$'`)).rows;
    expect(cols).toHaveLength(24); // 12 colunas × 2 tabelas
    const v = (await pool.query(`SELECT version FROM schema_migrations WHERE version IN ('138_llm_roles_columns','139_llm_roles_backfill')`)).rows;
    expect(v).toHaveLength(2);
  });

  it("permutação CÍCLICA de 4 slots: todas as colunas sobrevivem, id idêntico, só priority/updated_at mudam", async () => {
    for (let p = 0; p < 4; p++) await seedSlot(p);
    const antes = await snapshot();
    const res = await reorder([1, 2, 3, 0]);   // ciclo completo, usa as 4 posições (precisa de estacionamento)
    expect(res.statusCode).toBe(200);
    const depois = await snapshot();
    expect(depois).toHaveLength(4);
    // posição i ← slot antigo order[i]
    const order = [1, 2, 3, 0];
    for (let i = 0; i < 4; i++) {
      const old = antes[order[i]];
      const now = depois[i];
      expect(now.priority).toBe(i);
      for (const k of Object.keys(old)) {
        if (k === "priority" || k === "updated_at") continue;
        expect(now[k], `coluna ${k} do slot ${order[i]}→${i}`).toEqual(old[k]);
      }
    }
    // Garantias explícitas das colunas novas e das antigas que o INSERT fixo do reorder antigo perdia.
    const s0 = depois[0];
    expect([s0.model_orchestrator, s0.model_advisor, s0.model_staff]).toEqual(["orq-1", "adv-1", "stf-1"]);
    expect(s0.verify_advisor_error).toBe("sem direito ao modelo");
    expect(s0.verify_orchestrator_status).toBe("ok");
    expect(s0.cyborg_model_id).toBe("cy-1");
    expect((s0.credentials as Record<string, string>).aws_access_key_id).toBe("AKIA_1");
    expect(Number(s0.daily_token_quota)).toBe(2000);
    expect(depois.map((r) => r.id)).toEqual([1, 2, 3, 0].map((i) => antes[i].id));
  });

  it("troca simples, remoção por omissão e rollback em order inválida", async () => {
    const base = await snapshot();
    expect((await reorder([1, 0])).statusCode).toBe(200);          // 0 e 1 trocam; 2 e 3 removidos (semântica do portal)
    const apos = await snapshot();
    expect(apos.map((r) => r.priority)).toEqual([0, 1]);
    expect(apos[0].id).toBe(base[1].id);
    expect(apos[1].id).toBe(base[0].id);
    const inval = await reorder([0, 3]);                           // 3 não existe mais
    expect(inval.statusCode).toBe(400);
    expect((await snapshot()).map((r) => r.id)).toEqual(apos.map((r) => r.id)); // nada mudou
  });

  it("nenhuma prioridade negativa persiste e a UNIQUE continua valendo", async () => {
    const neg = await pool.query(`SELECT count(*)::int AS n FROM tenant_llm_configs WHERE priority < 0`);
    expect(neg.rows[0].n).toBe(0);
    await expect(seedSlot(0)).rejects.toThrow(/tenant_llm_configs_tenant_priority_key|unique/i);
    await expect(pool.query(`UPDATE tenant_llm_configs SET priority = 4 WHERE tenant_id = $1 AND priority = 0`, [tenantId]))
      .rejects.toThrow(/priority_check/);
  });

  it("conta de gestão (zentriz_llm_config): reorder cíclico preserva colunas dos papéis e verify_<papel>_*", async () => {
    await pool.query(`DELETE FROM zentriz_llm_config`);
    for (let p = 0; p < 3; p++) {
      await pool.query(
        `INSERT INTO zentriz_llm_config (priority, provider, model_id, model_id_fallback, credentials, label,
            model_orchestrator, model_advisor, model_staff, verify_advisor_status, verify_staff_error, cyborg_model_id)
         VALUES ($1,'bedrock',$2::varchar,$3,'{"aws_access_key_id":"K"}'::jsonb,$4,$5,$6,$7,'ok','x-err',$8)`,
        [p, `m${p}`, `f${p}`, `lbl${p}`, `o${p}`, `a${p}`, `s${p}`, `cy${p}`]);
    }
    const antes = (await pool.query(`SELECT * FROM zentriz_llm_config ORDER BY priority`)).rows as Record<string, unknown>[];
    const { managementLlmRoutes } = await import("./managementLlm.js");
    const app = Fastify(); await app.register(managementLlmRoutes); await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/management/llm-config/reorder", payload: { order: [2, 0, 1] } });
    await app.close();
    expect(res.statusCode).toBe(200);
    const depois = (await pool.query(`SELECT * FROM zentriz_llm_config ORDER BY priority`)).rows as Record<string, unknown>[];
    const order = [2, 0, 1];
    expect(depois).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      for (const k of Object.keys(antes[order[i]])) {
        if (k === "priority" || k === "updated_at") continue;
        expect(depois[i][k], `coluna ${k}`).toEqual(antes[order[i]][k]);
      }
    }
    expect([depois[0].model_orchestrator, depois[0].model_advisor, depois[0].model_staff]).toEqual(["o2", "a2", "s2"]);
  });

  it("backfill SQL (migration 139) == backfillRolesFromLegacy nos casos do baseline e nas bordas", async () => {
    const { backfillRolesFromLegacy } = await import("../lib/llmRoleSlots.js");
    const casos: Array<{ model: string; fb: string | null; cy: string | null }> = [
      { model: OPUS48, fb: OPUS47, cy: OPUS48 },       // Opus com fallback da mesma classe
      { model: OPUS48, fb: OPUS48, cy: OPUS47 },       // fallback == principal ⇒ NULL
      { model: SONNET, fb: OPUS48, cy: OPUS48 },       // Sonnet-like com Advisor Opus
      { model: SONNET, fb: null, cy: OPUS48 },         // fallback nulo + cyborg (D3)
      { model: SONNET, fb: null, cy: null },           // nada
      { model: SONNET, fb: "  ", cy: SONNET },         // vazio + cyborg igual ao principal
      { model: "gemini-3-pro", fb: "gemini-3-flash", cy: null }, // não-Claude
    ];
    const tids: string[] = [];
    for (const c of casos) {
      const t = await pool.query(`INSERT INTO tenants (name, plan_id) VALUES ('bf-'||$1, 'plan_prata') RETURNING id`, [uid()]);
      tids.push(t.rows[0].id);
      await pool.query(
        `INSERT INTO tenant_llm_configs (tenant_id, priority, provider, model_id, model_id_fallback, cyborg_model_id)
         VALUES ($1,0,'bedrock',$2,$3,$4)`, [t.rows[0].id, c.model, c.fb, c.cy]);
    }
    // Reaplica os statements da 139 com o MESMO splitter do runner.
    const sql = await fs.readFile(path.join(here, "../db/migrations/139_llm_roles_backfill.sql"), "utf-8");
    const stmts = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((s) => s.trim()).filter(Boolean);
    for (const st of stmts) await pool.query(st);
    const rows = (await pool.query(
      `SELECT model_id, model_id_fallback, cyborg_model_id, model_orchestrator, model_advisor, model_staff
         FROM tenant_llm_configs WHERE tenant_id = ANY($1::uuid[])`, [tids])).rows;
    expect(rows).toHaveLength(casos.length);
    for (const r of rows) {
      const esperado = backfillRolesFromLegacy(
        { modelId: r.model_id, modelIdFallback: r.model_id_fallback, cyborgModelId: r.cyborg_model_id });
      expect(r.model_orchestrator).toBe(esperado.orchestrator);
      expect(r.model_advisor, `${r.model_id} fb=${r.model_id_fallback} cy=${r.cyborg_model_id}`).toBe(esperado.advisor);
      expect(r.model_staff).toBeNull();
    }
    // idempotência: segunda execução não altera nada
    const antes = (await pool.query(`SELECT id, model_orchestrator, model_advisor FROM tenant_llm_configs ORDER BY id`)).rows;
    for (const st of stmts) await pool.query(st);
    const depois = (await pool.query(`SELECT id, model_orchestrator, model_advisor FROM tenant_llm_configs ORDER BY id`)).rows;
    expect(depois).toEqual(antes);
  });
});
