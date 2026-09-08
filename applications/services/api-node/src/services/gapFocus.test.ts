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
import {
  planFocus, focusFactBlock, FOCUS_MIN_RECURRENCE, FOCUS_INDIVIDUAL_AFTER, FOCUS_HISTORY_TITLES,
} from "./gapFocus.js";
import type { FocusFinding, AnchorHistory } from "./gapFocus.js";
import type { PersistentGapRef } from "./gapContinuity.js";
import { findingFingerprint } from "./findingTriage.js";
import { anchorSearchKey } from "../lib/markdownSections.js";

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

describe("planFocus — degrau 2 sem tampão (🔴 GAP-111)", () => {
  // O defeito medido: `privacidade-lgpd.md` tem 12 GAPs, recebeu 4 rodadas em 24, e a MESMA âncora
  // (`PRIV-ETAPAS-01`) foi o foco em 3 delas — escreveu nas 3, fechou 0, e os outros 11 nunca foram
  // pedidos. `ordenados[0]` é sempre o mais reincidente, e quem não fecha só fica MAIS reincidente.
  // A chave é a âncora NORMALIZADA — é assim que `anchorHistories` entrega o mapa, porque o juiz
  // reescreve a grafia entre validações (GAP-39/41).
  const HIST = (pares: Array<[string, number]>): Map<string, AnchorHistory> =>
    new Map(pares.map(([k, n]) => [anchorSearchKey(k), { dedicatedRounds: n, reportedTitles: [] }]));

  it("o mais teimoso que JÁ teve rodada dedicada cede a vez a quem nunca teve", () => {
    const a = F("§1.2"), b = F("§4.1");
    const p = planFocus({
      findings: [a, b],
      // `b` é MUITO mais teimoso — e é justamente ele que já monopolizou 3 rodadas dedicadas.
      refs: [REF(a, { times: 3 }), REF(b, { times: 9 })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
      history: HIST([["§4.1", 3]]),
    });
    expect(p.level).toBe(2);
    expect(p.findings).toEqual([a]);
    expect(p.reason).toMatch(/0 rodada\(s\) dedicada\(s\) a ele até aqui/);
    expect(p.reason).toMatch(/1 teimoso\(s\) deste arquivo ainda sem nenhuma/);
  });

  it("empate em rodadas dedicadas ⇒ a teimosia continua desempatando (a ordem antiga sobrevive)", () => {
    const a = F("§1.2"), b = F("§4.1");
    const p = planFocus({
      findings: [a, b],
      refs: [REF(a, { times: 3 }), REF(b, { times: 9 })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
      history: HIST([["§1.2", 2], ["§4.1", 2]]),
    });
    expect(p.findings).toEqual([b]);
  });

  it("sem histórico (ou banco indisponível) o comportamento é o de antes: o mais teimoso primeiro", () => {
    const a = F("§1.2"), b = F("§4.1");
    const args = { findings: [a, b], refs: [REF(a, { times: 3 }), REF(b, { times: 9 })], fileRounds: FOCUS_INDIVIDUAL_AFTER };
    expect(planFocus(args).findings).toEqual([b]);
    expect(planFocus({ ...args, history: new Map() }).findings).toEqual([b]);
  });

  it("todos já pagos: o de MENOS rodadas volta — rodízio, nunca paralisia", () => {
    const a = F("§1.2"), b = F("§4.1"), c = F("§7.1");
    const p = planFocus({
      findings: [a, b, c],
      refs: [REF(a, { times: 9 }), REF(b, { times: 9 }), REF(c, { times: 9 })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
      history: HIST([["§1.2", 4], ["§4.1", 2], ["§7.1", 3]]),
    });
    expect(p.findings).toEqual([b]);
  });

  it("a âncora do histórico casa por grafia NORMALIZADA — o juiz reescreve a âncora (GAP-39/41)", () => {
    const a = F("## 1.2 Métricas"), b = F("§4.1");
    const p = planFocus({
      findings: [a, b],
      refs: [REF(a, { times: 9 }), REF(b, { times: 3 })],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
      // Grafia diferente, mesma seção: se não normalizasse, `a` apareceria com 0 pagas e venceria.
      history: HIST([["§1.2 metricas", 5]]),
    });
    expect(p.findings).toEqual([b]);
  });
});

describe("focusFactBlock — a cadeia crua (🔴 GAP-112)", () => {
  const CADEIA: AnchorHistory = {
    dedicatedRounds: 3,
    reportedTitles: [
      "conflito de cardinalidade das etapas do job",
      "a cláusula declara-se oráculo único do inventário",
      "o oráculo só é verificável por artefato",
    ],
  };

  const bloco = (h: AnchorHistory) => {
    const a = F("§1.2");
    return focusFactBlock(planFocus({
      findings: [a, F("§4.1")],
      refs: [REF(a)],
      fileRounds: FOCUS_INDIVIDUAL_AFTER,
      history: new Map([[anchorSearchKey("§1.2"), h]]),
    }));
  };

  it("entrega os títulos anteriores em ordem, com a conta de rodadas dedicadas", () => {
    const b = bloco(CADEIA);
    expect(b).toMatch(/HISTÓRICO DESTA ÂNCORA/);
    expect(b).toMatch(/rodadas dedicadas só a ela até aqui: 3/);
    for (const t of CADEIA.reportedTitles) expect(b).toContain(t);
    // A ORDEM é o que revela a cadeia: o 1º elo tem de vir antes do último.
    expect(b.indexOf(CADEIA.reportedTitles[0])).toBeLessThan(b.indexOf(CADEIA.reportedTitles[2]));
  });

  it("o código NÃO interpreta a cadeia — quem lê é o agente", () => {
    // Blocker do revisor cross-family (DeepSeek): a versão anterior AFIRMAVA "o que foi tentado até
    // aqui não funcionou". O código não sabe isso — pode ter sido rebatismo (GAP-67) ou duplicata
    // dentro da mesma validação (medido: o mesmo defeito 3× numa validação). Afirmar é decidir
    // conteúdo, e conteúdo é do agente (Lei: 100% LLM).
    const b = bloco(CADEIA);
    expect(b).not.toMatch(/não funcionou/i);
    expect(b).toMatch(/decida você o que ele significa/);
  });

  it("declara que DECIDIR POR REDUÇÃO é desfecho legítimo (D7: corrigir por adição gera o elo seguinte)", () => {
    const b = bloco(CADEIA);
    expect(b).toMatch(/REDUÇÃO/);
    expect(b).toMatch(/REMOVER ou SUBORDINAR/);
    // E que remover não é perda: o mecanismo do GAP-12 exige o bloco ancorado completo.
    expect(b).toMatch(/bloco\s*\n?ancorado completo/);
  });

  it(`leva no máximo ${FOCUS_HISTORY_TITLES} títulos, e são os MAIS RECENTES (o fim da cadeia)`, () => {
    const muitos = Array.from({ length: FOCUS_HISTORY_TITLES + 4 }, (_, i) => `elo ${i}`);
    const b = bloco({ dedicatedRounds: 9, reportedTitles: muitos });
    expect(b).not.toContain("elo 0");
    expect(b).toContain(`elo ${muitos.length - 1}`);
    expect(b.match(/^ {2}\d+\. elo /gm) ?? []).toHaveLength(FOCUS_HISTORY_TITLES);
  });

  it("sem histórico nenhum, o bloco não inventa seção vazia", () => {
    const a = F("§1.2");
    const b = focusFactBlock(planFocus({ findings: [a, F("§4.1")], refs: [REF(a)], fileRounds: FOCUS_INDIVIDUAL_AFTER }));
    expect(b).not.toMatch(/HISTÓRICO DESTA ÂNCORA/);
    expect(b).toMatch(/UM único defeito/);
  });

  it("âncora sem título anterior, mas com rodada paga, ainda declara a rodada", () => {
    const b = bloco({ dedicatedRounds: 2, reportedTitles: [] });
    expect(b).toMatch(/rodadas dedicadas só a ela até aqui: 2/);
    expect(b).not.toMatch(/títulos que o juiz reportou/);
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
    // (3) …e o FATO de que os defeitos voltaram — inclusive que a errata nula do GAP-71 já falhou.
    // O que o bloco NÃO faz mais é concluir por ele que "não funcionou" (GAP-112).
    expect(bloco).toMatch(/VOLTARAM/);
    expect(bloco).toMatch(/errata em outra seção/);
  });

  it("no foco individual o alvo é declarado como UM defeito", () => {
    const a = F("§1.2");
    const bloco = focusFactBlock(planFocus({ findings: [a, F("§4.1")], refs: [REF(a)], fileRounds: FOCUS_INDIVIDUAL_AFTER }));
    expect(bloco).toMatch(/UM único defeito/);
  });
});
