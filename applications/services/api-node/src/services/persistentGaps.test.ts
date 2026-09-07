/**
 * 🔴 GAP-68 — o fato "este GAP já foi entregue antes e sobreviveu à edição" tem de chegar ao agente.
 *
 * O GAP-67 provou em prod (run `b1bc1195`) que 8 de 14 "fechados" eram o MESMO defeito rebatizado.
 * Medir isso não muda nada sozinho: o CTO segue recebendo o defeito como novidade, reescreve a seção,
 * a âncora muda outra vez e a spec engorda. Estes testes cobrem as três peças que fecham o circuito —
 * registrar a linhagem, reencontrá-la no despacho e dizê-la ao agente — e a armadilha mais provável
 * da correção: ficar INERTE porque o fingerprint não casou.
 */
import { describe, it, expect } from "vitest";
import { buildPersistentRefs, type PersistentGapRef } from "./gapContinuity.js";
import { lastPersistedGaps, persistentGapsFor } from "./specAutonomy.js";
import { persistentGapFactBlock } from "../routes/specChat.js";
import { findingFingerprint } from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

function f(over: Partial<ValidationFinding> & { title: string }): ValidationFinding {
  return {
    file: "modelo-dados.md", line: null, severity: "blocker", rationale: "", source: "stage_b",
    category: "consistency", anchor: null, ...over,
  };
}

/** O par REAL medido em prod: `§6.1` virou `§6` e o defeito do `actor_role` continuou. */
const CLOSED = f({ anchor: "§6.1", title: "Domínio de `audit_log.actor_role` fechado por constraint e aberto no mesmo DDL" });
const OPENED = f({ anchor: "§6", title: "O `CREATE TABLE audit_log` de §6 declara `actor_role VARCHAR(10)` sem CHECK" });

describe("buildPersistentRefs", () => {
  it("indexa pelo lado ATUAL — é o fingerprint que o próximo despacho vai enviar", () => {
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "mesma contradição" }]);
    expect(ref.fingerprint).toBe(findingFingerprint(OPENED));
    expect(ref.fingerprint).not.toBe(findingFingerprint(CLOSED));
    expect(ref.anchor).toBe("§6");
    expect(ref.anchorBefore).toBe("§6.1");
    expect(ref.times).toBe(2);
  });

  it("acumula a LINHAGEM: o defeito que volta pela 3ª vez diz 3, não 2", () => {
    // Rodada anterior: o defeito estava em §6.1 (o fingerprint que hoje é o lado FECHADO).
    const prior: PersistentGapRef[] = [{
      fingerprint: findingFingerprint(CLOSED), file: "modelo-dados.md", anchor: "§6.1",
      anchorBefore: "§6.1.2", title: "t", why: "w", times: 2,
    }];
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "de novo" }], prior);
    expect(ref.times).toBe(3);
  });

  it("linhagem de outro defeito não contamina a contagem", () => {
    const prior: PersistentGapRef[] = [{
      fingerprint: "fp-de-outro-defeito", file: "privacidade-lgpd.md", anchor: "§9",
      anchorBefore: null, title: "t", why: "w", times: 7,
    }];
    const [ref] = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "w" }], prior);
    expect(ref.times).toBe(2);
  });

  it("no teto, quem cai é o MENOS reincidente (o pedido forte sobrevive)", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      closed: f({ anchor: `§a${i}`, title: `antes ${i}` }),
      opened: f({ anchor: `§b${i}`, title: `depois ${i}` }),
      why: "w",
    }));
    // O par 19 já tem linhagem longa; os outros nascem em 2.
    const prior: PersistentGapRef[] = [{
      fingerprint: findingFingerprint(pairs[19].closed), file: "modelo-dados.md",
      anchor: "§a19", anchorBefore: null, title: "t", why: "w", times: 5,
    }];
    const refs = buildPersistentRefs(pairs, prior);
    expect(refs).toHaveLength(12);
    expect(refs[0].times).toBe(6);
    expect(refs[0].fingerprint).toBe(findingFingerprint(pairs[19].opened));
  });
});

describe("lastPersistedGaps", () => {
  const REF: PersistentGapRef = {
    fingerprint: "fp1", file: "modelo-dados.md", anchor: "§6", anchorBefore: "§6.1",
    title: "t", why: "w", times: 2,
  };

  it("devolve as refs da medição mais recente", () => {
    const run = { rounds: [{ persistedGaps: [REF] }, { note: "rodada de arquivo" }] } as never;
    expect(lastPersistedGaps(run)).toEqual([REF]);
  });

  it("`gapsPersisted: 0` PARA a busca — reincidente fechado não pode ressuscitar", () => {
    // Passe antigo tinha reincidente; o passe seguinte reconciliou e não achou nenhum.
    const run = { rounds: [{ persistedGaps: [REF] }, { gapsPersisted: 0 }] } as never;
    expect(lastPersistedGaps(run)).toEqual([]);
  });

  it("rodada NÃO reconciliada (`gapsPersisted: null`) não apaga o que a anterior sabia", () => {
    const run = { rounds: [{ persistedGaps: [REF] }, { gapsPersisted: null }] } as never;
    expect(lastPersistedGaps(run)).toEqual([REF]);
  });

  it("run sem nenhuma medição devolve vazio, não `undefined`", () => {
    expect(lastPersistedGaps({ rounds: [] } as never)).toEqual([]);
  });
});

describe("persistentGapsFor", () => {
  const ref = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "w" }]);

  it("casa a ref com o finding que está indo ao CTO", () => {
    expect(persistentGapsFor(ref, "modelo-dados.md", [OPENED])).toHaveLength(1);
  });

  it("não afirma reincidência para GAP de outro arquivo", () => {
    const outro = f({ file: "privacidade-lgpd.md", anchor: "§6", title: "outro" });
    expect(persistentGapsFor(ref, "privacidade-lgpd.md", [outro])).toHaveLength(0);
  });

  it("caminho com caixa/espaço diferente ainda casa (o arquivo é o mesmo)", () => {
    expect(persistentGapsFor(ref, " Modelo-Dados.MD ", [OPENED])).toHaveLength(1);
  });

  it("🔴 INÉRCIA: se a âncora derivou DE NOVO, o fingerprint não casa e nada é afirmado", () => {
    // É o modo de falha esperado desta correção — e a razão de o despacho LOGAR a contagem.
    const derivou = f({ anchor: "§6.0", title: OPENED.title });
    expect(persistentGapsFor(ref, "modelo-dados.md", [derivou])).toHaveLength(0);
  });
});

describe("persistentGapFactBlock", () => {
  const ref = buildPersistentRefs([{ closed: CLOSED, opened: OPENED, why: "mesma contradição do CHECK" }]);

  it("sem reincidente não gasta uma linha de prompt", () => {
    expect(persistentGapFactBlock([])).toBe("");
    expect(persistentGapFactBlock(null)).toBe("");
    expect(persistentGapFactBlock(undefined)).toBe("");
  });

  it("ref com `times < 2` é descartada — 1ª aparição não é reincidência", () => {
    expect(persistentGapFactBlock([{ ...ref[0], times: 1 }])).toBe("");
  });

  it("mostra a DERIVA da âncora, que é a prova visível do rebatismo", () => {
    const b = persistentGapFactBlock(ref);
    expect(b).toContain("§6.1 → §6");
    expect(b).toContain("2ª aparição");
    expect(b).toContain("mesma contradição do CHECK");
  });

  it("declara a FONTE da afirmação — é juízo de agente, não medida de código", () => {
    expect(persistentGapFactBlock(ref)).toContain("um revisor compara");
  });

  it("pede REMOÇÃO na raiz, não reformulação — é o que ataca o crescimento (GAP-8)", () => {
    const b = persistentGapFactBlock(ref);
    expect(b).toContain("RENUMERAR, RENOMEAR OU REESCREVER A SEÇÃO NÃO FECHA");
    expect(b).toMatch(/APAGUE a outra/);
  });

  it("na 3ª aparição o aviso ESCALA (custo já pago duas vezes)", () => {
    const b = persistentGapFactBlock([{ ...ref[0], times: 3 }]);
    expect(b).toContain("3ª aparição");
    expect(b).toMatch(/ATENÇÃO/);
  });

  it("âncora ausente não vira `null` no texto entregue ao agente", () => {
    const b = persistentGapFactBlock([{ ...ref[0], anchor: null, anchorBefore: null }]);
    expect(b).not.toContain("null");
    expect(b).toContain("(sem âncora)");
  });
});
