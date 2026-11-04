/**
 * S-07 — cada comando DDL de migration roda com lock_timeout/statement_timeout: um ALTER atrás de uma transação longa
 * FALHA RÁPIDO (log claro, a migration não é registrada, a api não sobe) em vez de esperar sem prazo e enfileirar leituras.
 * Postgres real (banco descartável). Sem PG_TEST_URL os testes são skip.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import { describePg, createScratchDb, dbClientMock } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());

import { runMigration, migrationTimeoutsFromEnv, MIGRATION_TIMEOUT_DEFAULTS } from "./init.js";

describePg("S-07 — timeouts por comando de migration (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  const tbl = "s07_probe";

  beforeAll(async () => {
    scratch = await createScratchDb("evo_s07");
    pool = scratch.pool;
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await pool.query(`CREATE TABLE ${tbl} (id int)`);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  const registered = async (v: string) => (await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [v])).rows.length > 0;

  it("padrões conservadores e override por variável (0 desliga; lixo é ignorado)", () => {
    expect(migrationTimeoutsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ lockTimeoutMs: MIGRATION_TIMEOUT_DEFAULTS.lockTimeoutMs, statementTimeoutMs: MIGRATION_TIMEOUT_DEFAULTS.statementTimeoutMs });
    expect(migrationTimeoutsFromEnv({ MIGRATION_LOCK_TIMEOUT_MS: "250", MIGRATION_STATEMENT_TIMEOUT_MS: "0" } as unknown as NodeJS.ProcessEnv)).toEqual({ lockTimeoutMs: 250, statementTimeoutMs: 0 });
    expect(migrationTimeoutsFromEnv({ MIGRATION_LOCK_TIMEOUT_MS: "abc" } as unknown as NodeJS.ProcessEnv).lockTimeoutMs).toBe(5000);
  });

  it("ALTER atrás de uma transação longa falha RÁPIDO por lock_timeout, não registra a versão e converge quando o lock sai", async () => {
    const holder = await pool.connect();
    const runner = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT count(*) FROM ${tbl}`); // ACCESS SHARE mantido: o ALTER (ACCESS EXCLUSIVE) tem de esperar
      const t0 = Date.now();
      const err = await runMigration(runner, "s07-lock", `ALTER TABLE ${tbl} ADD COLUMN x int;`, { lockTimeoutMs: 300, statementTimeoutMs: 60_000 })
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/s07-lock FALHOU por lock_timeout de 300 ms/);
      expect(err!.message).toMatch(/ALTER TABLE s07_probe/);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(await registered("s07-lock")).toBe(false);
      // a sessão voltou ao padrão do servidor
      expect((await runner.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
      await holder.query("ROLLBACK");
      await runMigration(runner, "s07-lock", `ALTER TABLE ${tbl} ADD COLUMN x int;`, { lockTimeoutMs: 300, statementTimeoutMs: 60_000 });
      expect(await registered("s07-lock")).toBe(true);
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); runner.release(); }
  });

  it("statement_timeout: comando lento é cancelado com mensagem clara", async () => {
    const c = await pool.connect();
    try {
      const err = await runMigration(c, "s07-stmt", "SELECT pg_sleep(5);", { lockTimeoutMs: 1000, statementTimeoutMs: 200 }).then(() => null, (e: Error) => e);
      expect(err!.message).toMatch(/s07-stmt FALHOU por statement_timeout de 200 ms/);
      expect(await registered("s07-stmt")).toBe(false);
      expect((await c.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
    } finally { c.release(); }
  });

  it("erro comum de SQL continua propagando o erro original (semântica 'api não sobe se a migration falha')", async () => {
    const c = await pool.connect();
    try {
      await expect(runMigration(c, "s07-bad", "SELECT * FROM tabela_que_nao_existe;")).rejects.toThrow(/tabela_que_nao_existe/);
      expect(await registered("s07-bad")).toBe(false);
    } finally { c.release(); }
  });
});
