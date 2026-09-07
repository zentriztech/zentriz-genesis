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
  it("segundo separador dentro do REPLACE: bloco RECUSADO, nada de `=======` no arquivo", () => {
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
    // GAP-65 mudou o MECANISMO da recusa (o separador passou a ser o ÚLTIMO do bloco, então este
    // bloco vira "âncora que não existe" em vez de "bloco malformado"). A INVARIANTE é a mesma e é
    // ela que este teste protege: nada de marcador no arquivo e o bloco são continua valendo.
    expect(r.applied).toBe(1);
    expect(r.skipped.map((s) => s.code)).toEqual(["SEARCH_NOT_FOUND"]);
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

/**
 * GAP-65 — a corrupção de marcador que JÁ está no disco tem de poder SAIR.
 *
 * Medido em prod 2026-09-07 (`modelo-dados.md` do NVX LastMile, 216.524 chars): o arquivo tem 4
 * linhas `=======` e linhas de tabela duplicadas, resíduo do defeito que o GAP-9 fechou. O GAP-9
 * impede gravar marcador NOVO, mas não removia o antigo: para apagar a linha `=======` o agente
 * precisa copiá-la dentro do SEARCH, e o parser lia essa linha como o separador do bloco — a
 * resposta correta do CTO virava `NO_BLOCKS` e a rodada falhava inteira. Resultado: um blocker
 * ("bloco de convenções corrompido com marcadores de merge") que o juiz reencontra em TODA validação
 * e que era impossível de fechar — e o CTO passou a escrever prosa dizendo que o marcador é
 * "resíduo nulo" em vez de removê-lo, porque remover não era possível.
 *
 * A partir daqui o separador é o ÚLTIMO marcador do bloco. Isso libera a âncora sem abrir espaço
 * para corrupção nova, e a razão é estrutural: o lado REPLACE passa a ser, por construção, o texto
 * DEPOIS do último marcador (nunca contém marcador), e um SEARCH com `=======` só casa se o arquivo
 * REALMENTE tiver aquela linha. Ou seja: só é possível remover corrupção existente, nunca criá-la.
 */
describe("GAP-65 — remover marcador de conflito que já está no arquivo", () => {
  const CORROMPIDO = [
    "## Convenções gerais",
    "",
    "| Convenção | Regra |",
    "|-----------|-------|",
    "| Enums | `VARCHAR(n)` + `CHECK`. |",
    "=======",
    "| Normalização de email | `lower(trim(email))` (RN-06). |",
    "=======",
    "| Normalização de email | `lower(trim(email))` (RN-06). |",
    "",
    "## Próxima seção",
    "",
  ].join("\n");

  it("o SEARCH PODE conter as linhas `=======` do arquivo — é o único jeito de apagá-las", () => {
    const raw = [
      "<<<<<<< SEARCH",
      "| Enums | `VARCHAR(n)` + `CHECK`. |",
      "=======",
      "| Normalização de email | `lower(trim(email))` (RN-06). |",
      "=======",
      "| Normalização de email | `lower(trim(email))` (RN-06). |",
      "=======",
      "| Enums | `VARCHAR(n)` + `CHECK`. |",
      "| Normalização de email | `lower(trim(email))` (RN-06). |",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = applySpecEditResponse(CORROMPIDO, raw, { minRatio: 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([]);
    // a corrupção SAIU do arquivo…
    expect(r.content).not.toContain("=======");
    // …e a linha antes duplicada ficou uma só
    expect(r.content.split("Normalização de email").length - 1).toBe(1);
    expect(r.content).toContain("## Próxima seção");
  });

  it("o parser divide no ÚLTIMO separador e conta quantos o bloco tinha", () => {
    const parsed = parseSpecEditBlocks([
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      "=======",
      "c",
      ">>>>>>> REPLACE",
    ].join("\n"));
    expect(parsed.dropped).toBe(0);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].search).toBe("a\n=======\nb");
    expect(parsed.blocks[0].replace).toBe("c");
    expect(parsed.blocks[0].separators).toBe(2);
  });

  it("bloco SEM separador nenhum continua sendo descartado (malformado)", () => {
    const parsed = parseSpecEditBlocks([
      "<<<<<<< SEARCH",
      "Os dados são retidos.",
      ">>>>>>> REPLACE",
      block("O titular pode solicitar exclusão.", "O titular pode solicitar exclusão em 15 dias."),
    ].join("\n"));
    expect(parsed.dropped).toBe(1);
    // …e o bloco seguinte NÃO é engolido pelo malformado
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].replace).toContain("em 15 dias");
  });

  it("âncora não encontrada num bloco com 2+ separadores DIZ que o separador é o último", () => {
    const raw = [
      "<<<<<<< SEARCH",
      "Os dados são retidos.",
      "=======",
      "=======",
      "Os dados são retidos por 5 anos.",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = applySpecEditResponse(BASE, raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SEARCH_NOT_FOUND");
    expect(r.message).toContain("2 linhas separadoras");
    expect(r.message).toContain("a divisão usa a ÚLTIMA delas");
  });

  it("o lado REPLACE nunca pode receber marcador vindo do parser (invariante estrutural)", () => {
    // Qualquer resposta parseada tem `replace` = texto DEPOIS do último marcador ⇒ sem marcador.
    for (const raw of [
      block("Os dados são retidos.", "x\n=======\ny"),
      "<<<<<<< SEARCH\na\n=======\nb\n=======\nc\n>>>>>>> REPLACE",
    ]) {
      for (const b of parseSpecEditBlocks(raw).blocks) {
        expect(b.replace.split("\n").some((l) => /^[=<>]{5,}/.test(l.trim()))).toBe(false);
      }
    }
  });
});
