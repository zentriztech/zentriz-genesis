import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Replica EXATA da normalização do runner (db/init.ts::runMigration): remove linhas de
 * comentário `--` e faz split ingênuo por `;`. Se o runner mudar, ESTE teste deve mudar junto.
 */
function splitStatements(sql: string): string[] {
  const stripped = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("migrations sanity (split-by-semicolon runner)", () => {
  it("há pelo menos uma migration", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Guarda contra a classe de bug do 048: um `;` DENTRO de um string literal faz o runner
  // (split ingênuo por `;`) partir o statement no meio da string → "unterminated quoted string"
  // → api entra em crash-loop no boot. Detecção: após o split, cada statement deve ter um número
  // PAR de aspas simples (aspas balanceadas). Um `;` interno a uma string deixa aspas ímpares.
  for (const file of files) {
    it(`${file}: aspas simples balanceadas em cada statement pós-split`, () => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      for (const st of splitStatements(sql)) {
        const singleQuotes = (st.match(/'/g) ?? []).length;
        expect(
          singleQuotes % 2,
          `Statement com aspas ímpares (provável ';' dentro de string literal) em ${file}:\n${st.slice(0, 160)}`,
        ).toBe(0);
      }
    });
  }
});
