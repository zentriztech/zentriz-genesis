/**
 * 🔴 GAP-128 — evidência que decide não é cortada em silêncio.
 *
 * Estes testes fixam a LEI, não a formatação: (1) o corte NUNCA passa do teto; (2) quando morde, o
 * texto diz que mordeu e quanto ficou de fora; (3) quando não morde, não suja o prompt com aviso.
 */
import { describe, it, expect } from "vitest";
import { cutEvidence, cutList, listCutMarker, wouldCut } from "./evidenceCut.js";
import { parseStageBFindings, parseStageBFindingsWithDrop, STAGE_B_RATIONALE_MAX, STAGE_B_MAX_FINDINGS } from "./specValidation.js";
import { readStageBCoverage } from "./specAutonomy.js";

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

/**
 * 🔴 GAP-129 — a LISTA do juiz também era cortada em silêncio (teto de ingestão por lote).
 *
 * Medido em prod: 2 validações com EXATAMENTE 50 findings — o teto antigo — enquanto vizinhas tinham
 * 52/55/58. Descarte na entrada faz a contagem de GAPs mentir PARA BAIXO: parece que fechou.
 */
describe("🔴 GAP-129 — descarte de achados no teto de ingestão da lista", () => {
  it("o teto por lote subiu de 50 para 120", () => {
    expect(STAGE_B_MAX_FINDINGS).toBe(120);
  });

  it("lista dentro do teto: nada descartado", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ file: "a.md", severity: "warning", title: `t${i}`, rationale: "r" }));
    const { findings, dropped } = parseStageBFindingsWithDrop(raw);
    expect(findings.length).toBe(60);
    expect(dropped).toBe(0);
  });

  it("lista acima do teto: o excedente é CONTADO, não desaparece", () => {
    const raw = Array.from({ length: 135 }, (_, i) => ({ file: "a.md", severity: "blocker", title: `t${i}`, rationale: "r" }));
    const { findings, dropped } = parseStageBFindingsWithDrop(raw);
    expect(findings.length).toBe(STAGE_B_MAX_FINDINGS);
    expect(dropped).toBe(15);
  });

  it("`parseStageBFindings` segue com o MESMO contrato (só a lista) para quem já a usava", () => {
    const raw = [{ file: "a.md", severity: "info", title: "t", rationale: "r" }];
    expect(parseStageBFindings(raw)).toEqual(parseStageBFindingsWithDrop(raw).findings);
  });

  it("entrada que não é lista não inventa descarte", () => {
    expect(parseStageBFindingsWithDrop(null)).toEqual({ findings: [], dropped: 0 });
    expect(parseStageBFindingsWithDrop({ findings: [] })).toEqual({ findings: [], dropped: 0 });
  });
});

describe("🔴 GAP-129 — o laço LÊ o descarte na cobertura", () => {
  it("cobertura com `droppedFindings` é transportada; sem ele, o campo não aparece", () => {
    const com = readStageBCoverage({ full: ["a.md"], outlineOnly: [], oversized: [], droppedFindings: 7 });
    expect(com?.droppedFindings).toBe(7);
    const sem = readStageBCoverage({ full: ["a.md"], outlineOnly: [], oversized: [] });
    expect(sem?.droppedFindings).toBeUndefined();
  });

  it("descarte zero ou inválido não vira descarte (não invento medição)", () => {
    expect(readStageBCoverage({ full: ["a.md"], outlineOnly: [], droppedFindings: 0 })?.droppedFindings).toBeUndefined();
    expect(readStageBCoverage({ full: ["a.md"], outlineOnly: [], droppedFindings: "muitos" })?.droppedFindings).toBeUndefined();
  });
});

/**
 * 🔴 GAP-130 — o mesmo defeito em mais 4 sítios, MEDIDOS em prod (2026-09-09):
 *  - casador do gold set: 1 defeito com `mutated` de 407 chars cortado em 400 (justo na cauda, onde o
 *    defeito injetado mora) e **60,5% (1.462 de 2.417)** dos `rationale` acima de 600 chars ⇒ o recall
 *    MEDIDO do juiz saía deprimido por corte, não por cegueira do juiz;
 *  - oráculo: "Prova (verbatim da saída)" cortada em 800 (nenhum finding `oracle` em prod ainda ⇒
 *    conserto por lei, sem dano medido);
 *  - gate semântico: lista `missing` cortada em 8;
 *  - triagem em lote: excedente de 200 fingerprints descartado com resposta 200 OK.
 */
describe("🔴 GAP-130 — corte de LISTA declarado (cutList/listCutMarker)", () => {
  it("lista dentro do teto: nada cortado e nada a declarar", () => {
    const { kept, dropped } = cutList(["a", "b", "c"], 8);
    expect(kept).toEqual(["a", "b", "c"]);
    expect(dropped).toBe(0);
  });

  it("lista acima do teto: mantém o teto e CONTA o excedente", () => {
    const itens = Array.from({ length: 12 }, (_, i) => i);
    const { kept, dropped } = cutList(itens, 8);
    expect(kept.length).toBe(8);
    expect(kept).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dropped).toBe(4);
  });

  it("entrada nula/não-lista não inventa itens nem corte", () => {
    expect(cutList(null, 5)).toEqual({ kept: [], dropped: 0 });
    expect(cutList(undefined, 5)).toEqual({ kept: [], dropped: 0 });
  });

  it("teto zero/negativo não devolve item algum (mas conta tudo como cortado)", () => {
    expect(cutList(["a", "b"], 0)).toEqual({ kept: [], dropped: 2 });
    expect(cutList(["a", "b"], -3)).toEqual({ kept: [], dropped: 2 });
  });

  it("a marca de lista diz quantos ficaram e quantos eram", () => {
    const m = listCutMarker(8, 12);
    expect(m).toContain("8");
    expect(m).toContain("12");
    expect(m).toContain("CORTADO");
    expect(m).toContain("itens");
  });
});

describe("🔴 GAP-130 — casador do gold set não recebe corte mudo", () => {
  it("defeito injetado e justificativa do juiz declaram o corte quando ele morde", async () => {
    const { matchUserMessage, GOLD_TEXT_MAX, MATCH_RATIONALE_MAX } = await import("./specJudgeRecall.js");
    // O teto do texto do defeito subiu para 1.200: 407 chars (o caso medido em prod) passa INTEIRO.
    const medidoEmProd = "m".repeat(407);
    const enorme = "M".repeat(GOLD_TEXT_MAX + 500);
    const msg = matchUserMessage(
      [
        { id: "d1", file: "a.md", anchor: "§1", defectClass: "contradicao", description: "x", original: "o".repeat(50), mutated: medidoEmProd, scope: "local" },
        { id: "d2", file: "b.md", anchor: "§2", defectClass: "omissao", description: "y", original: "o", mutated: enorme, scope: "local" },
      ] as never,
      [{ file: "a.md", line: null, severity: "blocker", title: "t", rationale: "r".repeat(MATCH_RATIONALE_MAX + 300), source: "judge" }] as never,
    );
    expect(msg).toContain(medidoEmProd);                       // 407 chars: intacto
    expect(msg).toContain(`de ${GOLD_TEXT_MAX + 500} chars`);  // defeito grande: corte DECLARADO
    expect(msg).toContain(`de ${MATCH_RATIONALE_MAX + 300} chars`); // rationale: corte DECLARADO
    expect(msg).toContain("o fato CONTINUA");
  });
});
