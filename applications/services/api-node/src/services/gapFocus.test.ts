/**
 * gapFocus.test.ts — 🔴 GAP-81: o arquivo teimoso recebia o MESMO tratamento em todo passe.
 *
 * O que estes testes travam é o gatilho que o Jean exigiu ("focamos neles individualmente algumas
 * vezes, se insistir a reaparecer aí sim o juiz usa o novo poder") e, sobretudo, os dois jeitos de a
 * escalada virar teatro:
 *
 *  - declarar "foco" numa rodada que não restringiu NADA — a conta de foco pago inflaria e o gatilho do
 *    veredicto (GAP-77) viraria carimbo;
 *  - restringir sem AVISAR o agente — ele concluiria que o arquivo só tem aqueles defeitos e
 *    "consolidaria" o resto, que é a família do GAP-73.
 */
import { describe, it, expect } from "vitest";
import { planFocus, focusFactBlock, FOCUS_MIN_RECURRENCE, FOCUS_INDIVIDUAL_AFTER } from "./gapFocus.js";
import type { FocusFinding } from "./gapFocus.js";
import type { PersistentGapRef } from "./gapContinuity.js";
import { findingFingerprint } from "./findingTriage.js";

const F = (anchor: string | null, title = `t ${anchor}`): FocusFinding =>
  ({ file: "observabilidade-operacao.md", source: "stage_b", title, category: "other", anchor });

const REF = (f: FocusFinding, over: Partial<PersistentGapRef> = {}): PersistentGapRef => ({
  fingerprint: findingFingerprint(f),
  file: "observabilidade-operacao.md",
  anchor: f.anchor ?? null,
  anchorBefore: f.anchor ?? null,
  title: f.title,
  why: "",
  times: FOCUS_MIN_RECURRENCE,
  ...over,
});

describe("planFocus — degrau 0 (rodada normal)", () => {
  it("sem reincidência conhecida, a rodada trata TODOS os GAPs do arquivo", () => {
    const todos = [F("§1.2"), F("§4.1")];
    const p = planFocus({ findings: todos, refs: [], fileRounds: 9 });
    expect(p).toMatchObject({ level: 0, deferred: 0, anchors: [], reason: "" });
    expect(p.findings).toEqual(todos);
  });

  it("lista vazia não inventa foco", () => {
    expect(planFocus({ findings: [], refs: [REF(F("§1.2"))], fileRounds: 9 }).level).toBe(0);
  });

  it("1ª aparição não é teimosia (`times` abaixo do piso)", () => {
    const f = F("§1.2");
    expect(planFocus({ findings: [f, F("§4.1")], refs: [REF(f, { times: 1 })], fileRounds: 0 }).level).toBe(0);
  });

  it("TODOS teimosos ⇒ segue nível 0: declarar foco sem restringir infla a conta de foco pago", () => {
    // É a guarda que impede o gatilho do GAP-77 de virar carimbo — o arquivo espera o degrau 2, que é
    // restrição de verdade.
    const a = F("§1.2"), b = F("§4.1");
    const p = planFocus({ findings: [a, b], refs: [REF(a), REF(b)], fileRounds: 0 });
    expect(p.level).toBe(0);
    expect(p.findings).toHaveLength(2);
  });

  it("teimoso SEM âncora não gera foco — rodada dedicada se prova pela âncora que ela ataca", () => {
    const sem = F(null, "contrato ambíguo sem endereço");
    const p = planFocus({ findings: [sem, F("§4.1")], refs: [REF(sem)], fileRounds: 9 });
    expect(p.level).toBe(0);
  });
});

describe("planFocus — degrau 1 (só os teimosos)", () => {
  const teimoso = F("§1.2");
  const facil = F("§4.1");
  const plano = () => planFocus({ findings: [teimoso, facil], refs: [REF(teimoso)], fileRounds: 0 });

  it("restringe ao subconjunto reincidente e conta os adiados", () => {
    const p = plano();
    expect(p.level).toBe(1);
    expect(p.findings).toEqual([teimoso]);
    expect(p.anchors).toEqual(["§1.2"]);
    expect(p.deferred).toBe(1);
    expect(p.reason).toMatch(/1 de 2 GAP\(s\).*REINCIDENTES/);
  });

  it("âncora que voltou INTOCADA também é teimosia, mesmo com `times` baixo", () => {
    // É o sinal mais forte que existe: o trecho sobreviveu byte a byte depois de o agente ter recebido
    // o arquivo. Exigir reincidência aqui atrasaria a escalada em um passe inteiro.
    const p = planFocus({
      findings: [teimoso, facil],
      refs: [REF(teimoso, { times: 1, untouched: true })],
      fileRounds: 0,
    });
    expect(p.level).toBe(1);
    expect(p.findings).toEqual([teimoso]);
  });

  it("casa por ÂNCORA quando o fingerprint mudou — o rebatismo (GAP-67) não pode livrar do foco", () => {
    // Mesmo defeito, título trocado pelo juiz ⇒ outro fingerprint. Se o foco casasse só por
    // fingerprint, o teimoso escaparia exatamente quando muda de nome (família GAP-49/50).
    const rebatizado = F("§1.2", "OUTRO título para o mesmo defeito");
    const p = planFocus({ findings: [rebatizado, facil], refs: [REF(teimoso)], fileRounds: 0 });
    expect(p.level).toBe(1);
    expect(p.findings).toEqual([rebatizado]);
  });

  it("casa também pelo `anchorBefore` (a seção foi renumerada entre validações)", () => {
    const agora = F("§1.3");
    const ref = REF(agora, { anchor: "§1.3", anchorBefore: "§1.2" });
    const p = planFocus({ findings: [F("§1.2"), facil], refs: [ref], fileRounds: 0 });
    expect(p.level).toBe(1);
    expect(p.anchors).toEqual(["§1.2"]);
  });

  it("a grafia não precisa ser idêntica: casa por âncora NORMALIZADA", () => {
    const p = planFocus({ findings: [F("## 1.2 Métricas"), facil], refs: [REF(F("§1.2 metricas"))], fileRounds: 0 });
    expect(p.level).toBe(1);
    expect(p.anchors).toEqual(["## 1.2 Métricas"]);
  });
});

describe("planFocus — degrau 2 (foco individual)", () => {
  it(`depois de ${FOCUS_INDIVIDUAL_AFTER} rodadas no arquivo, a rodada trata UM defeito só`, () => {
    const a = F("§1.2"), b = F("§4.1"), c = F("§7.1");
    const p = planFocus({
      findings: [a, b, c],
      refs: [REF(a, { times: 4 }), REF(b, { times: 9 })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
    });
    expect(p.level).toBe(2);
    // Vence o MAIS teimoso, não o primeiro da lista.
    expect(p.findings).toEqual([b]);
    expect(p.anchors).toEqual(["§4.1"]);
    expect(p.deferred).toBe(2);
    expect(p.reason).toMatch(/foco INDIVIDUAL/);
  });

  it("empate em reincidência: desce para a âncora INTOCADA", () => {
    const a = F("§1.2"), b = F("§4.1");
    const p = planFocus({
      findings: [a, b],
      refs: [REF(a, { times: 3 }), REF(b, { times: 3, untouched: true })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER + 5,
    });
    expect(p.findings).toEqual([b]);
  });

  it("o degrau 2 acontece mesmo com TODOS teimosos — aqui restringir restringe de verdade", () => {
    const a = F("§1.2"), b = F("§4.1");
    const p = planFocus({ findings: [a, b], refs: [REF(a), REF(b)], fileRounds: FOCUS_INDIVIDUAL_AFTER });
    expect(p.level).toBe(2);
    expect(p.findings).toHaveLength(1);
  });

  it("um GAP só: o degrau 2 não vira nível 0 por acidente (é ele que abre o veredicto)", () => {
    const a = F("§1.2");
    const p = planFocus({ findings: [a], refs: [REF(a)], fileRounds: FOCUS_INDIVIDUAL_AFTER });
    expect(p.level).toBe(2);
    expect(p.deferred).toBe(0);
    expect(p.anchors).toEqual(["§1.2"]);
  });
});

describe("focusFactBlock", () => {
  it("rodada normal não gasta prompt com bloco nenhum", () => {
    expect(focusFactBlock({ level: 0, findings: [], anchors: [], deferred: 0, reason: "" })).toBe("");
  });

  it("diz as três coisas que o agente precisa saber para não consolidar o que ficou fora", () => {
    const a = F("§1.2");
    const bloco = focusFactBlock(planFocus({ findings: [a, F("§4.1")], refs: [REF(a)], fileRounds: 0 }));
    // (1) a lista está RESTRINGIDA de propósito…
    expect(bloco).toMatch(/RESTRINGIDA/);
    // (2) …os outros seguem ATIVOS e voltam (senão ele tenta resolvê-los mesmo assim)…
    expect(bloco).toMatch(/1 outro\(s\) GAP\(s\)/);
    expect(bloco).toMatch(/seguem ATIVOS/);
    // (3) …e o que ele fez antes NÃO funcionou — inclusive a errata nula do GAP-71.
    expect(bloco).toMatch(/VOLTARAM/);
    expect(bloco).toMatch(/errata em outra seção/);
  });

  it("no foco individual o alvo é declarado como UM defeito", () => {
    const a = F("§1.2");
    const bloco = focusFactBlock(planFocus({ findings: [a, F("§4.1")], refs: [REF(a)], fileRounds: FOCUS_INDIVIDUAL_AFTER }));
    expect(bloco).toMatch(/UM único defeito/);
  });
});
