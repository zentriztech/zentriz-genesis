/**
 * 🔴 GAP-122 — arquivo novo da spec não entrava no índice do `README.md` (nem quando o chat reescreveu o
 * README depois). Estes testes fixam os limites da MEDIÇÃO, que é o que vai virar cobrança ao agente:
 * ela pode subnotificar, mas não pode inventar órfão.
 */
import { describe, it, expect } from "vitest";
import {
  unindexedFiles, indexCoverageFactBlock, indexCoverageValidationFact,
} from "./specIndexCoverage.js";

const TREE = ["README.md", "visao-escopo.md", "modelo-dados.md", "docs/arquitetura-modelo.md"];

describe("unindexedFiles (GAP-122)", () => {
  it("aponta só o arquivo que o README não cita de forma nenhuma", () => {
    const readme = "# Projeto\n\n- [Visão](visao-escopo.md)\n- [Dados](modelo-dados.md)\n";
    expect(unindexedFiles(readme, TREE)).toEqual(["docs/arquitetura-modelo.md"]);
  });

  it("citação pelo NOME do arquivo já conta como indexado — a medição subnotifica de propósito", () => {
    const readme = "O modelo de arquitetura vive em `arquitetura-modelo.md`.\nvisao-escopo.md\nmodelo-dados.md";
    expect(unindexedFiles(readme, TREE)).toEqual([]);
  });

  it("o próprio README nunca é órfão de si mesmo", () => {
    expect(unindexedFiles("nada aqui", ["README.md"])).toEqual([]);
  });

  it("README vazio (manifesto ainda não criado) não acusa a spec inteira", () => {
    expect(unindexedFiles("", TREE)).toEqual([]);
    expect(unindexedFiles("   ", TREE)).toEqual([]);
  });

  it("caixa e caminho: `Docs/Arquitetura-Modelo.md` no texto conta para `docs/arquitetura-modelo.md`", () => {
    expect(unindexedFiles("veja Docs/Arquitetura-Modelo.md", TREE))
      .toEqual(["visao-escopo.md", "modelo-dados.md"]);
  });
});

describe("indexCoverageFactBlock (GAP-122)", () => {
  it("entrega a árvore medida e PEDE a indexação do que ficou fora, sem ditar o formato", () => {
    const b = indexCoverageFactBlock(TREE, ["docs/arquitetura-modelo.md"]);
    expect(b).toContain("FATOS DO ÍNDICE");
    expect(b).toContain("3 arquivo(s)");           // não conta o próprio README
    expect(b).toContain("docs/arquitetura-modelo.md");
    expect(b).toContain("Indexe-os nesta edição");
    expect(b).not.toContain("README.md`\n");        // o manifesto não se lista na própria árvore
  });

  it("sem órfão, o bloco diz o que foi medido e proíbe mexer no índice sem motivo", () => {
    const b = indexCoverageFactBlock(TREE, []);
    expect(b).toContain("todos os arquivos acima são citados");
    expect(b).not.toContain("Indexe-os");
  });

  it("árvore vazia devolve vazio (nada medido, nada afirmado)", () => {
    expect(indexCoverageFactBlock([], [])).toBe("");
  });
});

describe("indexCoverageValidationFact (GAP-122)", () => {
  it("dá o FATO ao juiz sem veredicto — quem decide severidade é ele", () => {
    const fact = indexCoverageValidationFact([
      { path: "README.md", content: "# P\n- [Visão](visao-escopo.md)" },
      { path: "visao-escopo.md", content: "x" },
      { path: "docs/arquitetura-modelo.md", content: "y" },
    ]);
    expect(fact).toContain("MEDIDO PELO SISTEMA");
    expect(fact).toContain("docs/arquitetura-modelo.md");
    expect(fact).toContain("julgue você");
    expect(fact).not.toMatch(/BLOCKER|blocker/);
  });

  it("sem manifesto entre os arquivos não há índice contra o que medir", () => {
    expect(indexCoverageValidationFact([{ path: "visao-escopo.md", content: "x" }])).toBe("");
  });

  it("índice completo não gasta uma linha do inventário", () => {
    expect(indexCoverageValidationFact([
      { path: "README.md", content: "visao-escopo.md" },
      { path: "visao-escopo.md", content: "x" },
    ])).toBe("");
  });
});
