import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initDb(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf-8");
  // Remove apenas linhas que são só comentário, para não descartar blocos que começam com --
  const withoutCommentLines = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = withoutCommentLines
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const client = await pool.connect();
  try {
    for (const st of statements) {
      if (st) await client.query(st);
    }
  } finally {
    client.release();
  }
}
