/**
 * 🔴 GAP-146 — testes do CENSO DO PROMPT do lado da api.
 *
 * O instrumento existe porque `spec_cto` custa 69.548 tokens de ENTRADA por chamada (764 chamadas /
 * 52,9 M tokens em 3 dias medidos em prod) e ninguém sabia de QUEM: o prompt por-arquivo é uma pilha
 * de ~15 blocos e o caminho dominante (`/invoke/raw`) monta o prompt AQUI, fora do censo do `agents`
 * — medido ao vivo: zero linhas `[prompt-census]` com o laço rodando CTO.
 *
 * Estes testes pinam o que faz o censo ser confiável, não o que ele imprime:
 *
 *   1. o censo FECHA (`soma(campos) + outros == total`) — sem isso, campo esquecido viraria "economia";
 *   2. `outros` NEGATIVO é denunciado, não escondido: negativo = contagem dupla no chamador;
 *   3. campo vazio não aparece (ruído ≠ fato) e a ordem é do maior para o menor;
 *   4. o censo não carrega conteúdo (vai para log; spec de cliente não vai);
 *   5. no PROMPT REAL do CTO por-arquivo `outros` é pequeno — é este teste que quebra quando alguém
 *      acrescenta um bloco grande ao prompt e esquece de somá-lo ao censo (o apodrecimento esperado).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordPromptCensus } from "./promptCensus.js";
import { buildGapFileRequest } from "../routes/specChat.js";
import type { ValidationFinding } from "./specValidation.js";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("recordPromptCensus", () => {
  it("fecha a conta: soma(campos) + outros == total", () => {
    const c = recordPromptCensus({
      origem: "t", role: "CTO", file: "a.md",
      total: 1_000, fields: { file_content: 600, gaps: 300 },
    });
    expect(c.fields).toEqual({ file_content: 600, gaps: 300 });
    expect(c.outros).toBe(100);
    expect(Object.values(c.fields).reduce((a, b) => a + b, 0) + c.outros).toBe(c.total);
  });

  it("denuncia contagem dupla em vez de esconder (outros negativo)", () => {
    const c = recordPromptCensus({ origem: "t", total: 100, fields: { a: 80, b: 80 } });
    expect(c.outros).toBe(-60);
    expect(logs.join("\n")).toContain("CONTAGEM-DUPLA");
  });

  it("omite campo vazio e ordena do maior para o menor", () => {
    const c = recordPromptCensus({
      origem: "t", total: 500, fields: { pequeno: 10, vazio: 0, grande: 400, negativo: -5 },
    });
    expect(Object.keys(c.fields)).toEqual(["grande", "pequeno"]);
  });

  it("não carrega conteúdo do prompt — só tamanhos", () => {
    const c = recordPromptCensus({ origem: "t", total: 10, fields: { file_content: 10 } });
    expect(JSON.stringify(c)).not.toContain("SEGREDO");
    expect(logs.join("\n")).toContain("[prompt-census] origem=t");
  });

  it("registra uma linha por censo, com role e arquivo", () => {
    recordPromptCensus({ origem: "api-gapfile", role: "CTO", file: "tecnico/dados.md", total: 7, fields: {} });
    const linha = logs.find((l) => l.includes("[prompt-census]")) ?? "";
    expect(linha).toContain("role=CTO");
    expect(linha).toContain("file=tecnico/dados.md");
    expect(linha).toContain("total=7c");
  });
});

// ── 5. o censo sobre o PROMPT REAL (guarda contra bloco novo não somado) ───────────────────────────

function finding(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    file: "tecnico/dados.md", line: 12, severity: "blocker",
    title: "Contradição de contrato", rationale: "422 aqui × 400 no irmão",
    source: "stage_b", category: "consistency", anchor: "§8.6",
    ...over,
  };
}

describe("censo do prompt REAL do CTO por-arquivo", () => {
  it("fecha a conta e `outros` fica em delimitadores (não em bloco esquecido)", () => {
    const content = "# Dados\n" + "linha de spec\n".repeat(300);
    buildGapFileRequest(
      content, "tecnico/dados.md", [finding(), finding({ title: "Outro" })],
      { siblingsBlock: "", findingsBlock: "", findings: [], derivedStatus: "validated",
        productMapBlock: "MAPA ".repeat(200), contextWarnings: [], emitV2: true },
      null,
      "IRMÃO ".repeat(100),   // siblingBlock
      false,
      "ORÁCULO ".repeat(50),  // oracleBlock
      "RECUSA ".repeat(30),   // priorRejectionBlock
      "PERSISTENTE ".repeat(20),
      "FOCO ".repeat(10),
      "DESFECHO ".repeat(15),
      "",                     // consolidationBlock (rodada normal)
      "",                     // indexBlock (não é o manifesto)
      "TENTATIVAS ".repeat(12),
    );
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).not.toBe("");
    const num = (k: string) => Number(new RegExp(`${k}=(-?\\d+)c`).exec(linha)?.[1] ?? NaN);
    // `outros` = delimitadores + rótulos + instrução final. Um bloco novo não somado apareceria aqui
    // como milhares de chars — e é exatamente isso que este teto pega.
    expect(num("outros")).toBeGreaterThan(0);
    expect(num("outros")).toBeLessThan(2_500);
    expect(num("file_content")).toBe(content.length);
    expect(num("total")).toBeGreaterThan(content.length);
  });

  it("mede o ENTREGUE: bloco ausente não aparece como despesa", () => {
    buildGapFileRequest("conteúdo curto", "tecnico/dados.md", [finding()]);
    const linha = logs.find((l) => l.includes("origem=api-gapfile")) ?? "";
    expect(linha).not.toContain("siblings=");
    expect(linha).not.toContain("product_map=");
    expect(linha).toContain("file_content=14c");
  });
});
