/**
 * specValidation.test.ts — RFC-0004 Onda 3: estágio A, schema do B e regras do gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runStageA, parseStageBFindings, checkSpecValidationGate, specValidationGateEnabled } from "./specValidation.js";

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
