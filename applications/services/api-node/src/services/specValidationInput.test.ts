/**
 * GAP-10 — o validador não pode ser levado a reportar como AUSENTE o que existe.
 *
 * Medido em prod (NVX LastMile, run `18111140`): spec de 12 arquivos / 747.170 chars entrava com
 * `slice(0, 200_000)` e voltou com 4 blockers fantasmas do tipo "9 dos 12 arquivos obrigatórios estão
 * ausentes". Cada teste aqui trava uma condição sem a qual o fantasma volta.
 */
import { describe, it, expect } from "vitest";
import { buildValidationInput, VALIDATION_INPUT_CAP } from "./specValidationInput.js";

const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;

function file(path: string, chars: number): { path: string; content: string } {
  const secs = [`# ${path}`, filler("intro", 40), "## 1. Regras", filler("regra", 40), "## 2. Contratos"];
  const head = secs.join("\n");
  const pad = "x".repeat(Math.max(0, chars - head.length));
  return { path, content: `${head}\n${pad}` };
}

describe("buildValidationInput", () => {
  it("spec que cabe: todos integrais, sem regras de recorte no prompt", () => {
    const inp = buildValidationInput([file("a.md", 1_000), file("b.md", 2_000)]);
    expect(inp.outlineOnly).toEqual([]);
    expect(inp.full).toEqual(["a.md", "b.md"]);
    expect(inp.text).toContain("INVENTÁRIO DA SPEC");
    expect(inp.text).not.toContain("REGRAS DESTA VALIDAÇÃO");
    expect(inp.text).toContain("===== a.md =====");
  });

  it("spec grande: o INVENTÁRIO lista TODOS os arquivos, inclusive os que não couberam integrais", () => {
    const files = [file("grande-1.md", 90_000), file("grande-2.md", 90_000), file("grande-3.md", 90_000)];
    const inp = buildValidationInput(files, 120_000);
    expect(inp.outlineOnly.length).toBeGreaterThan(0);
    for (const f of files) expect(inp.text).toContain(`\`${f.path}\``);
    expect(inp.totalChars).toBeGreaterThan(260_000);
  });

  it("o arquivo que não cabe é declarado EXISTENTE e proibido de ser reportado como ausente", () => {
    const inp = buildValidationInput([file("cabe.md", 500), file("nao-cabe.md", 90_000)], 20_000);
    expect(inp.outlineOnly).toContain("nao-cabe.md");
    expect(inp.text).toMatch(/SÓ SUMÁRIO \(arquivo EXISTE, 90\d{3} chars\)/);
    expect(inp.text).toContain("é PROIBIDO reportá-los como ausentes");
    expect(inp.text).toContain("truncados ou não entregues");
  });

  it("do arquivo cortado vai o SUMÁRIO de cabeçalhos (evidência de que a seção existe)", () => {
    const inp = buildValidationInput([file("nao-cabe.md", 90_000)], 20_000);
    expect(inp.text).toContain("## 1. Regras");
    expect(inp.text).toContain("## 2. Contratos");
    expect(inp.text).not.toContain("regra regra regra");
  });

  it("prioriza os MENORES para caber integrais — maximiza quantos arquivos são vistos por inteiro", () => {
    const inp = buildValidationInput(
      [file("gigante.md", 150_000), file("p1.md", 900), file("p2.md", 900), file("p3.md", 900)],
      20_000,
    );
    expect(inp.full.sort()).toEqual(["p1.md", "p2.md", "p3.md"]);
    expect(inp.outlineOnly).toEqual(["gigante.md"]);
  });

  it("o corpo sai na ordem de LEITURA original, não na ordem de tamanho", () => {
    const inp = buildValidationInput([file("z-ultimo.md", 800), file("a-primeiro.md", 900)], 20_000);
    expect(inp.text.indexOf("===== z-ultimo.md")).toBeLessThan(inp.text.indexOf("===== a-primeiro.md"));
  });

  it("respeita o teto (o defeito era justamente mandar mais do que a janela aceita)", () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.md`, 60_000));
    const inp = buildValidationInput(files);
    expect(inp.text.length).toBeLessThanOrEqual(VALIDATION_INPUT_CAP + 40);
    expect(inp.totalChars).toBeGreaterThan(700_000);
    expect(inp.text).toContain("INVENTÁRIO DA SPEC — 12 arquivo(s)");
  });
});
