/**
 * specValidation.test.ts — RFC-0004 Onda 3: estágio A, schema do B e regras do gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runStageA, parseStageBFindings, checkSpecValidationGate, specValidationGateEnabled, autoValidateDirtySpecs, specValidationAutoEnabled } from "./specValidation.js";
import type { Pool } from "pg";

function file(filename: string, content: string, relDir = "") {
  return { filename, file_path: `/x/${filename}`, rel_dir: relDir, content };
}

const RICH = `## Spec real\n\n${"Requisito detalhado com critérios de aceite e modelo de dados. ".repeat(10)}`;

describe("estágio A (determinístico)", () => {
  it("spec legada SEM manifesto → warning, NUNCA blocker (leniência)", () => {
    const f = runStageA([file("spec.md", RICH)]);
    const manifesto = f.find((x) => x.title.includes("sem manifesto"));
    expect(manifesto?.severity).toBe("warning");
    expect(f.some((x) => x.severity === "blocker")).toBe(false);
  });

  it("arquétipo desconhecido no README → blocker", () => {
    const readme = file("README.md", "---\nkind: project\narchetype: inventado\n---\n\n# X");
    const f = runStageA([readme, file("01-spec.md", RICH)]);
    expect(f.find((x) => x.title.includes("Arquétipo desconhecido"))?.severity).toBe("blocker");
  });

  it("arquétipo válido → sem blocker; estado no frontmatter → warning", () => {
    const readme = file("README.md", "---\nkind: project\narchetype: backend-service\nspec_hash: abc\n---\n\n# X");
    const f = runStageA([readme, file("01-spec.md", RICH)]);
    expect(f.some((x) => x.severity === "blocker")).toBe(false);
    expect(f.find((x) => x.title.includes("ESTADO no frontmatter"))?.severity).toBe("warning");
  });

  it("spec vazia/trivial → blocker", () => {
    const f = runStageA([file("spec.md", "# oi")]);
    expect(f.find((x) => x.title.includes("sem conteúdo substantivo"))?.severity).toBe("blocker");
  });

  it("Evoluir E3: RFC vago em docs/rfc/ → blocker SÓ em evolução (produto novo: warning); nome fora do padrão idem", () => {
    const vague = file("RFC-0001-vago.md", "# RFC\n\n## Sumário\nFazer melhor.\n", "docs/rfc");
    const badName = file("rfc-1.md", "# RFC\n", "docs/rfc");
    const evo = runStageA([file("spec.md", RICH), vague, badName], { evolution: true });
    const rfcFindings = evo.filter((x) => x.file.startsWith("docs/rfc/"));
    expect(rfcFindings.length).toBeGreaterThanOrEqual(3);
    expect(rfcFindings.every((x) => x.severity === "blocker" || x.severity === "warning")).toBe(true);
    expect(rfcFindings.filter((x) => x.severity === "blocker").map((x) => x.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Gherkin/), expect.stringMatching(/files_allowed/), expect.stringMatching(/padrão de nome/),
    ]));
    const fresh = runStageA([file("spec.md", RICH), vague, badName]);
    expect(fresh.filter((x) => x.file.startsWith("docs/rfc/")).every((x) => x.severity === "warning")).toBe(true);
    // RFC completo em evolução → sem blocker de RFC
    const good = file("RFC-0002-ok.md", "# RFC\n\n## Critérios de aceite\n- Dado x\n- Quando y\n- Então z\n\n## Impacto\n- `apps/api/src/a.ts`\n\n## Compatibilidade\nMINOR\n\n**Não-objetivos:** nada.\n", "docs/rfc");
    expect(runStageA([file("spec.md", RICH), good], { evolution: true }).filter((x) => x.file.startsWith("docs/rfc/") && x.severity === "blocker")).toEqual([]);
  });
});

describe("parseStageBFindings (schema fechado — saída de LLM nunca entra crua)", () => {
  it("normaliza severidade inválida para info e trunca campos", () => {
    const out = parseStageBFindings([
      { file: "a".repeat(500), line: "3", severity: "CRITICAL!!", title: "t".repeat(500), rationale: "r" },
    ]);
    expect(out[0].severity).toBe("info");
    expect(out[0].file.length).toBe(300);
    expect(out[0].title.length).toBe(200);
    expect(out[0].line).toBe(3);
    expect(out[0].source).toBe("stage_b");
  });
  it("não-array → []; cap de 50 itens", () => {
    expect(parseStageBFindings({ hack: true })).toEqual([]);
    expect(parseStageBFindings(Array.from({ length: 80 }, () => ({}))).length).toBe(50);
  });
});

describe("checkSpecValidationGate — regras (com db fake)", () => {
  const PROJ = "p1";
  type Row = Record<string, unknown>;
  function db(rows: { files?: Row[]; run?: Row | null }) {
    return {
      query: async (sql: string) => {
        if (sql.includes("FROM project_spec_files")) return { rows: rows.files ?? [] };
        if (sql.includes("FROM spec_validation_runs")) return { rows: rows.run ? [rows.run] : [] };
        return { rows: [] };
      },
    };
  }

  beforeEach(() => { process.env.SPEC_VALIDATION_GATE = "on"; });
  afterEach(() => { delete process.env.SPEC_VALIDATION_GATE; });

  it("env OFF (default) → sempre passa (byte-idêntico ao legado)", async () => {
    delete process.env.SPEC_VALIDATION_GATE;
    expect(specValidationGateEnabled()).toBe(false);
    const r = await checkSpecValidationGate(db({}), PROJ);
    expect(r.ok).toBe(true);
  });

  it("ON + sem arquivos → SPEC_FILES_MISSING", async () => {
    const r = await checkSpecValidationGate(db({ files: [] }), PROJ);
    expect(r).toMatchObject({ ok: false, code: "SPEC_FILES_MISSING" });
  });

  // Nota: os caminhos com arquivos reais exigem disco (computeCurrentSpecHash lê bytes) —
  // cobertos pela bateria E2E viva da onda. Aqui validamos a matriz de decisão da run
  // via os casos alcançáveis com o fake.
});

describe("autoValidateDirtySpecs — tick env-gated (RFC-0004 Onda 3, D1)", () => {
  afterEach(() => { delete process.env.SPEC_VALIDATION_AUTO; });

  // fake pool que grava as queries; SELECT de projetos sujos devolve `dirtyRows`,
  // FROM project_spec_files devolve [] (→ startValidation para em SPEC_FILES_MISSING).
  function db(dirtyRows: Array<{ id: string; tenant_id: string | null }>) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM projects") && sql.includes("spec_dirty_at IS NOT NULL")) return { rows: dirtyRows };
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, queries };
  }

  it("flag off (default) → no-op, não consulta o banco", async () => {
    delete process.env.SPEC_VALIDATION_AUTO;
    expect(specValidationAutoEnabled()).toBe(false);
    const { pool, queries } = db([{ id: "p1", tenant_id: null }]);
    await autoValidateDirtySpecs(pool);
    expect(queries).toHaveLength(0);
  });

  it("flag on → limpa spec_dirty_at ANTES de disparar (não vira loop por ciclo)", async () => {
    process.env.SPEC_VALIDATION_AUTO = "on";
    expect(specValidationAutoEnabled()).toBe(true);
    const { pool, queries } = db([{ id: "proj-dirty-1", tenant_id: null }]);
    await autoValidateDirtySpecs(pool);
    // 1ª query: SELECT dos sujos; 2ª: UPDATE ... spec_dirty_at = NULL para o projeto.
    expect(queries[0].sql).toContain("spec_dirty_at IS NOT NULL");
    const clear = queries.find((q) => q.sql.includes("spec_dirty_at = NULL") && (q.params as unknown[])[0] === "proj-dirty-1");
    expect(clear).toBeTruthy();
  });

  it("flag on + nenhum sujo → só o SELECT, sem UPDATE de limpeza", async () => {
    process.env.SPEC_VALIDATION_AUTO = "on";
    const { pool, queries } = db([]);
    await autoValidateDirtySpecs(pool);
    expect(queries.some((q) => q.sql.includes("spec_dirty_at = NULL"))).toBe(false);
  });
});
