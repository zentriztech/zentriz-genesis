import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client: { query: (sql: string) => Promise<{ rows: { version: string }[] }> }): Promise<Set<string>> {
  const res = await client.query("SELECT version FROM schema_migrations ORDER BY version");
  return new Set(res.rows.map((r) => r.version));
}

/**
 * S-07: cada comando DDL de migration roda com `lock_timeout` e `statement_timeout` (por sessão), para que um
 * `ALTER TABLE` atrás de uma transação longa FALHE RÁPIDO (e a api não suba, como já era) em vez de esperar sem prazo
 * enfileirando todas as leituras da tabela atrás dele. Padrões conservadores, calibrado=falso; `0` desliga.
 * Variáveis: `MIGRATION_LOCK_TIMEOUT_MS` (padrão 5000) e `MIGRATION_STATEMENT_TIMEOUT_MS` (padrão 300000).
 */
export const MIGRATION_TIMEOUT_DEFAULTS = { lockTimeoutMs: 5_000, statementTimeoutMs: 300_000 } as const;
export interface MigrationTimeouts { lockTimeoutMs: number; statementTimeoutMs: number }
export function migrationTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): MigrationTimeouts {
  const num = (k: string, d: number) => { const raw = env[k]; if (raw === undefined || raw.trim() === "") return d; const n = Number(raw); return Number.isInteger(n) && n >= 0 ? n : d; };
  return {
    lockTimeoutMs: num("MIGRATION_LOCK_TIMEOUT_MS", MIGRATION_TIMEOUT_DEFAULTS.lockTimeoutMs),
    statementTimeoutMs: num("MIGRATION_STATEMENT_TIMEOUT_MS", MIGRATION_TIMEOUT_DEFAULTS.statementTimeoutMs),
  };
}

export async function runMigration(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  version: string,
  sql: string,
  timeouts: MigrationTimeouts = migrationTimeoutsFromEnv(),
): Promise<void> {
  // Strip comment-only lines so the semicolon splitter works cleanly
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // valores inteiros validados (sem parâmetro: SET não aceita bind)
  await client.query(`SET lock_timeout = ${timeouts.lockTimeoutMs}`);
  await client.query(`SET statement_timeout = ${timeouts.statementTimeoutMs}`);
  try {
    for (const st of statements) {
      try {
        await client.query(st);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "55P03" || code === "57014") {
          const kind = code === "55P03" ? `lock_timeout de ${timeouts.lockTimeoutMs} ms (há transação longa segurando a tabela? veja pg_stat_activity)` : `statement_timeout de ${timeouts.statementTimeoutMs} ms`;
          const msg = `[DB] Migration ${version} FALHOU por ${kind} em: ${st.replace(/\s+/g, " ").slice(0, 120)}`;
          console.error(msg);
          throw new Error(msg, { cause: e });
        }
        throw e;
      }
    }

    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    console.log(`[DB] Migration applied: ${version}`);
  } finally {
    // a conexão volta ao pool: devolve os timeouts ao padrão do servidor
    await client.query("RESET lock_timeout").catch(() => undefined);
    await client.query("RESET statement_timeout").catch(() => undefined);
  }
}

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client as Parameters<typeof ensureMigrationsTable>[0]);

    const applied = await appliedVersions(client as Parameters<typeof appliedVersions>[0]);

    let files: string[];
    try {
      files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort(); // lexicographic order: 001_... < 002_... < ...
    } catch {
      console.warn("[DB] migrations/ directory not found — skipping migrations");
      return;
    }

    for (const file of files) {
      const version = path.basename(file, ".sql");
      if (applied.has(version)) continue;

      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      await runMigration(
        client as Parameters<typeof runMigration>[0],
        version,
        sql,
      );
    }

    if (files.filter((f) => !applied.has(path.basename(f, ".sql"))).length === 0) {
      console.log("[DB] All migrations up to date");
    }
  } finally {
    client.release();
  }
}
