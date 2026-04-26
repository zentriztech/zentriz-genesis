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

async function runMigration(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  version: string,
  sql: string,
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

  for (const st of statements) {
    await client.query(st);
  }

  await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
  console.log(`[DB] Migration applied: ${version}`);
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
