/**
 * 🔴 GAP-128 — evidência que decide não é cortada em silêncio.
 *
 * Estes testes fixam a LEI, não a formatação: (1) o corte NUNCA passa do teto; (2) quando morde, o
 * texto diz que mordeu e quanto ficou de fora; (3) quando não morde, não suja o prompt com aviso.
 */
import { describe, it, expect } from "vitest";
import { cutEvidence, wouldCut } from "./evidenceCut.js";
import { parseStageBFindings, STAGE_B_RATIONALE_MAX } from "./specValidation.js";

describe("🔴 GAP-128 — cutEvidence", () => {
  it("texto dentro do teto passa INTACTO e sem aviso", () => {
    const t = "O endpoint não declara o código de erro 409.";
    expect(cutEvidence(t, 400)).toBe(t);
    expect(cutEvidence(t, 400)).not.toContain("CORTADO");
    expect(wouldCut(t, 400)).toBe(false);
  });

  it("nulo/vazio devolve string vazia (nada de 'undefined' no prompt)", () => {
    expect(cutEvidence(null, 100)).toBe("");
    expect(cutEvidence(undefined, 100)).toBe("");
  });

  it("quando corta, DECLARA o corte, respeita o teto e diz o total original", () => {
    const total = 1500;
    const t = "a".repeat(total);
    const out = cutEvidence(t, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("CORTADO");
    expect(out).toContain("o fato CONTINUA");
    expect(out).toContain(String(total));
    expect(wouldCut(t, 400)).toBe(true);
  });

  it("não termina no meio de uma palavra quando há fronteira perto do teto", () => {
    // 60 palavras de 9 chars: a fronteira de palavra cai bem depois de 60% do teto.
    const t = Array.from({ length: 60 }, (_, i) => `tenant_i${i % 10}`).join(" ");
    const out = cutEvidence(t, 200);
    const antesDaMarca = out.split(" …⟨")[0];
    expect(antesDaMarca.endsWith("_")).toBe(false);
    // O trecho preservado tem de ser prefixo REAL do original — corte é transporte, não reescrita.
    expect(t.startsWith(antesDaMarca)).toBe(true);
  });

  it("teto tão pequeno que não cabe a marca: vence o AVISO, não um trecho que se diz completo", () => {
    const out = cutEvidence("x".repeat(500), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).not.toBe("xxxxxxxxxx");
  });
});

describe("🔴 GAP-128 — ingestão do estágio B", () => {
  it("o teto de ingestão subiu de 1.200 para 4.000 (a coluna é JSONB, não havia limite de banco)", () => {
    expect(STAGE_B_RATIONALE_MAX).toBe(4000);
  });

  it("rationale de 2.000 chars (que o teto antigo cortava) chega INTEIRO e sem marca", () => {
    const rationale = "b".repeat(2000);
    const [f] = parseStageBFindings([{ file: "a.md", severity: "blocker", title: "t", rationale }]);
    expect(f.rationale).toBe(rationale);
    expect(f.rationale).not.toContain("CORTADO");
  });

  it("rationale acima do teto novo é cortado COM declaração", () => {
    const [f] = parseStageBFindings([{ file: "a.md", severity: "warning", title: "t", rationale: "c".repeat(5000) }]);
    expect(f.rationale.length).toBeLessThanOrEqual(STAGE_B_RATIONALE_MAX);
    expect(f.rationale).toContain("CORTADO");
    expect(f.rationale).toContain("5000");
  });

  it("título derivado do rationale (GAP-50) não herda a marca de corte", () => {
    const rationale = `${"d".repeat(4200)}. Segunda frase.`;
    const [f] = parseStageBFindings([{ file: "a.md", severity: "info", rationale }]);
    expect(f.title).not.toContain("CORTADO");
    expect(f.title.length).toBeLessThanOrEqual(200);
  });
});
