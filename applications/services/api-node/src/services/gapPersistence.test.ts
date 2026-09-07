/**
 * gapPersistence.test.ts — 🔴 GAP-71.
 *
 * O que estes testes travam é o que a medição de prod mostrou (ver docblock do módulo): o CTO
 * acrescenta uma errata declarando o trecho ofensor nulo, o trecho continua byte-a-byte no arquivo, e
 * o mesmo fingerprint volta na validação seguinte. Os casos abaixo são, literalmente, a assinatura
 * disso — mais as duas maneiras de o fato virar MENTIRA (âncora que o código não achou; run que não
 * julgou o arquivo), porque acusar o agente sem prova é pior do que não avisar.
 */
import { describe, it, expect } from "vitest";
import {
  anchorSearchKey, untouchedAnchors, stableRecurrenceRefs, mergeRecurrenceRefs, markUntouched,
} from "./gapPersistence.js";
import type { PersistentGapRef } from "./gapContinuity.js";
import type { ValidationFinding } from "./specValidation.js";

function finding(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    file: "modelo-dados.md", line: null, severity: "blocker",
    title: "contradição de visibilidade", rationale: "", source: "stage_b",
    category: "consistency", anchor: "§8.6 (c)", ...over,
  };
}

describe("anchorSearchKey", () => {
  it("normaliza a grafia do juiz para a do arquivo, preservando dígitos", () => {
    expect(anchorSearchKey("§8.6 (c)")).toBe("8.6 c");
    expect(anchorSearchKey("8.6 c")).toBe("8.6 c");
    // Dígito é identidade: §8.6 e §8.7 NÃO podem colidir (mesma regra do `normalizeAnchor`).
    expect(anchorSearchKey("§8.7 (c)")).not.toBe(anchorSearchKey("§8.6 (c)"));
  });

  it("remove acento e caixa (o juiz escreve 'Seção', o arquivo 'SEÇÃO')", () => {
    expect(anchorSearchKey("Seção 11.3 etapa c")).toBe(anchorSearchKey("SECAO 11.3 ETAPA C"));
  });

  it("devolve string vazia para âncora sem conteúdo útil (não casa com nada)", () => {
    expect(anchorSearchKey("§§ ()")).toBe("");
    expect(anchorSearchKey("")).toBe("");
  });
});

describe("untouchedAnchors", () => {
  const before = [
    "# Modelo de dados",
    "",
    "## 8.6 Visibilidade",
    "",
    "(c) A consulta anônima responde com os valores sentinela.",
    "",
    "## 9.1 Credenciais",
    "",
    "Rotação a cada 90 dias.",
  ].join("\n");

  it("A PATOLOGIA MEDIDA: errata acrescentada no fim, trecho ofensor idêntico ⇒ intocada", () => {
    const after = `${before}\n\n## 12 Erratas\n\nD-24: §8.6 (c) é errata nula com efeito de remoção.\n`;
    const r = untouchedAnchors(before, after, ["§8.6 (c)"]);
    expect(r.measured).toEqual(["§8.6 (c)"]);
    expect(r.untouched).toEqual(["§8.6 (c)"]);
  });

  it("edição NO PRÓPRIO trecho ⇒ não é intocada (é o que se pede ao agente)", () => {
    const after = before.replace("com os valores sentinela", "com 404 COURIER_NOT_FOUND");
    const r = untouchedAnchors(before, after, ["§8.6 (c)"]);
    expect(r.measured).toEqual(["§8.6 (c)"]);
    expect(r.untouched).toEqual([]);
  });

  it("mexer em QUALQUER ponto da seção da âncora já conta como tocou (critério conservador)", () => {
    const after = before.replace("## 8.6 Visibilidade", "## 8.6 Visibilidade de entregadores");
    expect(untouchedAnchors(before, after, ["§8.6 (c)"]).untouched).toEqual([]);
  });

  it("âncora que o código NÃO acha vira `unlocatable` — nunca 'intocada'", () => {
    // ID cunhado pelo juiz que não existe no texto: afirmar que o agente não mexeu nele seria
    // acusação sem prova, e o bloco do prompt pediria a correção de um trecho inexistente.
    const r = untouchedAnchors(before, `${before}\nnovo\n`, ["VISIB-ANON-01"]);
    expect(r.unlocatable).toEqual(["VISIB-ANON-01"]);
    expect(r.measured).toEqual([]);
    expect(r.untouched).toEqual([]);
  });

  it("mede cada âncora uma vez e ignora vazias", () => {
    const after = `${before}\n\nerrata\n`;
    const r = untouchedAnchors(before, after, ["§8.6 (c)", "§8.6 (c)", "", null, undefined, "§9.1"]);
    expect(r.measured).toEqual(["§8.6 (c)", "§9.1"]);
    expect(r.untouched).toEqual(["§8.6 (c)", "§9.1"]);
  });

  it("sem um dos textos não afirma nada", () => {
    expect(untouchedAnchors("", "x", ["§8.6"]).measured).toEqual([]);
    expect(untouchedAnchors("x", "", ["§8.6"]).measured).toEqual([]);
  });
});

describe("stableRecurrenceRefs", () => {
  const cov = (...files: string[]) => ({ full: files });
  const f1 = finding();
  const f2 = finding({ anchor: "§11.5", title: "janela residual" });

  it("conta o MESMO fingerprint nas validações competentes e devolve ref `stable`", () => {
    const runs = [
      { findings: [f1, f2], coverage: cov("modelo-dados.md") },
      { findings: [f1], coverage: cov("modelo-dados.md") },
    ];
    const refs = stableRecurrenceRefs(runs, "modelo-dados.md", [f1, f2]);
    // f1 apareceu nas 2 validações competentes; f2 só numa ⇒ f2 ainda é "novidade" (times 1).
    expect(refs).toHaveLength(1);
    expect(refs[0].times).toBe(2);
    expect(refs[0].kind).toBe("stable");
    // Âncora ESTÁVEL: `anchorBefore === anchor` — não houve rebatismo, e o bloco do prompt não pode
    // imprimir um "X → X" como se tivesse havido.
    expect(refs[0].anchorBefore).toBe(refs[0].anchor);
    expect(refs[0].anchor).toBe("§8.6 (c)");
  });

  it("run que NÃO julgou o arquivo por inteiro não conta como aparição (GAP-20)", () => {
    const runs = [
      { findings: [f1], coverage: cov("modelo-dados.md") },
      { findings: [f1], coverage: cov("privacidade-lgpd.md") }, // rotação de cobertura
    ];
    expect(stableRecurrenceRefs(runs, "modelo-dados.md", [f1])).toEqual([]);
  });

  it("cobertura ausente/inválida é ignorada, nunca contada", () => {
    const runs = [{ findings: [f1], coverage: null }, { findings: [f1], coverage: { full: "x" } }];
    expect(stableRecurrenceRefs(runs, "modelo-dados.md", [f1])).toEqual([]);
  });

  it("casa cobertura por basename (o validador às vezes grava o caminho com rel_dir)", () => {
    const runs = [
      { findings: [f1], coverage: cov("specs/modelo-dados.md") },
      { findings: [f1], coverage: cov("specs/modelo-dados.md") },
    ];
    expect(stableRecurrenceRefs(runs, "modelo-dados.md", [f1])[0].times).toBe(2);
  });

  it("o mesmo finding repetido DENTRO de uma validação não infla `times`", () => {
    const runs = [{ findings: [f1, { ...f1 }], coverage: cov("modelo-dados.md") }];
    expect(stableRecurrenceRefs(runs, "modelo-dados.md", [f1])).toEqual([]);
  });

  it("sem GAPs despachados não há o que afirmar", () => {
    expect(stableRecurrenceRefs([{ findings: [f1], coverage: cov("modelo-dados.md") }], "modelo-dados.md", [])).toEqual([]);
  });

  it("ordena por reincidência decrescente", () => {
    const runs = [
      { findings: [f1, f2], coverage: cov("modelo-dados.md") },
      { findings: [f1, f2], coverage: cov("modelo-dados.md") },
      { findings: [f1], coverage: cov("modelo-dados.md") },
    ];
    const refs = stableRecurrenceRefs(runs, "modelo-dados.md", [f2, f1]);
    expect(refs.map((r) => r.times)).toEqual([3, 2]);
    expect(refs[0].anchor).toBe("§8.6 (c)");
  });
});

describe("mergeRecurrenceRefs", () => {
  const ref = (fp: string, times: number, kind?: "renamed" | "stable"): PersistentGapRef => ({
    fingerprint: fp, file: "modelo-dados.md", anchor: "§8.6 (c)", anchorBefore: "§8.5 (c)",
    title: "t", why: kind === "stable" ? "" : "seção renumerada", times, ...(kind ? { kind } : {}),
  });

  it("mesmo fingerprint: vence o maior `times` (afirmar o menor esconderia linhagem provada)", () => {
    const out = mergeRecurrenceRefs([ref("a", 2)], [ref("a", 4, "stable")]);
    expect(out).toHaveLength(1);
    expect(out[0].times).toBe(4);
    expect(out[0].kind).toBe("stable");
  });

  it("EMPATE: prevalece o `renamed` do reconciliador (traz `anchorBefore` real e o `why`)", () => {
    const out = mergeRecurrenceRefs([ref("a", 3)], [ref("a", 3, "stable")]);
    expect(out[0].kind).toBeUndefined();
    expect(out[0].why).toBe("seção renumerada");
  });

  it("fingerprints distintos somam e saem ordenados", () => {
    const out = mergeRecurrenceRefs([ref("a", 2)], [ref("b", 5, "stable")]);
    expect(out.map((r) => [r.fingerprint, r.times])).toEqual([["b", 5], ["a", 2]]);
  });

  it("respeita o teto de 12 refs (o bloco do prompt é finito)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ref(`s${i}`, i + 2, "stable"));
    expect(mergeRecurrenceRefs([], many)).toHaveLength(12);
  });
});

describe("markUntouched", () => {
  const ref: PersistentGapRef = {
    fingerprint: "a", file: "modelo-dados.md", anchor: "§8.6 (c)", anchorBefore: "§8.6 (c)",
    title: "t", why: "", times: 2, kind: "stable",
  };

  it("casa por chave normalizada, não por igualdade crua", () => {
    expect(markUntouched([ref], ["8.6 c"])[0].untouched).toBe(true);
  });

  it("não marca quem não está na lista", () => {
    expect(markUntouched([ref], ["§9.1"])[0].untouched).toBeUndefined();
  });

  it("lista vazia devolve as refs intactas", () => {
    expect(markUntouched([ref], [])).toEqual([ref]);
  });

  it("ref sem âncora nunca é marcada (não há trecho para afirmar nada sobre)", () => {
    const noAnchor = { ...ref, anchor: null };
    expect(markUntouched([noAnchor], ["8.6 c"])[0].untouched).toBeUndefined();
  });
});
