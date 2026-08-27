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

// RFC-0003 / Task 2: invariantes de CHECK que já foram quebrados por reconstrução silenciosa.
// A migration 040 reconstruiu projects_status_check SEM 'queued' (gap G5) → promover sob teto
// de concorrência estourava 500. Estes testes garantem que a ÚLTIMA reconstrução de cada CHECK
// preserva os valores exigidos; uma futura migration que os derrube volta a falhar aqui.
describe("RFC-0003 — invariantes de CHECK preservados na última reconstrução", () => {
  function lastAddConstraintBody(pattern: RegExp): string {
    let body = "";
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      const stripped = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      const matches = stripped.match(pattern);
      if (matches && matches.length > 0) body = matches[matches.length - 1];
    }
    return body;
  }

  it("projects_status_check ainda aceita 'queued' (gap G5)", () => {
    const body = lastAddConstraintBody(/ADD CONSTRAINT projects_status_check[\s\S]*?\)\s*\)/g);
    expect(body, "nenhuma migration define projects_status_check").not.toBe("");
    expect(body).toContain("'queued'");
  });

  it("products_lifecycle_status_check aceita 'draft' (estado pré-fábrica, gap C1/G2)", () => {
    const body = lastAddConstraintBody(/ADD CONSTRAINT products_lifecycle_status_check[\s\S]*?\)\s*\)/g);
    expect(body, "nenhuma migration define products_lifecycle_status_check").not.toBe("");
    expect(body).toContain("'draft'");
  });

  // 065 reconstrói payments_method_check para adicionar 'credit' (pagamento de crédito interno).
  // Guarda contra o gap G5: a reconstrução deve preservar TODOS os métodos prévios (054:66) + 'credit'.
  it("payments_method_check aceita 'credit' e todos os métodos prévios (065)", () => {
    const body = lastAddConstraintBody(/ADD CONSTRAINT payments_method_check[\s\S]*?\)\s*\)/g);
    expect(body, "nenhuma migration define payments_method_check").not.toBe("");
    for (const m of ["'pix'", "'boleto'", "'card'", "'transfer'", "'cash'", "'manual'", "'credit'"]) {
      expect(body, `payments_method_check perdeu ${m}`).toContain(m);
    }
  });

  // 065 reconstrói finance_audit_entity_type_check para adicionar 'credit_ledger'. Deve preservar
  // 'tenant' (055) e todos os anteriores — o consumo/concessão audita entity_type='credit_ledger'.
  it("finance_audit_entity_type_check aceita 'credit_ledger' e 'tenant' + prévios (065)", () => {
    const body = lastAddConstraintBody(/ADD CONSTRAINT finance_audit_entity_type_check[\s\S]*?\)\s*\)/g);
    expect(body, "nenhuma migration define finance_audit_entity_type_check").not.toBe("");
    for (const e of ["'charge'", "'payment'", "'bank_account'", "'invoice'", "'tenant'", "'credit_ledger'"]) {
      expect(body, `finance_audit_entity_type_check perdeu ${e}`).toContain(e);
    }
  });
});
