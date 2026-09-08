/**
 * gapPromotionVerdict.test.ts — 🔴 GAP-77: o juiz pode declarar um GAP reincidente NÃO-impeditivo.
 *
 * O que estes testes protegem (e por quê) — são os três limites que o Jean impôs, virados em asserção:
 *
 *  (a) A SEVERIDADE NÃO MUDA. Nada aqui escreve em `findings` nem em triagem: o veredicto vive numa
 *      tabela paralela. Os testes só afirmam sobre `spec_gap_promotion_verdicts` e sobre o parecer.
 *
 *  (b) SÓ DEPOIS DE TRABALHO FEITO. Sem N GAPs fechados (e reconciliados, GAP-67) NENHUM candidato
 *      existe — o recurso não pode ser um atalho para aprovar a spec original.
 *
 *  (c) A AUTORIDADE NÃO PODE BAIXAR A QUALIDADE. É a maior parte deste arquivo, porque é aqui que a
 *      autoridade viraria anistia se alguém afrouxasse uma guarda:
 *       - veredicto é por GAP COM ENDEREÇO (arquivo + âncora), nunca em bloco;
 *       - arquivo visto só por SUMÁRIO não é julgável (GAP-20: ausência só é prova se alguém olhou);
 *       - **âncora INTOCADA descarta o candidato** — trecho que sobreviveu byte a byte significa que o
 *         agente não chegou lá: o defeito é NÃO-TENTADO, não insistente (é caso de modo foco);
 *       - reincidência contada SÓ em validações competentes para AQUELE arquivo;
 *       - falha em acusar NÃO é inocência: sem artefato concreto o candidato sai da rodada, e sem LLM /
 *         sem JSON / com motivo curto nada é liberado (fail-CLOSED — a lição do GAP-62, onde perguntar
 *         ao humano era fail-OPEN);
 *       - o parecer morre com o texto (`file_sha_at`), e o teto acumulado anula TODAS as liberações;
 *       - promovível exige também zero GAP importante sem arquivo e zero arquivo pendente de medição:
 *         parecer sobre a parte medida não vira aval sobre a parte que ninguém julgou.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnrichedFinding } from "./findingTriage.js";
import { findingFingerprint } from "./findingTriage.js";
import type { PastValidation } from "./gapPersistence.js";

const httpPost = vi.fn<(url: string, body: string, timeoutMs: number) => Promise<string>>();
vi.mock("../routes/specs.js", () => ({ httpPost: (...a: [string, string, number]) => httpPost(...a) }));

const {
  verdictConfig, selectVerdictCandidates, runVerdictRound, parseListResponse, anchoredSection,
  focusRoundsByFile, focusRoundsByAnchor, saveVerdicts, livePromotionVerdicts, promotabilityReport,
  proveWork, anchorHistories, focusKey, attackedRoundsByAnchor, parseCountField, anchorShaAt,
} = await import("./gapPromotionVerdict.js");
const { anchorSearchKey } = await import("./gapPersistence.js");

type Candidate = import("./gapPromotionVerdict.js").Candidate;
type LiveVerdict = import("./gapPromotionVerdict.js").LiveVerdict;
type VerdictConfig = import("./gapPromotionVerdict.js").VerdictConfig;

/** Config explícita em todo teste: o default vem do ambiente e não pode decidir o resultado da suíte. */
const CFG: VerdictConfig = { minGapsResolved: 3, minRecurrence: 3, minFocusRounds: 2, minAttackRounds: 3, maxPerRun: 3, maxPerSpec: 8, minPasses: 2 };

const F = (o: Partial<EnrichedFinding> = {}): EnrichedFinding => ({
  file: "modelo-dados.md", line: null, severity: "blocker", title: "contrato ambíguo", rationale: "",
  source: "stage_b", category: "other", anchor: "## 4. Autenticação", fingerprint: "",
  triageable: true, triage: null, ...o,
});

/** Validação passada que julgou `full` os arquivos dados e reportou os findings dados. */
const V = (full: string[], findings: EnrichedFinding[]): PastValidation =>
  ({ findings, coverage: { full } }) as unknown as PastValidation;

const SECTION = "## 4. Autenticação\nO login usa hash de senha.\n";
const sections = (anchor = "## 4. Autenticação", body = SECTION): Map<string, string> => new Map([[anchor, body]]);

const base = (o: Partial<Parameters<typeof selectVerdictCandidates>[0]> = {}): Parameters<typeof selectVerdictCandidates>[0] => ({
  findings: [F()],
  runs: [V(["modelo-dados.md"], [F()]), V(["modelo-dados.md"], [F()]), V(["modelo-dados.md"], [F()])],
  judged: new Set(["modelo-dados.md"]),
  // 🔴 GAP-81: são duas contas DIFERENTES e a distinção é a guarda. `focusByFile` é quantas rodadas o
  // arquivo levou no total (contexto do parecer); `focusByAnchor` é quantas rodadas DEDICADAS (nível 2)
  // atacaram só ESTE defeito — é o gatilho que o Jean exigiu ("focamos neles individualmente algumas
  // vezes"). A chave é normalizada por `anchorSearchKey` porque a grafia do juiz ≠ a grafia do arquivo.
  // 🔴 GAP-113: e é `(arquivo, âncora)` — `§1.1` existe em quase toda spec.
  focusByFile: new Map([["modelo-dados.md", 4]]),
  focusByAnchor: new Map([[focusKey("modelo-dados.md", "## 4. Autenticação"), 2]]),
  untouched: new Set<string>(),
  sections: sections(),
  gapsResolved: 5,
  cfg: CFG,
  ...o,
});

const C = (o: Partial<Candidate> = {}): Candidate => ({
  finding: F() as unknown as Candidate["finding"],
  fingerprint: findingFingerprint(F()),
  file: "modelo-dados.md",
  anchor: "## 4. Autenticação",
  times: 4,
  focusRounds: 3,
  attackedRounds: 0,
  fileRounds: 5,
  section: SECTION,
  ...o,
});

const fakeDb = (rows: Record<string, unknown>[] = []) => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { rows } as { rows: Record<string, unknown>[] };
    }),
  };
};

const ENV_KEYS = [
  "SPEC_VERDICT_MIN_GAPS_RESOLVED", "SPEC_VERDICT_MIN_RECURRENCE", "SPEC_VERDICT_MIN_FOCUS_ROUNDS",
  "SPEC_VERDICT_MIN_ATTACK_ROUNDS", "SPEC_VERDICT_MAX_PER_RUN", "SPEC_VERDICT_MAX_PER_SPEC", "SPEC_VERDICT_MODEL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  httpPost.mockReset();
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.API_AGENTS_URL = "http://agents:8000";
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("verdictConfig", () => {
  it("liga por padrão com barra alta e aceita override por env", () => {
    expect(verdictConfig()).toEqual({ minGapsResolved: 3, minRecurrence: 3, minFocusRounds: 2, minAttackRounds: 3, maxPerRun: 3, maxPerSpec: 24, minPasses: 2 });
    process.env.SPEC_VERDICT_MIN_RECURRENCE = "5";
    process.env.SPEC_VERDICT_MAX_PER_RUN = "1";
    expect(verdictConfig().minRecurrence).toBe(5);
    expect(verdictConfig().maxPerRun).toBe(1);
  });

  it("valor inválido cai no default (nunca vira NaN, que liberaria tudo)", () => {
    process.env.SPEC_VERDICT_MIN_RECURRENCE = "muitas";
    process.env.SPEC_VERDICT_MAX_PER_SPEC = "-3";
    expect(verdictConfig().minRecurrence).toBe(3);
    expect(verdictConfig().maxPerSpec).toBe(24);
  });

  it("SPEC_VERDICT_MIN_GAPS_RESOLVED=0 desliga o recurso sem deploy", () => {
    process.env.SPEC_VERDICT_MIN_GAPS_RESOLVED = "0";
    expect(verdictConfig().minGapsResolved).toBe(0);
    const gate = selectVerdictCandidates(base({ cfg: verdictConfig() }));
    expect(gate.enabled).toBe(false);
    expect(gate.candidates).toEqual([]);
    expect(gate.reason).toMatch(/desligado/);
  });
});

describe("selectVerdictCandidates — limite (b): só depois de trabalho feito", () => {
  it("sem GAPs fechados o bastante, nenhum candidato existe", () => {
    const gate = selectVerdictCandidates(base({ gapsResolved: 2 }));
    expect(gate.enabled).toBe(false);
    expect(gate.candidates).toEqual([]);
    expect(gate.reason).toMatch(/2 de 3 GAP/);
  });

  it("sem cobertura registrada, ninguém é julgável (GAP-20)", () => {
    const gate = selectVerdictCandidates(base({ judged: null }));
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/não registrou cobertura/);
  });
});

/**
 * 🔴 GAP-82 — a segunda prova de trabalho. Medido em prod (run `88339651`): 21 rodadas, 5 passes,
 * `gapsClosed = 0` nas quatro validações reconciliadas ⇒ com uma só prova, o juiz nunca teria
 * autoridade e a spec ficaria presa em loop eterno. O que estes testes travam é o EQUILÍBRIO: a porta
 * abre pelo esgotamento, mas só com o orçamento realmente gasto — e o "zero fechado" vai dito.
 */
describe("proveWork — GAP-82: fechar GAPs OU esgotar o laço", () => {
  const LOOP = (o: Partial<import("./gapPromotionVerdict.js").LoopWork> = {}): import("./gapPromotionVerdict.js").LoopWork => ({
    gapsResolved: 0, endReason: "exhausted", passes: 5, appliedRounds: 21,
    reconciledValidations: 4, focusRounds: 21, ...o,
  });

  it("fechamento reconciliado suficiente prova trabalho pelo caminho antigo", () => {
    const w = proveWork(LOOP({ gapsResolved: 3, passes: 0, appliedRounds: 0, reconciledValidations: 0, focusRounds: 0 }), CFG);
    expect(w.proven).toBe(true);
    expect(w.kind).toBe("resolved");
  });

  it("laço esgotado com ZERO fechado prova trabalho — e o zero vai no texto", () => {
    const w = proveWork(LOOP(), CFG);
    expect(w.proven).toBe(true);
    expect(w.kind).toBe("exhausted");
    expect(w.detail).toMatch(/0 GAP\(s\) fechado\(s\)/);
    expect(w.detail).toMatch(/5 passe\(s\)/);
    expect(w.detail).toMatch(/foco INDIVIDUAL/);
  });

  it("laço que morre no 1º passe NÃO prova nada (não gastou o orçamento)", () => {
    const w = proveWork(LOOP({ passes: 1 }), CFG);
    expect(w.proven).toBe(false);
    expect(w.detail).toMatch(/1 de 2 passe/);
  });

  it("sem foco individual pago o esgotamento não vale — é o gatilho do Jean", () => {
    const w = proveWork(LOOP({ focusRounds: 0 }), CFG);
    expect(w.proven).toBe(false);
    expect(w.detail).toMatch(/foco INDIVIDUAL/);
  });

  it("sem reconciliação, o 'zero fechado' não foi medido e não sustenta a porta", () => {
    const w = proveWork(LOOP({ reconciledValidations: 0 }), CFG);
    expect(w.proven).toBe(false);
    expect(w.detail).toMatch(/reconciliad/);
  });

  it("sem edição aplicada o laço não trabalhou", () => {
    const w = proveWork(LOOP({ appliedRounds: 0 }), CFG);
    expect(w.proven).toBe(false);
    expect(w.detail).toMatch(/disco/);
  });

  it("`minGapsResolved = 0` continua desligando tudo, inclusive o esgotamento", () => {
    const w = proveWork(LOOP(), { ...CFG, minGapsResolved: 0 });
    expect(w.proven).toBe(false);
    expect(w.detail).toMatch(/desligado/);
  });

  it("a porta aberta por esgotamento NÃO relaxa nenhuma guarda por GAP", () => {
    const work = proveWork(LOOP(), CFG);
    // Mesmo com trabalho provado, âncora intocada, cobertura por sumário e reincidência curta seguem
    // descartando o candidato — o esgotamento abre a porta, não baixa a barra.
    const intocada = selectVerdictCandidates(base({ gapsResolved: 0, work, untouched: new Set(["## 4. Autenticação"]) }));
    expect(intocada.enabled).toBe(true);
    expect(intocada.candidates).toEqual([]);
    expect(JSON.stringify(intocada.rejected)).toMatch(/NÃO-TENTADO/);
    const sumario = selectVerdictCandidates(base({ gapsResolved: 0, work, judged: new Set(["outro.md"]) }));
    expect(sumario.candidates).toEqual([]);
    expect(JSON.stringify(sumario.rejected)).toMatch(/SUMÁRIO/);
  });

  it("com esgotamento provado, o candidato reincidente e focado passa — e a razão declara a prova", () => {
    const work = proveWork(LOOP(), CFG);
    const gate = selectVerdictCandidates(base({ gapsResolved: 0, work }));
    expect(gate.enabled).toBe(true);
    expect(gate.candidates).toHaveLength(1);
    expect(gate.reason).toMatch(/prova de trabalho: laço ESGOTADO/);
    expect(gate.reason).toMatch(/0 GAP\(s\) fechado\(s\)/);
  });

  it("sem `work`, o comportamento antigo é preservado (só fechamento abre a porta)", () => {
    const gate = selectVerdictCandidates(base({ gapsResolved: 0 }));
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/0 de 3 GAP/);
  });
});

describe("selectVerdictCandidates — limite (c): as guardas de qualidade", () => {
  it("o candidato só existe com endereço, reincidência medida, foco pago e trecho verbatim", () => {
    const gate = selectVerdictCandidates(base());
    expect(gate.enabled).toBe(true);
    expect(gate.rejected).toEqual([]);
    expect(gate.candidates).toHaveLength(1);
    expect(gate.candidates[0]).toMatchObject({
      file: "modelo-dados.md", anchor: "## 4. Autenticação", times: 3, section: SECTION,
      // `focusRounds` vem da conta POR ÂNCORA (rodadas dedicadas); `fileRounds` é só o contexto.
      focusRounds: 2, fileRounds: 4,
    });
  });

  it("GAP sem âncora não é candidato — veredicto é por GAP com endereço", () => {
    const gate = selectVerdictCandidates(base({ findings: [F({ anchor: null })] }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/sem arquivo ou sem âncora/);
  });

  it("GAP sem arquivo não é candidato", () => {
    const gate = selectVerdictCandidates(base({ findings: [F({ file: "" })] }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0]).toMatchObject({ file: "(sem arquivo)" });
  });

  it("arquivo visto só por SUMÁRIO nesta validação não é julgável", () => {
    const gate = selectVerdictCandidates(base({ judged: new Set(["outro.md"]) }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/só por SUMÁRIO/);
  });

  it("âncora INTOCADA descarta: o agente não chegou lá, é NÃO-TENTADO (modo foco)", () => {
    const gate = selectVerdictCandidates(base({ untouched: new Set(["## 4. Autenticação"]) }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/NÃO-TENTADO/);
  });

  it("reincidência insuficiente descarta, e conta só validações COMPETENTES para o arquivo", () => {
    // 3 validações reportaram o defeito, mas duas não julgaram `modelo-dados.md` por inteiro.
    const gate = selectVerdictCandidates(base({
      runs: [V(["modelo-dados.md"], [F()]), V(["outro.md"], [F()]), V(["outro.md"], [F()])],
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/reapareceu em 1 validação/);
  });

  it("validação sem cobertura não conta como reincidência", () => {
    const noCov = { findings: [F()] } as unknown as PastValidation;
    const gate = selectVerdictCandidates(base({ runs: [V(["modelo-dados.md"], [F()]), noCov, noCov] }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/reincidência insuficiente/);
  });

  it("foco individual insuficiente descarta — é o gatilho que o Jean exigiu", () => {
    const gate = selectVerdictCandidates(base({ focusByAnchor: new Map([[focusKey("modelo-dados.md", "## 4. Autenticação"), 1]]) }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/trabalho insuficiente NESTE defeito: 1 rodada\(s\) DEDICADA\(S\)/);
  });

  /**
   * 🔴 GAP-113 — MEDIDO em prod: `§1.1` foi âncora de foco de nível 2 em 11 rodadas repartidas entre
   * DOIS arquivos (`visao-escopo.md` 9 e `nvx-lastmile-backend.md` 2), e 25 âncoras dos findings do juiz
   * se repetem em 2 a 4 arquivos diferentes. Contar a âncora sozinha dava por PAGO um foco que OUTRO
   * arquivo pagou — falso positivo, exatamente o que o limite (c) do Jean proíbe.
   */
  it("foco pago por OUTRO arquivo na mesma âncora não conta", () => {
    const gate = selectVerdictCandidates(base({
      focusByAnchor: new Map([[focusKey("visao-escopo.md", "## 4. Autenticação"), 9]]),
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/0 rodada\(s\) DEDICADA\(S\)/);
  });

  /**
   * 🔴 GAP-114 — MEDIDO em `privacidade-lgpd.md` após 74 rodadas do arquivo: `§7.1` apareceu em 49
   * validações, teve 0 rodada DEDICADA, 18 despachos e 11 rodadas em que o trecho ancorado foi de fato
   * REESCRITO. O gate rejeitava com "0 rodada(s) DEDICADA(S)" as âncoras MAIS insistentes justamente
   * porque o escalonador nunca dedicou rodada a elas: um impasse por construção. A cura não é anistia —
   * são duas provas admissíveis do MESMO fato, na forma do `proveWork`.
   */
  it("sem rodada dedicada, 3 rodadas em que o trecho foi REESCRITO abrem a porta", () => {
    const gate = selectVerdictCandidates(base({
      focusByAnchor: new Map(),
      attackedByAnchor: new Map([[focusKey("modelo-dados.md", "## 4. Autenticação"), 3]]),
    }));
    expect(gate.rejected).toEqual([]);
    expect(gate.candidates).toHaveLength(1);
    expect(gate.candidates[0].attackedRounds).toBe(3);
    expect(gate.candidates[0].focusRounds).toBe(0);
  });

  it("1 dedicada + 0 reescritas continua REJEITADO: a barra não caiu", () => {
    // É o caso `modelo-dados.md §7.2` medido em prod: 1 rodada dedicada, 8 despachos, ZERO reescritas
    // do trecho ancorado ⇒ NÃO-TENTADO (a guarda do GAP-71), e a régua nova o desqualifica também.
    const gate = selectVerdictCandidates(base({
      focusByAnchor: new Map([[focusKey("modelo-dados.md", "## 4. Autenticação"), 1]]),
      attackedByAnchor: new Map(),
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/0 rodada\(s\) em que o trecho ancorado foi de fato REESCRITO/);
  });

  it("2 reescritas ainda não bastam — a prova mais fraca exige mais rodadas", () => {
    const gate = selectVerdictCandidates(base({
      focusByAnchor: new Map(),
      attackedByAnchor: new Map([[focusKey("modelo-dados.md", "## 4. Autenticação"), 2]]),
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/2 rodada\(s\) em que o trecho ancorado foi de fato REESCRITO \(mínimo 3\)/);
  });

  /**
   * 🔴 GAP-81 — a guarda que quase virou carimbo. Contar RODADAS DO ARQUIVO como "foco individual" dava
   * o gatilho de graça: `modelo-dados.md` já tinha 4+ rodadas normais em prod, logo TODO defeito dele
   * nasceria elegível ao veredicto sem que uma única rodada tivesse sido dedicada a ele. A conta que
   * vale é a das rodadas de nível 2 sobre AQUELA âncora.
   */
  it("arquivo com muitas rodadas, mas ZERO dedicadas a este defeito, não é elegível", () => {
    const gate = selectVerdictCandidates(base({
      focusByFile: new Map([["modelo-dados.md", 9]]),
      focusByAnchor: new Map(),
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/0 rodada\(s\) DEDICADA\(S\)/);
    // O parecer precisa mostrar as DUAS contas, senão o humano não distingue "não tentado" de "insistente".
    expect(gate.rejected[0].why).toMatch(/o arquivo teve 9 rodada/);
  });

  it("rodada dedicada casa por âncora NORMALIZADA (a grafia do juiz não é a do arquivo)", () => {
    // O log da rodada gravou `§4. AUTENTICAÇÃO`; o finding chega como `## 4. Autenticação`.
    const gate = selectVerdictCandidates(base({
      focusByAnchor: new Map([[focusKey("modelo-dados.md", "§4. AUTENTICAÇÃO"), 2]]),
    }));
    expect(gate.rejected).toEqual([]);
    expect(gate.candidates).toHaveLength(1);
  });

  it("âncora não localizável descarta: o juiz decidiria sobre um resumo", () => {
    const gate = selectVerdictCandidates(base({ sections: new Map() }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected[0].why).toMatch(/não localizável/);
  });

  it("GAP triado e GAP de severidade baixa ficam fora (não são GAPs importantes)", () => {
    const gate = selectVerdictCandidates(base({
      findings: [
        F({ triage: { state: "ignored" } as unknown as EnrichedFinding["triage"] }),
        F({ severity: "info", anchor: "## 5. Outro" }),
      ],
    }));
    expect(gate.candidates).toEqual([]);
    expect(gate.rejected).toEqual([]);
  });

  it("ordena por reincidência e corta no teto de candidatos — cai o menos insistente", () => {
    const many = Array.from({ length: 10 }, (_, i) => F({ anchor: `## ${i} Seção`, title: `t${i}` }));
    // O defeito de índice i reapareceu em (i + 3) validações competentes.
    const runs: PastValidation[] = [];
    for (let k = 0; k < 13; k++) runs.push(V(["modelo-dados.md"], many.filter((_, i) => i + 3 > k)));
    const gate = selectVerdictCandidates(base({
      findings: many,
      runs,
      sections: new Map(many.map((f) => [String(f.anchor), SECTION])),
      focusByAnchor: new Map(many.map((f) => [focusKey("modelo-dados.md", String(f.anchor)), 2])),
    }));
    expect(gate.candidates).toHaveLength(8);
    expect(gate.candidates[0].times).toBeGreaterThanOrEqual(gate.candidates[7].times);
    expect(gate.candidates.map((c) => c.anchor)).not.toContain("## 0 Seção");
  });
});

describe("runVerdictRound — a rodada adversarial, fail-CLOSED em cada degrau", () => {
  const claim = (id: string) => ({ id, artifact: "POST /shipments", harm: "eu criaria status como enum de 4 valores e §7 exige 6 valores distintos" });
  const ok = (impact: string, id = "g1") => JSON.stringify({
    verdicts: [{ id, impact, reason: "é redundância consistente: os dois trechos declaram o MESMO enum, então a fábrica constrói igual" }],
  });

  it("sem candidatos a rodada não acontece", async () => {
    const r = await runVerdictRound([]);
    expect(r).toMatchObject({ ran: false, released: 0, verdicts: [] });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("promotor indisponível → nada liberado e o motivo diz que todos seguem impeditivos", async () => {
    httpPost.mockRejectedValueOnce(new Error("timeout"));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r).toMatchObject({ ran: false, released: 0, verdicts: [] });
    expect(r.reason).toMatch(/seguem impeditivos/);
  });

  it("promotor sem JSON → nada liberado", async () => {
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: "acho que sim, mas depende" }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/não devolveu JSON/);
  });

  it("falha em ACUSAR não é inocência: sem artefato E sem defesa sustentada o juiz nem é chamado", async () => {
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ id: "g1", artifact: "", harm: "nenhum dano real" }] }) }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ran: true, released: 0, verdicts: [] });
    expect(r.reason).toMatch(/não sustentou peça nenhuma/);
    // 🔴 GAP-118: o motivo diz QUAL descarte foi — "não respondeu" e "respondeu que não há dano"
    // são informações opostas, e o log antigo chamava as duas de "sem acusação concreta".
    expect(r.reason).toMatch(/1 com defesa não sustentada/);
  });

  // 🔴 GAP-118 — a voz que absolveria era a única emudecida: o prompt do promotor MANDA deixar o
  // artefato vazio quando ele construiria a coisa certa, e o código descartava esse candidato em
  // silêncio. Agora a defesa sustentada vira PEÇA e o candidato é julgado.
  it("defesa SUSTENTADA (artefato vazio + defesa citando o trecho) leva o candidato ao juiz", async () => {
    const defense = "eu construiria a tabela shipments com created_at TIMESTAMPTZ, exatamente como §3.2 declara verbatim, e o parágrafo repetido diz o mesmo com outras palavras";
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ id: "g1", artifact: "", harm: "", defense }] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: ok("nao_impeditivo"), model_used: "m1" }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    const judgeBody = JSON.parse(httpPost.mock.calls[1][1]) as { user_message: string };
    expect(judgeBody.user_message).toContain("DEFESA de quem vai construir");
    expect(judgeBody.user_message).toContain(defense);
    expect(r.released).toBe(1);
    expect(r.verdicts[0]).toMatchObject({ stance: "defesa", defense, factoryArtifact: "" });
    expect(r.reason).toMatch(/1 sobre defesa de quem vai construir/);
  });

  it("defesa NÃO libera por si: o juiz decide contra o trecho e pode mantê-la impeditiva", async () => {
    const defense = "eu construiria do jeito certo mesmo assim porque o trecho §3.2 já diz qual é o formato do campo e não há escolha ambígua";
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ id: "g1", artifact: "", harm: "", defense }] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: ok("impeditivo"), model_used: "m1" }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r.released).toBe(0);
    expect(r.verdicts[0]).toMatchObject({ stance: "defesa", impact: "impeditivo" });
  });

  it("defesa RASA (curta ou genérica) descarta o candidato — não é absolvição", async () => {
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ id: "g1", artifact: "", harm: "", defense: "é só redação" }] }) }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ran: true, released: 0, verdicts: [] });
  });

  it("acusação vence defesa quando o promotor manda as duas — a leitura é a que RETÉM", async () => {
    const defense = "eu construiria certo do mesmo jeito, o trecho §3.2 é claro o suficiente para não haver ambiguidade nenhuma aqui";
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ ...claim("g1"), defense }] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: ok("impeditivo"), model_used: "m1" }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    const judgeBody = JSON.parse(httpPost.mock.calls[1][1]) as { user_message: string };
    expect(judgeBody.user_message).toContain("ACUSAÇÃO de quem vai construir");
    expect(judgeBody.user_message).not.toContain("DEFESA de quem vai construir");
    expect(r.verdicts[0].stance).toBe("acusacao");
  });

  it("acusação genérica (curta) também descarta o candidato", async () => {
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [{ id: "g1", artifact: "API", harm: "fica ruim" }] }) }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(r.released).toBe(0);
  });

  it("só os candidatos ACUSADOS vão ao juiz", async () => {
    const cands = [C(), C({ anchor: "## 5. Erros", fingerprint: "fp2" })];
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g2")] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: ok("impeditivo", "g2"), model_used: "m1" }));
    const r = await runVerdictRound(cands, { maxRelease: 3 });
    const judgeBody = JSON.parse(httpPost.mock.calls[1][1]) as { user_message: string };
    expect(judgeBody.user_message).toContain("g2");
    expect(judgeBody.user_message).not.toContain("### g1 ");
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].anchor).toBe("## 5. Erros");
    expect(r.reason).toMatch(/1 sem resposta do promotor seguem impeditivos/);
  });

  it("juiz indisponível → nada liberado", async () => {
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1")] }) }))
      .mockRejectedValueOnce(new Error("500"));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r).toMatchObject({ ran: false, released: 0, verdicts: [] });
    expect(r.reason).toMatch(/o juiz não sustentou nenhum parecer/);
  });

  it("nao_impeditivo com motivo suficiente é liberado, com a acusação anexada ao parecer", async () => {
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1")] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: ok("nao_impeditivo"), model_used: "opus" }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r).toMatchObject({ ran: true, released: 1, model: "opus" });
    expect(r.verdicts[0]).toMatchObject({
      impact: "nao_impeditivo", file: "modelo-dados.md", factoryArtifact: "POST /shipments", times: 4, focusRounds: 3,
    });
    expect(r.verdicts[0].accusation).toMatch(/enum de 4 valores/);
  });

  it("motivo curto NÃO sustenta liberação: volta a impeditivo e a recusa é declarada", async () => {
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1")] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ verdicts: [{ id: "g1", impact: "nao_impeditivo", reason: "é só texto" }] }) }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r.released).toBe(0);
    expect(r.verdicts[0].impact).toBe("impeditivo");
    expect(r.reason).toMatch(/motivo insuficiente/);
  });

  it("impacto desconhecido/ausente cai em impeditivo (default seguro)", async () => {
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1")] }) }))
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ verdicts: [{ id: "g1", reason: "uma frase bem longa que justificaria qualquer coisa aqui" }] }) }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r.verdicts[0].impact).toBe("impeditivo");
    expect(r.released).toBe(0);
  });

  it("teto por rodada: o excedente volta a impeditivo, declarado no motivo", async () => {
    const cands = [C(), C({ anchor: "## 5. Erros", fingerprint: "fp2" })];
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1"), claim("g2")] }) }))
      .mockResolvedValueOnce(JSON.stringify({
        response: JSON.stringify({
          verdicts: [
            { id: "g1", impact: "nao_impeditivo", reason: "redundância consistente entre os dois trechos, a fábrica constrói igual" },
            { id: "g2", impact: "nao_impeditivo", reason: "ordem do documento apenas, nenhum contrato muda por causa disto" },
          ],
        }),
      }));
    const r = await runVerdictRound(cands, { maxRelease: 1 });
    // 🔴 GAP-120: `maxRelease` é o LOTE. Com orçamento 1 (default = o lote), o primeiro lote gasta o
    // orçamento e o segundo candidato nem chega ao juiz — e isso é DECLARADO, não gravado como parecer.
    expect(r.released).toBe(1);
    expect(r.verdicts).toHaveLength(1);
    expect(r.reason).toMatch(/não chegaram ao juiz \(teto acumulado de 1 esgotado\)/);
  });

  /**
   * 🔴 GAP-120 — o teto por chamada tinha virado o teto da spec inteira porque a rodada de veredicto
   * roda UMA vez por run. Estes testes fixam as três consequências: o laço julga em LOTES até o
   * orçamento acumulado; o que o teto retém diz que foi o teto (a linha não pode absolver e condenar
   * ao mesmo tempo); e lote perdido não apaga lote julgado.
   */
  describe("🔴 GAP-120 — lotes, orçamento acumulado e teto que não se disfarça de julgamento", () => {
    const cand = (n: number) => C({ anchor: `## ${n}. Seção`, fingerprint: `fp${n}` });
    const claims = (n: number) => JSON.stringify({
      response: JSON.stringify({ claims: Array.from({ length: n }, (_, i) => claim(`g${i + 1}`)) }),
    });
    const libera = (ids: string[]) => JSON.stringify({
      response: JSON.stringify({
        verdicts: ids.map((id) => ({
          id, impact: "nao_impeditivo",
          reason: "redundância consistente: os dois trechos declaram o mesmo contrato, a fábrica constrói igual",
        })),
      }),
    });

    it("orçamento maior que o lote ⇒ mais de uma chamada ao juiz, e todos os julgados valem", async () => {
      httpPost
        .mockResolvedValueOnce(claims(4))
        .mockResolvedValueOnce(libera(["g1", "g2"]))
        .mockResolvedValueOnce(libera(["g3", "g4"]));
      const r = await runVerdictRound([cand(1), cand(2), cand(3), cand(4)], { maxRelease: 2, budget: 4 });
      expect(r.released).toBe(4);
      expect(r.verdicts).toHaveLength(4);
      // 1 chamada de promotor + 2 de juiz: o lote de 2 não podia julgar 4 numa resposta só.
      expect(httpPost).toHaveBeenCalledTimes(3);
      expect(r.reason).toMatch(/2 chamada\(s\) de lote 2/);
    });

    it("retido pelo teto acumulado: a linha gravada DIZ que foi o teto, com o parecer do juiz preservado", async () => {
      httpPost
        .mockResolvedValueOnce(claims(2))
        .mockResolvedValueOnce(libera(["g1", "g2"]));
      const r = await runVerdictRound([cand(1), cand(2)], { maxRelease: 2, budget: 1 });
      expect(r.released).toBe(1);
      const retido = r.verdicts.find((v) => v.impact === "impeditivo");
      expect(retido).toBeDefined();
      expect(retido!.reason).toMatch(/^⚠️ liberação RETIDA pelo teto acumulado de 1 por spec/);
      expect(retido!.reason).toMatch(/o JUIZ havia declarado NÃO impeditivo/);
      // O parecer do juiz continua legível na mesma linha — nada de condenar com o texto que absolve.
      expect(retido!.reason).toMatch(/a fábrica constrói igual/);
      expect(r.reason).toMatch(/liberação RETIDA pelo teto acumulado/);
    });

    it("orçamento zerado (teto da spec já gasto) ⇒ ninguém chega ao juiz e nada é liberado", async () => {
      httpPost.mockResolvedValueOnce(claims(2));
      const r = await runVerdictRound([cand(1), cand(2)], { maxRelease: 2, budget: 0 });
      expect(r).toMatchObject({ ran: false, released: 0, verdicts: [] });
      expect(httpPost).toHaveBeenCalledTimes(1); // só o promotor
      expect(r.reason).toMatch(/não julgou nenhum candidato/);
    });

    it("lote perdido no juiz NÃO apaga o lote já julgado (a lição do GAP-119)", async () => {
      httpPost
        .mockResolvedValueOnce(claims(4))
        .mockResolvedValueOnce(libera(["g1", "g2"]))
        .mockRejectedValueOnce(new Error("500"));
      const r = await runVerdictRound([cand(1), cand(2), cand(3), cand(4)], { maxRelease: 2, budget: 4 });
      expect(r.ran).toBe(true);
      expect(r.released).toBe(2);
      expect(r.verdicts).toHaveLength(2);
      expect(r.reason).toMatch(/lote\(s\) perdido\(s\) no juiz/);
    });

    it("parecer sobre candidato que não estava no bloco enviado é descartado", async () => {
      httpPost
        .mockResolvedValueOnce(claims(2))
        // O lote 1 recebeu só g1, mas o juiz responde sobre g2 (cujo trecho ele não viu).
        .mockResolvedValueOnce(libera(["g1", "g2"]))
        .mockResolvedValueOnce(libera(["g2"]));
      const r = await runVerdictRound([cand(1), cand(2)], { maxRelease: 1, budget: 2 });
      expect(r.released).toBe(2);
      expect(r.verdicts).toHaveLength(2);
      // g2 só entrou no SEU lote: duas chamadas ao juiz, não uma.
      expect(httpPost).toHaveBeenCalledTimes(3);
    });
  });

  it("id inventado e id repetido são ignorados", async () => {
    httpPost
      .mockResolvedValueOnce(JSON.stringify({ response: JSON.stringify({ claims: [claim("g1")] }) }))
      .mockResolvedValueOnce(JSON.stringify({
        response: JSON.stringify({
          verdicts: [
            { id: "g99", impact: "nao_impeditivo", reason: "uma justificativa longa o suficiente para passar do mínimo" },
            { id: "g1", impact: "impeditivo", reason: "a fábrica escolheria errado o enum de status" },
            { id: "g1", impact: "nao_impeditivo", reason: "segunda tentativa de liberar o mesmo item, deve ser ignorada" },
          ],
        }),
      }));
    const r = await runVerdictRound([C()], { maxRelease: 3 });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0].impact).toBe("impeditivo");
    expect(r.released).toBe(0);
  });

  it("manda o trecho VERBATIM e avisa que a spec é dado não-confiável", async () => {
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: "{}" }));
    await runVerdictRound([C()], { maxRelease: 3 });
    const body = JSON.parse(httpPost.mock.calls[0][1]) as { user_message: string; prompt_override: string; model_id?: string };
    expect(body.user_message).toContain("O login usa hash de senha.");
    expect(body.user_message).toMatch(/não-confiável/);
    expect(body.prompt_override).toMatch(/CONSTRUIRIA ERRADO/);
    // Sem override de env, deixa o runtime escolher o modelo mais capaz (idem specOracles).
    expect(body.model_id).toBeUndefined();
  });

  it("SPEC_VERDICT_MODEL força o modelo quando existe", async () => {
    process.env.SPEC_VERDICT_MODEL = "us.anthropic.claude-opus-5";
    httpPost.mockResolvedValueOnce(JSON.stringify({ response: "{}" }));
    await runVerdictRound([C()], { maxRelease: 3 });
    expect((JSON.parse(httpPost.mock.calls[0][1]) as { model_id?: string }).model_id).toBe("us.anthropic.claude-opus-5");
  });
});

describe("parseListResponse", () => {
  it("tolera cercas de código e prosa em volta", () => {
    expect(parseListResponse('```json\n{"claims":[{"id":"g1"}]}\n```', "claims")).toEqual([{ id: "g1" }]);
    expect(parseListResponse('Segue: {"claims":[{"id":"g2"}]} espero ter ajudado', "claims")).toEqual([{ id: "g2" }]);
  });

  it("chave ausente, lixo e vazio devolvem null (fail-CLOSED)", () => {
    expect(parseListResponse('{"outra":[]}', "claims")).toBeNull();
    expect(parseListResponse("sem json aqui", "claims")).toBeNull();
    expect(parseListResponse("", "claims")).toBeNull();
  });
});

describe("parseCountField — a DECLARAÇÃO do agente sobre o próprio corte", () => {
  it("lê o inteiro irmão da lista, inclusive vindo como string", () => {
    expect(parseCountField('{"constraints":[],"constraints_needed":17}', "constraints_needed")).toBe(17);
    expect(parseCountField('```json\n{"constraints_needed":"9"}\n```', "constraints_needed")).toBe(9);
    expect(parseCountField('{"constraints_needed":4.7}', "constraints_needed")).toBe(4);
  });

  it("ausente, negativo ou ilegível é null — e null NÃO é zero", () => {
    // "não declarei" e "declarei que devolvi tudo" são respostas diferentes: a segunda é uma
    // afirmação e conta como declaração; a primeira é silêncio e é contada à parte.
    expect(parseCountField('{"constraints":[]}', "constraints_needed")).toBeNull();
    expect(parseCountField('{"constraints_needed":-2}', "constraints_needed")).toBeNull();
    expect(parseCountField('{"constraints_needed":"muitas"}', "constraints_needed")).toBeNull();
    expect(parseCountField("", "constraints_needed")).toBeNull();
    expect(parseCountField('{"constraints_needed":0}', "constraints_needed")).toBe(0);
  });
});

describe("anchoredSection", () => {
  const doc = "# Spec\npreâmbulo\n\n## 4. Autenticação\nsenha com Argon2id\n\n## 5. Erros\ncódigos\n";

  it("devolve o trecho da seção ancorada, verbatim", () => {
    const s = anchoredSection(doc, "## 4. Autenticação");
    expect(s).toContain("Argon2id");
    expect(s).not.toContain("códigos");
  });

  it("âncora inexistente devolve vazio (e o chamador descarta o candidato)", () => {
    expect(anchoredSection(doc, "## 99. Nada disso existe aqui")).toBe("");
    expect(anchoredSection(doc, "")).toBe("");
  });
});

describe("focusRoundsByFile", () => {
  it("conta rodadas despachadas por arquivo, em TODAS as runs do projeto", async () => {
    const db = fakeDb([{ f: "modelo-dados.md", n: 4 }, { f: "visao-escopo.md", n: 2 }, { f: null, n: 9 }]);
    const map = await focusRoundsByFile(db as never, "p1");
    expect(map.get("modelo-dados.md")).toBe(4);
    expect(map.get("visao-escopo.md")).toBe(2);
    expect(map.size).toBe(2);
    expect(db.calls[0].text).toContain("spec_autonomy_runs");
  });

  it("lê `filePath`, que é a chave real do log — `file` não existe e daria zero em tudo", () => {
    // 🔴 O bug que fazia o gatilho do GAP-77 nunca abrir: a consulta pedia `r->>'file'`, chave que o
    // `AutonomyRoundLog` nunca gravou, então TODO arquivo tinha 0 rodadas e nenhum GAP era elegível.
    const db = fakeDb();
    return focusRoundsByFile(db as never, "p1").then(() => {
      expect(db.calls[0].text).toContain("filePath");
      expect(db.calls[0].text).not.toMatch(/->>'file'/);
    });
  });
});

/**
 * 🔴 GAP-81 — a conta que o gatilho do Jean exige: rodadas DEDICADAS (nível 2) por defeito, não por
 * arquivo. Um arquivo com 9 rodadas normais não pagou foco individual em nenhum dos seus defeitos.
 */
describe("focusRoundsByAnchor", () => {
  it("conta só rodadas de nível 2 e agrega por (arquivo, âncora) normalizada", async () => {
    const db = fakeDb([
      { f: "modelo-dados.md", anchor: "§8.6 (c)", n: 2 }, { f: "modelo-dados.md", anchor: "8.6 c", n: 1 },
      { f: "modelo-dados.md", anchor: "§9.1", n: 3 },
    ]);
    const map = await focusRoundsByAnchor(db as never, "p1");
    // As duas grafias da MESMA âncora somam — senão o defeito "trocaria de nome" e perderia o foco pago.
    expect(map.get(focusKey("modelo-dados.md", "§8.6 (c)"))).toBe(3);
    expect(map.get(focusKey("modelo-dados.md", "§9.1"))).toBe(3);
    expect(map.size).toBe(2);
    expect(db.calls[0].text).toContain("focusLevel");
    expect(db.calls[0].text).toContain("focusAnchors");
    expect(db.calls[0].text).toContain("filePath");
  });

  /** 🔴 GAP-113: a MESMA âncora em arquivos diferentes são DOIS defeitos; somar era falso positivo. */
  it("a mesma âncora em arquivos diferentes não soma", async () => {
    const db = fakeDb([
      { f: "visao-escopo.md", anchor: "§1.1", n: 9 }, { f: "nvx-lastmile-backend.md", anchor: "§1.1", n: 2 },
    ]);
    const map = await focusRoundsByAnchor(db as never, "p1");
    expect(map.get(focusKey("visao-escopo.md", "§1.1"))).toBe(9);
    expect(map.get(focusKey("nvx-lastmile-backend.md", "§1.1"))).toBe(2);
    expect(map.size).toBe(2);
  });

  it("âncora/arquivo vazio é ignorado e a falha de consulta devolve mapa vazio (nunca elegibilidade grátis)", async () => {
    const db = fakeDb([
      { f: "f.md", anchor: null, n: 5 }, { f: "f.md", anchor: "§§ ()", n: 4 }, { f: null, anchor: "§1", n: 7 },
    ]);
    expect((await focusRoundsByAnchor(db as never, "p1")).size).toBe(0);
    const broken = { query: vi.fn(async () => { throw new Error("coluna não existe"); }) };
    expect((await focusRoundsByAnchor(broken as never, "p1")).size).toBe(0);
  });
});

/**
 * 🔴 GAP-114 — a segunda prova admissível. "Atacada" é medida em BYTES: a âncora estava no
 * `gapAnchors` da rodada, a rodada aplicou (`applied`), e a âncora NÃO está no `anchorsUntouched`
 * daquela rodada (campo presente em 167/167 rodadas aplicadas em prod).
 */
describe("attackedRoundsByAnchor", () => {
  it("conta uma vez por (run, rodada, arquivo, âncora), agregando grafias", async () => {
    const db = fakeDb([
      { run_id: "r1", round_idx: "3", f: "privacidade-lgpd.md", anchor: "§7.1" },
      // A MESMA rodada com a âncora repetida em outra grafia é UMA rodada, não duas.
      { run_id: "r1", round_idx: "3", f: "privacidade-lgpd.md", anchor: "7.1" },
      { run_id: "r1", round_idx: "5", f: "privacidade-lgpd.md", anchor: "§7.1" },
      { run_id: "r2", round_idx: "3", f: "privacidade-lgpd.md", anchor: "§7.1" },
    ]);
    const map = await attackedRoundsByAnchor(db as never, "p1");
    expect(map.get(focusKey("privacidade-lgpd.md", "§7.1"))).toBe(3);
    expect(map.size).toBe(1);
  });

  it("a consulta exige rodada aplicada e EXCLUI a âncora intocada — senão contaria não-trabalho", async () => {
    const db = fakeDb();
    await attackedRoundsByAnchor(db as never, "p1");
    expect(db.calls[0].text).toContain("'applied' = 'true'");
    expect(db.calls[0].text).toContain("anchorsUntouched");
    expect(db.calls[0].text).toContain("gapAnchors");
  });

  it("falha de consulta devolve mapa vazio: fail-CLOSED, só a rodada dedicada vale", async () => {
    const broken = { query: vi.fn(async () => { throw new Error("coluna não existe"); }) };
    expect((await attackedRoundsByAnchor(broken as never, "p1")).size).toBe(0);
  });
});

/**
 * 🔴 GAP-112 — a CADEIA. Rastreando `PRIV-ETAPAS-01` em 33 validações, cada elo do defeito nasceu da
 * correção do elo anterior, e a pergunta original ("o job tem 3 ou 4 etapas?") nunca foi decidida. O
 * agente via um elo por vez. Esta consulta entrega a cadeia — crua, sem rótulo.
 */
describe("anchorHistories", () => {
  /** Duas consultas com respostas diferentes: rodadas dedicadas (nível 2) e títulos por âncora. */
  const dbCom = (dedicadas: Record<string, unknown>[], titulos: Record<string, unknown>[]) => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    return {
      calls,
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: text.includes("focusAnchors") ? dedicadas : titulos };
      }),
    };
  };

  it("junta rodadas dedicadas e títulos, em ordem cronológica, por âncora normalizada", async () => {
    const db = dbCom(
      [{ f: "privacidade-lgpd.md", anchor: "PRIV-ETAPAS-01", n: 3 }],
      [
        { anchor: "PRIV-ETAPAS-01", title: "conflito de cardinalidade das etapas" },
        { anchor: "priv-etapas-01", title: "a cláusula se declara oráculo único" },
        { anchor: "§7.1", title: "outro defeito, outra âncora" },
      ],
    );
    const map = await anchorHistories(db as never, "p1", "privacidade-lgpd.md");
    const h = map.get(anchorSearchKey("PRIV-ETAPAS-01"))!;
    expect(h.dedicatedRounds).toBe(3);
    expect(h.reportedTitles).toEqual([
      "conflito de cardinalidade das etapas",
      "a cláusula se declara oráculo único",
    ]);
    // A outra âncora existe, mas com zero rodada dedicada — o fato é diferente, não ausente.
    expect(map.get(anchorSearchKey("§7.1"))).toEqual({
      dedicatedRounds: 0, reportedTitles: ["outro defeito, outra âncora"],
    });
    // Só as validações CONCLUÍDAS e só o arquivo pedido — findings de uma validação em voo não são fato.
    expect(db.calls[1].text).toMatch(/status IN \('passed', 'failed'\)/);
    expect(db.calls[1].values).toEqual(["p1", "privacidade-lgpd.md"]);
  });

  it("repetição CONSECUTIVA colapsa numa linha com a contagem — a cadeia fica legível e a conta visível", async () => {
    // 33 validações reportando o mesmo título produziriam 33 linhas idênticas no prompt. Colapsar sem
    // dizer quantas vezes esconderia um fato: "voltou 12 vezes igual" ≠ "voltou 1 vez".
    const db = dbCom([], [
      { anchor: "§3.2", title: "par (code, HTTP) divergente" },
      { anchor: "§3.2", title: "PAR (CODE, HTTP) DIVERGENTE" },
      { anchor: "§3.2", title: "par (code, HTTP) divergente" },
      { anchor: "§3.2", title: "gate comportamental exige semear privacy_requests" },
      { anchor: "§3.2", title: "par (code, HTTP) divergente" },
    ]);
    const h = (await anchorHistories(db as never, "p1", "f.md")).get(anchorSearchKey("§3.2"))!;
    expect(h.reportedTitles).toEqual([
      "par (code, HTTP) divergente (reportado 3× seguidas)",
      "gate comportamental exige semear privacy_requests",
      // Voltou DEPOIS do outro elo: é reaparição, não repetição — vira linha própria.
      "par (code, HTTP) divergente",
    ]);
  });

  /**
   * 🔴 GAP-113 — este bloco já prometia "só as âncoras deste ARQUIVO entram", mas isso valia apenas
   * para os títulos: a contagem de rodadas dedicadas vinha do mapa do PROJETO, cego ao arquivo. Com
   * `§1.1` medido em 11 rodadas repartidas entre dois arquivos, o `planFocus` recebia um histórico
   * inflado e mandava a âncora virgem para o fim da fila.
   */
  it("rodada dedicada de OUTRO arquivo não entra no histórico deste", async () => {
    const db = dbCom(
      [{ f: "visao-escopo.md", anchor: "§1.1", n: 9 }, { f: "nvx-lastmile-backend.md", anchor: "§1.1", n: 2 }],
      [{ anchor: "§1.1", title: "escopo do piloto contradiz o MVP" }],
    );
    const map = await anchorHistories(db as never, "p1", "nvx-lastmile-backend.md");
    expect(map.get(anchorSearchKey("§1.1"))!.dedicatedRounds).toBe(2);
  });

  it("âncora ou título vazio é ignorado, e falha de consulta devolve mapa vazio (nunca derruba a rodada)", async () => {
    const db = dbCom([], [{ anchor: null, title: "sem endereço" }, { anchor: "§1", title: "   " }]);
    expect((await anchorHistories(db as never, "p1", "f.md")).size).toBe(0);
    const broken = { query: vi.fn(async () => { throw new Error("relation não existe"); }) };
    expect((await anchorHistories(broken as never, "p1", "f.md")).size).toBe(0);
  });
});

describe("saveVerdicts", () => {
  it("grava o parecer com o SHA do arquivo julgado — a chave de obsolescência", async () => {
    const db = fakeDb();
    const n = await saveVerdicts(db as never, {
      projectId: "p1", autonomyRunId: "r1", validationRunId: "v1",
      verdicts: [{
        fingerprint: "fp1", file: "Modelo-Dados.md", anchor: "## 4", severity: "blocker", title: "t",
        impact: "nao_impeditivo", reason: "motivo", factoryArtifact: "POST /x", accusation: "dano",
        stance: "acusacao", defense: "", times: 4, focusRounds: 3,
      }],
      shaByFile: new Map([["modelo-dados.md", "sha-abc"]]),
      model: "opus",
    });
    expect(n).toBe(1);
    expect(db.calls[0].text).toContain("INSERT INTO spec_gap_promotion_verdicts");
    expect(db.calls[0].values).toContain("sha-abc");
    expect(db.calls[0].values).toContain("nao_impeditivo");
  });
});

describe("livePromotionVerdicts", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    fingerprint: "fp1", file_path: "modelo-dados.md", anchor: "## 4", impact: "nao_impeditivo",
    reason: "motivo", factory_artifact: "POST /x", file_sha_at: "sha-abc", created_at: "2026-09-07T12:00:00Z", ...o,
  });

  it("parecer sobre o conteúdo ATUAL vale; sobre conteúdo antigo fica obsoleto", async () => {
    const db = fakeDb([row(), row({ fingerprint: "fp2", file_sha_at: "sha-velho" })]);
    const live = await livePromotionVerdicts(db as never, "p1", new Map([["modelo-dados.md", "sha-abc"]]));
    expect(live.find((v) => v.fingerprint === "fp1")!.stale).toBe(false);
    expect(live.find((v) => v.fingerprint === "fp2")!.stale).toBe(true);
  });

  it("sem SHA atual (arquivo removido) o parecer não pode ser afirmado", async () => {
    const db = fakeDb([row()]);
    const live = await livePromotionVerdicts(db as never, "p1", new Map());
    expect(live[0].stale).toBe(true);
  });

  it("um parecer por defeito: o mais recente ganha", async () => {
    const db = fakeDb([row({ impact: "impeditivo" }), row({ impact: "nao_impeditivo", created_at: "2026-09-01T00:00:00Z" })]);
    const live = await livePromotionVerdicts(db as never, "p1", new Map([["modelo-dados.md", "sha-abc"]]));
    expect(live).toHaveLength(1);
    expect(live[0].impact).toBe("impeditivo");
  });

  /**
   * 🔴 GAP-124 — a obsolescência é do TRECHO julgado, não do arquivo.
   *
   * MEDIDO em prod (NVX LastMile, 2026-09-08): 15 pareceres vivos, 13 liberações acumuladas em 3 runs
   * de veredicto, e NENHUM `file_sha_at` batia com o sha atual — o laço reescreve os 12 arquivos da spec
   * a cada passe, então editar qualquer seção matava o parecer sobre seções que ninguém tocou. Efeito:
   * `released` sempre 0, teto acumulado de 24 decorativo, `promotable` falso por construção e os
   * desenhos Mermaid (gatilho `promotable`) inalcançáveis — o arquétipo do gatilho impossível.
   */
  describe("🔴 GAP-124 — obsolescência pela SEÇÃO ancorada, não pelo arquivo", () => {
    const spec = (body: string) => `# Doc\n\n## 4 Modelo\n\n${body}\n\n## 5 Outra\n\ntexto qualquer.\n`;
    const snap = (content: string, sha = "sha-novo") =>
      new Map([["modelo-dados.md", { sha, content }]]);

    it("editar OUTRA seção não mata o parecer (arquivo mudou, o trecho julgado não)", async () => {
      const antes = spec("o defeito julgado.");
      const anchorSha = anchorShaAt(antes, "## 4");
      expect(anchorSha).not.toBe("");
      const db = fakeDb([row({ file_sha_at: "sha-velho", anchor_sha_at: anchorSha })]);
      // Mesma §4, §5 reescrita ⇒ sha do ARQUIVO diferente, sha da SEÇÃO igual.
      const depois = antes.replace("texto qualquer.", "outro texto, bem maior, escrito no passe seguinte.");
      const live = await livePromotionVerdicts(db as never, "p1", snap(depois));
      expect(live[0].stale).toBe(false);
    });

    it("reescrever a PRÓPRIA seção julgada obsolesce o parecer", async () => {
      const antes = spec("o defeito julgado.");
      const db = fakeDb([row({ file_sha_at: "sha-velho", anchor_sha_at: anchorShaAt(antes, "## 4") })]);
      const live = await livePromotionVerdicts(db as never, "p1", snap(spec("o defeito, agora reescrito.")));
      expect(live[0].stale).toBe(true);
    });

    it("âncora que DESAPARECEU do arquivo obsolesce o parecer (fail-CLOSED)", async () => {
      const antes = spec("o defeito julgado.");
      const db = fakeDb([row({ file_sha_at: "sha-velho", anchor_sha_at: anchorShaAt(antes, "## 4") })]);
      const live = await livePromotionVerdicts(db as never, "p1", snap("# Doc\n\n## 5 Outra\n\ntexto.\n"));
      expect(live[0].stale).toBe(true);
    });

    it("parecer SEM `anchor_sha_at` (anterior a este GAP) segue pela regra do arquivo — nada retroativo", async () => {
      const db = fakeDb([row({ file_sha_at: "sha-velho", anchor_sha_at: null })]);
      const live = await livePromotionVerdicts(db as never, "p1", snap(spec("qualquer coisa")));
      expect(live[0].stale).toBe(true);
    });

    it("arquivo fora do snapshot obsolesce mesmo com sha de âncora gravado", async () => {
      const antes = spec("o defeito julgado.");
      const db = fakeDb([row({ anchor_sha_at: anchorShaAt(antes, "## 4") })]);
      const live = await livePromotionVerdicts(db as never, "p1", new Map());
      expect(live[0].stale).toBe(true);
    });

    it("`saveVerdicts` carimba o sha da seção quando recebe o snapshot", async () => {
      const content = spec("o defeito julgado.");
      const db = fakeDb([]);
      const n = await saveVerdicts(db as never, {
        projectId: "p1", autonomyRunId: "r1", validationRunId: "v1", model: "m",
        verdicts: [{
          fingerprint: "fp1", file: "modelo-dados.md", anchor: "## 4", severity: "blocker", title: "t",
          impact: "nao_impeditivo", reason: "motivo", factoryArtifact: "POST /x", accusation: "dano",
          stance: "acusacao", defense: "", times: 4, focusRounds: 3,
        }],
        shaByFile: new Map([["modelo-dados.md", "sha-abc"]]),
        snapshots: new Map([["modelo-dados.md", { sha: "sha-abc", content }]]),
      });
      expect(n).toBe(1);
      expect(db.calls[0].text).toContain("anchor_sha_at");
      expect(db.calls[0].values).toContain(anchorShaAt(content, "## 4"));
    });

    it("sem snapshot, `saveVerdicts` grava NULL — o parecer obsolesce como antes", async () => {
      const db = fakeDb([]);
      await saveVerdicts(db as never, {
        projectId: "p1", autonomyRunId: "r1", validationRunId: "v1", model: "m",
        verdicts: [{
          fingerprint: "fp1", file: "modelo-dados.md", anchor: "## 4", severity: "blocker", title: "t",
          impact: "nao_impeditivo", reason: "motivo", factoryArtifact: "POST /x", accusation: "dano",
          stance: "acusacao", defense: "", times: 4, focusRounds: 3,
        }],
        shaByFile: new Map([["modelo-dados.md", "sha-abc"]]),
      });
      expect(db.calls[0].values[18]).toBeNull();
    });
  });
});

describe("promotabilityReport — o que o humano lê antes de promover", () => {
  const LV = (o: Partial<LiveVerdict> = {}): LiveVerdict => ({
    fingerprint: "x", file: "modelo-dados.md", anchor: "## 4", impact: "nao_impeditivo",
    reason: "r", factoryArtifact: "a", stance: "acusacao", defense: "", stale: false,
    createdAt: "2026-09-07T12:00:00Z", ...o,
  });

  it("GAP liberado sai da conta de impeditivos e a spec fica promovível", () => {
    const f = F();
    const rep = promotabilityReport({
      findings: [f], verdicts: [LV({ fingerprint: findingFingerprint(f) })],
      unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
    });
    expect(rep).toMatchObject({ impeditive: 0, released: 1, promotable: true, blockers: [] });
  });

  it("sem veredicto, GAP importante segue impeditivo e bloqueia", () => {
    const rep = promotabilityReport({ findings: [F()], verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG });
    expect(rep.impeditive).toBe(1);
    expect(rep.promotable).toBe(false);
    expect(rep.blockers[0]).toMatch(/1 GAP\(s\) importante\(s\) seguem impeditivos/);
  });

  it("parecer OBSOLETO não libera nada — a anistia morre com o texto", () => {
    const f = F();
    const rep = promotabilityReport({
      findings: [f], verdicts: [LV({ fingerprint: findingFingerprint(f), stale: true })],
      unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
    });
    expect(rep).toMatchObject({ impeditive: 1, released: 0, promotable: false });
  });

  it("parecer impeditivo não libera (só `nao_impeditivo` conta)", () => {
    const f = F();
    const rep = promotabilityReport({
      findings: [f], verdicts: [LV({ fingerprint: findingFingerprint(f), impact: "impeditivo" })],
      unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
    });
    expect(rep.impeditive).toBe(1);
  });

  it("teto acumulado excedido ANULA todas as liberações — muitas rodadas não contornam o teto", () => {
    const many = Array.from({ length: 4 }, (_, i) => F({ anchor: `## ${i}`, title: `t${i}` }));
    const rep = promotabilityReport({
      findings: many,
      verdicts: many.map((f) => LV({ fingerprint: findingFingerprint(f) })),
      unroutedImportant: 0, unjudgedFiles: [], cfg: { ...CFG, maxPerSpec: 3 },
    });
    expect(rep).toMatchObject({ impeditive: 4, released: 0, promotable: false });
    expect(rep.blockers.some((b) => /teto acumulado de 3/.test(b))).toBe(true);
  });

  it("GAP importante sem arquivo atribuído bloqueia mesmo com tudo liberado", () => {
    const rep = promotabilityReport({ findings: [], verdicts: [], unroutedImportant: 2, unjudgedFiles: [], cfg: CFG });
    expect(rep.promotable).toBe(false);
    expect(rep.blockers[0]).toMatch(/sem arquivo atribuído/);
  });

  it("arquivo nunca julgado por inteiro bloqueia: aval da parte medida não vale pela não-medida", () => {
    const rep = promotabilityReport({ findings: [], verdicts: [], unroutedImportant: 0, unjudgedFiles: ["privacidade-lgpd.md"], cfg: CFG });
    expect(rep.promotable).toBe(false);
    expect(rep.blockers[0]).toMatch(/nunca julgado\(s\) por inteiro/);
  });

  it("GAP triado pelo humano não é impeditivo — triagem e veredicto são coisas diferentes", () => {
    const rep = promotabilityReport({
      findings: [F({ triage: { state: "ignored" } as unknown as EnrichedFinding["triage"] })],
      verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
    });
    expect(rep).toMatchObject({ impeditive: 0, promotable: true });
  });

  /**
   * 🔴 F2 — o Policy Gate entra por AQUI, e só numa direção.
   *
   * `arXiv:2609.04167` mede que 34% dos patches que passam nos testes violam constraints declaradas na
   * revisão: zero GAP importante não é o mesmo que "cumpriu o que foi pedido". Mas o gate não pode
   * virar rota de anistia — daí os dois testes espelhados abaixo.
   */
  it("constraint declarada violada BLOQUEIA uma spec que os GAPs já liberavam (buraco dos 34%)", () => {
    const rep = promotabilityReport({
      findings: [], verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
      policyViolations: 2, policyNote: "5/6 constraint(s) julgada(s) na spec, 3 cumprida(s)",
    });
    expect(rep.promotable).toBe(false);
    expect(rep.policyViolations).toBe(2);
    expect(rep.blockers[0]).toMatch(/2 constraint\(s\) declarada\(s\) violada\(s\) no Policy Gate/);
    // a nota do gate vai junto: dizer "2 violadas" sem a cobertura seria número sem premissa.
    expect(rep.blockers[0]).toMatch(/5\/6 constraint/);
  });

  it("🔴 o gate NUNCA libera: com GAP impeditivo de pé, zero violação de policy não promove", () => {
    const rep = promotabilityReport({
      findings: [F()], verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG,
      policyViolations: 0,
    });
    expect(rep.promotable).toBe(false);
    expect(rep.blockers[0]).toMatch(/GAP\(s\) importante\(s\) seguem impeditivos/);
    expect(rep.blockers.some((b) => /Policy Gate/.test(b))).toBe(false);
  });

  it("gate ausente (desligado ou incapaz de rodar) devolve o relatório EXATAMENTE de antes de F2", () => {
    const base = { findings: [], verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG };
    expect(promotabilityReport(base)).toEqual({ ...promotabilityReport({ ...base, policyViolations: 0 }) });
    expect(promotabilityReport(base)).toMatchObject({ promotable: true, policyViolations: 0 });
  });

  it("valor negativo ou fracionário não vira bloqueio fantasma nem libera nada", () => {
    const base = { findings: [], verdicts: [], unroutedImportant: 0, unjudgedFiles: [], cfg: CFG };
    expect(promotabilityReport({ ...base, policyViolations: -3 })).toMatchObject({ promotable: true, policyViolations: 0 });
    expect(promotabilityReport({ ...base, policyViolations: 1.7 })).toMatchObject({ promotable: false, policyViolations: 1 });
  });
});
