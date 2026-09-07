import { describe, it, expect } from "vitest";
import {
  applySpecEditBlocks, applySpecEditResponse, looksLikeEdits, parseSpecEditBlocks,
} from "./specFileEdits.js";

const BASE = [
  "# Privacidade e LGPD",
  "",
  "## 1. Bases legais",
  "",
  "O tratamento ocorre com base no consentimento.",
  "",
  "## 2. Retenção",
  "",
  "Os dados são retidos.",
  "",
  "## 3. Direitos do titular",
  "",
  "O titular pode solicitar exclusão.",
  "",
].join("\n");

function block(search: string, replace: string): string {
  return ["<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n");
}

describe("parseSpecEditBlocks", () => {
  it("parseia múltiplos blocos e devolve a prosa separada", () => {
    const raw = [
      "Corrigi os dois GAPs de retenção.",
      block("Os dados são retidos.", "Os dados são retidos por 5 anos (art. 16, LGPD)."),
      block("O titular pode solicitar exclusão.", "O titular pode solicitar exclusão em até 15 dias (`DELETE /subjects/:id`)."),
    ].join("\n");
    const r = parseSpecEditBlocks(raw);
    expect(r.blocks).toHaveLength(2);
    expect(r.dropped).toBe(0);
    expect(r.blocks[0].replace).toContain("5 anos");
    expect(r.prose).toContain("Corrigi os dois GAPs");
  });

  it("conta como DESCARTADO o bloco cortado no meio (resposta truncada) sem perder os anteriores", () => {
    const raw = [
      block("Os dados são retidos.", "Os dados são retidos por 5 anos."),
      "<<<<<<< SEARCH",
      "O titular pode solicitar exclusão.",
      "=======",
      "O titular pode solicitar exclusão em at",
    ].join("\n");
    const r = parseSpecEditBlocks(raw);
    expect(r.blocks).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });

  it("não confunde marcadores de blocos vizinhos (um SEARCH novo fecha o anterior como descartado)", () => {
    const raw = ["<<<<<<< SEARCH", "trecho A", "<<<<<<< SEARCH", "trecho B", "=======", "novo B", ">>>>>>> REPLACE"].join("\n");
    const r = parseSpecEditBlocks(raw);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].search).toBe("trecho B");
    expect(r.dropped).toBe(1);
  });

  it("looksLikeEdits distingue edições de um arquivo inteiro", () => {
    expect(looksLikeEdits(BASE)).toBe(false);
    expect(looksLikeEdits(block("a", "b"))).toBe(true);
  });
});

describe("applySpecEditBlocks", () => {
  it("aplica as edições em ordem preservando o resto do arquivo", () => {
    const r = applySpecEditBlocks(BASE, [
      { search: "Os dados são retidos.", replace: "Os dados são retidos por 5 anos." },
      { search: "O titular pode solicitar exclusão.", replace: "O titular pode solicitar exclusão em 15 dias." },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(2);
    expect(r.content).toContain("## 1. Bases legais");
    expect(r.content).toContain("por 5 anos");
    expect(r.content).toContain("em 15 dias");
    // Nada além dos trechos pedidos mudou.
    expect(r.content).toContain("O tratamento ocorre com base no consentimento.");
  });

  it("ACRESCENTA conteúdo repetindo a âncora no replace", () => {
    const r = applySpecEditBlocks(BASE, [{
      search: "## 2. Retenção",
      replace: "## 2. Retenção\n\n### 2.1 Prazos por categoria\n\n| Categoria | Prazo |\n|---|---|\n| Cadastro | 5 anos |",
    }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("2.1 Prazos por categoria");
    expect(r.content.length).toBeGreaterThan(BASE.length);
  });

  it("recusa quando a âncora não existe (nada é aplicado)", () => {
    const r = applySpecEditBlocks(BASE, [{ search: "Seção que nunca existiu", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SEARCH_NOT_FOUND");
    expect(r.message).toContain("Seção que nunca existiu");
  });

  it("recusa âncora AMBÍGUA (2+ ocorrências) em vez de adivinhar o lugar", () => {
    const dup = "linha repetida\noutra coisa\nlinha repetida\n";
    const r = applySpecEditBlocks(dup, [{ search: "linha repetida", replace: "corrigida" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SEARCH_AMBIGUOUS");
  });

  it("recusa SEARCH vazio", () => {
    const r = applySpecEditBlocks(BASE, [{ search: "   ", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("EMPTY_SEARCH");
  });

  it("recusa lista vazia de blocos", () => {
    const r = applySpecEditBlocks(BASE, []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NO_BLOCKS");
  });

  it("recusa edição que ESVAZIA o arquivo (guarda de encolhimento)", () => {
    const r = applySpecEditBlocks(BASE, [{ search: BASE.trim(), replace: "# Privacidade" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SHRUNK");
  });

  it("tolera APENAS espaço no fim das linhas (o resto é veto)", () => {
    const base = "## Retenção\nOs dados são retidos.   \n";
    const r = applySpecEditBlocks(base, [{ search: "Os dados são retidos.", replace: "Os dados são retidos por 5 anos." }]);
    expect(r.ok).toBe(true);
    const r2 = applySpecEditBlocks(base, [{ search: "os dados sao retidos.", replace: "x" }]);
    expect(r2.ok).toBe(false);
  });

  it("a segunda edição vê o texto já editado pela primeira", () => {
    const r = applySpecEditBlocks("A\nB\n", [
      { search: "A", replace: "A1" },
      { search: "A1\nB", replace: "A1\nB1" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("A1\nB1\n");
  });
});

describe("applySpecEditResponse (o caminho que o job usa)", () => {
  it("aplica os blocos completos de uma resposta CORTADA e informa o descarte", () => {
    const raw = [
      block("Os dados são retidos.", "Os dados são retidos por 5 anos (art. 16, LGPD)."),
      "<<<<<<< SEARCH",
      "O titular pode solicitar exclusão.",
      "=======",
      "O titular pode solicitar exclus",
    ].join("\n");
    const r = applySpecEditResponse(BASE, raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.dropped).toBe(1);
    expect(r.content).toContain("art. 16, LGPD");
    // O bloco cortado NÃO deixa resíduo no arquivo.
    expect(r.content).not.toContain("solicitar exclus\n");
    expect(r.content).toContain("O titular pode solicitar exclusão.");
  });

  /**
   * GAP-9 — o marcador de conflito que FOI gravado numa spec de produção.
   *
   * `modelo-dados.md` (NVX LastMile) ficou com uma linha `=======` no meio de uma tabela de
   * convenções e com a linha substituída DUPLICADA, enquanto o log dizia "16 aplicadas, 0
   * descartadas". Causa: um segundo separador dentro do lado REPLACE era engolido como CONTEÚDO.
   */
  it("segundo separador dentro do REPLACE: bloco DESCARTADO, nada de `=======` no arquivo", () => {
    const raw = [
      "<<<<<<< SEARCH",
      "Os dados são retidos.",
      "=======",
      "=======",
      "Os dados são retidos por 5 anos.",
      ">>>>>>> REPLACE",
      block("O titular pode solicitar exclusão.", "O titular pode solicitar exclusão em 15 dias."),
    ].join("\n");
    const r = applySpecEditResponse(BASE, raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.dropped).toBe(1);
    // o bloco malformado não entrou…
    expect(r.content).not.toContain("=======");
    expect(r.content).toContain("Os dados são retidos.");
    // …e o bloco são da mesma resposta continua valendo (descarte é por BLOCO, não por rodada).
    expect(r.content).toContain("em 15 dias");
  });

  it("bloco montado à mão com marcador no REPLACE é VETADO (invariante, não só do parser)", () => {
    const r = applySpecEditBlocks(BASE, [
      { search: "Os dados são retidos.", replace: "Título\n=======\nOs dados são retidos." },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("MARKER_IN_REPLACE");
    expect(r.message).toContain("conflito de merge");
  });

  it("normaliza CRLF dos dois lados", () => {
    const base = "## Retenção\r\nOs dados são retidos.\r\n";
    const raw = block("Os dados são retidos.", "Os dados são retidos por 5 anos.").replace(/\n/g, "\r\n");
    const r = applySpecEditResponse(base, raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("por 5 anos");
    expect(r.content).not.toContain("\r");
  });
});

// ── GAP-26: um bloco imprestável não derruba a rodada ─────────────────────────
//
// Medido em prod (run 875b2324, `observabilidade-operacao.md` de 69.598 chars): uma chamada de Opus 5
// inteira perdida por `Edição 20: o trecho a substituir não existe` — as 19 ancoradas foram embora
// junto. Cada bloco é autocontido; a política de truncamento deste módulo já dizia isso.
describe("GAP-26 — veto POR BLOCO", () => {
  it("âncora inexistente recusa SÓ o bloco ruim e aplica os bons", () => {
    const raw = [
      block("Os dados são retidos.", "Os dados são retidos por 5 anos."),
      block("Uma frase que nunca existiu neste arquivo.", "qualquer coisa"),
      block("O titular pode solicitar exclusão.", "O titular pode solicitar exclusão em 15 dias."),
    ].join("\n");
    const r = applySpecEditResponse(BASE, raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].code).toBe("SEARCH_NOT_FOUND");
    expect(r.skipped[0].index).toBe(1);
    expect(r.content).toContain("por 5 anos");
    expect(r.content).toContain("em 15 dias");
  });

  it("âncora AMBÍGUA também é recusada só nela (não se adivinha qual era)", () => {
    const base = "linha repetida\ntexto\nlinha repetida\n## Fim\nOs dados são retidos.\n";
    const raw = [
      block("linha repetida", "outra coisa"),
      block("Os dados são retidos.", "Os dados são retidos por 5 anos."),
    ].join("\n");
    const r = applySpecEditResponse(base, raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.skipped[0].code).toBe("SEARCH_AMBIGUOUS");
    expect(r.content).toContain("por 5 anos");
    // O bloco ambíguo NÃO foi aplicado em lugar nenhum.
    expect(r.content).not.toContain("outra coisa");
  });

  it("marcador no REPLACE é recusado só nele — a spec não recebe conflito de merge", () => {
    const r = applySpecEditBlocks(BASE, [
      { search: "Os dados são retidos.", replace: "Título\n=======\ntexto" },
      { search: "O titular pode solicitar exclusão.", replace: "O titular pode solicitar exclusão em 15 dias." },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.content).not.toContain("=======");
  });

  it("NENHUM bloco aplicável → a rodada falha com o motivo do primeiro (comportamento anterior)", () => {
    const raw = [
      block("não existe A", "x"),
      block("não existe B", "y"),
    ].join("\n");
    const r = applySpecEditResponse(BASE, raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SEARCH_NOT_FOUND");
    expect(r.message).toContain("Edição 1");
  });

  it("SHRUNK continua FATAL: o veto fala do RESULTADO, não de um bloco", () => {
    const r = applySpecEditBlocks(BASE, [
      { search: BASE.slice(0, Math.floor(BASE.length * 0.8)), replace: "" },
      { search: "não existe", replace: "x" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SHRUNK");
  });

  it("tudo aplicado → `skipped` vazio (nada a declarar)", () => {
    const r = applySpecEditResponse(BASE, block("Os dados são retidos.", "Os dados são retidos por 5 anos."));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toEqual([]);
  });
});
