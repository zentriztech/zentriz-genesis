/**
 * A1 — desfecho nomeado por GAP despachado.
 *
 * O que estes testes travam é o CONTRATO, não a prosa do prompt: número fora da lista não vira
 * desfecho, verbo inventado não vira desfecho, GAP não citado fica `nao_declarado` (nunca
 * "corrigido"), e `corrigido` sem edição ancarada aplicada sai CONTESTADO. E o relato só volta ao
 * agente quando fala de um GAP que a rodada nova está de fato mandando.
 */
import { describe, it, expect, vi } from "vitest";
import {
  GAP_OUTCOME_VERBS, parseGapOutcomes, extractOutcomeBlock, summarizeOutcomes,
  selectPriorOutcomes, priorOutcomeFactBlock, gapOutcomeInstruction, lastDeclaredOutcomes,
  declaredAttemptHistory, selectAttemptHistory, attemptHistoryFactBlock,
  ATTEMPT_HISTORY_GAPS, ATTEMPT_HISTORY_VIAS, ATTEMPT_NOTE_MAX,
  type GapOutcome,
} from "./gapOutcomes.js";
import type { ValidationFinding } from "./specValidation.js";

function f(over: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    file: "privacidade-lgpd.md",
    line: null,
    severity: "blocker",
    title: "Reexecução de eliminação define dois pares (code, HTTP) incompatíveis",
    rationale: "§3.1 diz 409 e §7 diz 422",
    source: "stage_b",
    category: "contradiction",
    anchor: "§3.1 POST /api/privacy/erasure-requests",
    ...over,
  };
}

/** Três GAPs distintos (âncoras diferentes ⇒ fingerprints diferentes). */
const TRES = [
  f(),
  f({ anchor: "§7 Retenção", title: "Prazo de retenção sem unidade" }),
  f({ file: "modelo-dados.md", anchor: "§2 Entidades", title: "Entidade sem chave primária" }),
];

const bloco = (...linhas: string[]) => ["--- DESFECHO DOS GAPS ---", ...linhas, "--- FIM DO DESFECHO ---"].join("\n");

describe("A1 — parseGapOutcomes", () => {
  it("lê um verbo por GAP e guarda a nota crua do agente", () => {
    const r = parseGapOutcomes(
      bloco(
        "1) corrigido: passei a citar o oráculo em vez de redeclarar o contrato",
        "2) permanece_aberto: o valor normativo mora em outro arquivo",
        "3) nao_e_deste_arquivo: pertence a contratos-erros.md",
      ),
      TRES,
      { appliedEdits: 2 },
    );
    expect(r.ran).toBe(true);
    expect(r.rejected).toEqual([]);
    expect(r.outcomes.map((o) => o.verb)).toEqual(["corrigido", "permanece_aberto", "nao_e_deste_arquivo"]);
    expect(r.outcomes[1].note).toBe("o valor normativo mora em outro arquivo");
    expect(r.outcomes.every((o) => o.contested === null)).toBe(true);
  });

  it("GAP não citado fica `nao_declarado` — nunca `corrigido` por omissão", () => {
    const r = parseGapOutcomes(bloco("1) corrigido: fechei"), TRES, { appliedEdits: 1 });
    expect(r.outcomes.map((o) => o.verb)).toEqual(["corrigido", "nao_declarado", "nao_declarado"]);
    expect(summarizeOutcomes(r.outcomes)).toEqual({ corrigido: 1, nao_declarado: 2 });
  });

  it("bloco ausente ⇒ `ran: false` e TODOS `nao_declarado` (o desfecho é gravado assim mesmo)", () => {
    const r = parseGapOutcomes("só os blocos de edição, sem prestação de contas", TRES, { appliedEdits: 3 });
    expect(r.ran).toBe(false);
    expect(r.outcomes).toHaveLength(3);
    expect(r.outcomes.every((o) => o.verb === "nao_declarado")).toBe(true);
  });

  it("VETO: número fora da lista despachada é recusado com motivo", () => {
    const r = parseGapOutcomes(bloco("1) corrigido: ok", "9) corrigido: inventado"), TRES, { appliedEdits: 1 });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].why).toMatch(/não estava nesta lista/);
    expect(r.outcomes[0].verb).toBe("corrigido");
    expect(r.outcomes.filter((o) => o.verb === "corrigido")).toHaveLength(1);
  });

  it("VETO: número repetido — vale a primeira declaração e a segunda é recusada", () => {
    const r = parseGapOutcomes(bloco("1) permanece_aberto: não consegui", "1) corrigido: pensando bem, fechei"), TRES, { appliedEdits: 1 });
    expect(r.outcomes[0].verb).toBe("permanece_aberto");
    expect(r.rejected[0].why).toMatch(/mais de uma vez/);
  });

  it("VETO: verbo fora do vocabulário fechado não vira desfecho", () => {
    const r = parseGapOutcomes(bloco("1) parcialmente_corrigido: metade"), TRES, { appliedEdits: 1 });
    expect(r.outcomes[0].verb).toBe("nao_declarado");
    expect(r.rejected[0].why).toMatch(/fora do vocabulário fechado/);
  });

  it("VETO: `corrigido` com ZERO edição ancarada aplicada sai CONTESTADO (sem ser anulado)", () => {
    const r = parseGapOutcomes(bloco("1) corrigido: reescrevi a seção"), TRES, { appliedEdits: 0 });
    // O desfecho do agente PERMANECE — quem julga não é o código. Mas a contradição fica ao lado.
    expect(r.outcomes[0].verb).toBe("corrigido");
    expect(r.outcomes[0].contested).toMatch(/sem nenhuma edição ancorada/);
    expect(summarizeOutcomes(r.outcomes).contestados).toBe(1);
  });

  it("`permanece_aberto` com zero edição NÃO é contestado (é declaração coerente)", () => {
    const r = parseGapOutcomes(bloco("1) permanece_aberto: não achei o trecho"), TRES, { appliedEdits: 0 });
    expect(r.outcomes[0].contested).toBeNull();
  });

  it("linha fora do formato é recusada sem contaminar os demais desfechos", () => {
    const r = parseGapOutcomes(bloco("resolvi tudo, confia", "2) corrigido: fechei o 2"), TRES, { appliedEdits: 1 });
    expect(r.rejected[0].why).toMatch(/fora do formato/);
    expect(r.outcomes[1].verb).toBe("corrigido");
  });

  it("aceita `1.` e `1 -` como separador de número e trava a lista de verbos", () => {
    const r = parseGapOutcomes(bloco("1. corrigido: ok", "2 - permanece_aberto: não deu"), TRES, { appliedEdits: 1 });
    expect(r.outcomes.map((o) => o.verb)).toEqual(["corrigido", "permanece_aberto", "nao_declarado"]);
    expect(GAP_OUTCOME_VERBS).toEqual(["corrigido", "permanece_aberto", "nao_e_deste_arquivo", "nao_e_defeito"]);
  });

  it("grava o fingerprint de cada GAP (identidade, para o relato voltar sem casar título)", () => {
    const r = parseGapOutcomes(bloco("1) corrigido: ok"), TRES, { appliedEdits: 1 });
    const fps = new Set(r.outcomes.map((o) => o.fingerprint));
    expect(fps.size).toBe(3);
    expect(r.outcomes.every((o) => o.fingerprint.length > 0)).toBe(true);
  });

  it("nota longa é cortada (o desfecho não é canal de prosa)", () => {
    const r = parseGapOutcomes(bloco(`1) permanece_aberto: ${"x".repeat(2000)}`), TRES, { appliedEdits: 0 });
    expect(r.outcomes[0].note.length).toBe(600);
  });
});

describe("A1 — extractOutcomeBlock", () => {
  it("o ÚLTIMO bloco vence (o modelo às vezes ecoa o exemplo do enunciado antes de responder)", () => {
    const texto = [
      bloco("1) corrigido: EXEMPLO do enunciado"),
      "…blocos de edição…",
      bloco("1) permanece_aberto: resposta de verdade"),
    ].join("\n");
    expect(extractOutcomeBlock(texto)?.join("\n")).toContain("resposta de verdade");
  });

  it("bloco aberto e nunca fechado (resposta cortada) ainda entrega o que chegou", () => {
    const r = extractOutcomeBlock("--- DESFECHO DOS GAPS ---\n1) corrigido: ok");
    expect(r).toEqual(["1) corrigido: ok"]);
  });

  it("sem bloco ⇒ null", () => {
    expect(extractOutcomeBlock("nada aqui")).toBeNull();
  });
});

describe("A1 — selectPriorOutcomes + priorOutcomeFactBlock", () => {
  const prior = parseGapOutcomes(
    bloco("1) permanece_aberto: o valor mora em outro arquivo", "2) nao_e_defeito: a norma já está no §9", "3) corrigido: fechei"),
    TRES,
    { appliedEdits: 1 },
  ).outcomes;

  it("só volta o relato de GAP que ESTA rodada está mandando (casamento por fingerprint)", () => {
    const sel = selectPriorOutcomes(prior, [TRES[0]]);
    expect(sel).toHaveLength(1);
    expect(sel[0].verb).toBe("permanece_aberto");
  });

  it("desfecho sem fingerprint algum (gravado antes dos campos existirem) é IGNORADO", () => {
    const legado = prior.map((o) => ({ ...o, fingerprint: "", titleFingerprint: "" })) as GapOutcome[];
    expect(selectPriorOutcomes(legado, TRES)).toEqual([]);
  });

  it("colisão de âncora: dois GAPs distintos na MESMA seção recebem identidades DIFERENTES", () => {
    // Medido em prod (17 de 98 runs): `file|source|anchor` é o mesmo para defeitos distintos da mesma
    // seção. Se a identidade colidisse, o relato de um voltaria colado no outro.
    const colididos = [
      f({ anchor: "§11.3", title: "Job de retenção depende de infraestrutura inexistente" }),
      f({ anchor: "§11.3", title: "Etapa C referencia 'o ADMIN corrente' como requester" }),
    ];
    const r = parseGapOutcomes(bloco("1) permanece_aberto: falta o worker", "2) nao_e_deste_arquivo: vai em contratos.md"), colididos, { appliedEdits: 0 });
    expect(new Set(r.outcomes.map((o) => o.fingerprint)).size).toBe(2);
    // E o relato volta para o GAP certo, não para o vizinho.
    const sel = selectPriorOutcomes(r.outcomes, colididos);
    expect(sel).toHaveLength(2);
    expect(priorOutcomeFactBlock(selectPriorOutcomes(r.outcomes, [colididos[0]]))).toContain("Job de retenção");
  });

  it("relato AMBÍGUO (dois desfechos casando o mesmo GAP) não volta — relato errado é pior que nenhum", () => {
    const um = parseGapOutcomes(bloco("1) permanece_aberto: tentativa A"), [TRES[0]], { appliedEdits: 0 }).outcomes;
    const dois = parseGapOutcomes(bloco("1) nao_e_defeito: argumento B"), [TRES[0]], { appliedEdits: 0 }).outcomes;
    expect(selectPriorOutcomes([...um, ...dois], [TRES[0]])).toEqual([]);
  });

  it("o bloco entrega `permanece_aberto`, `nao_e_defeito` e `corrigido` CONTESTADO — e nada mais", () => {
    const contestado = parseGapOutcomes(bloco("3) corrigido: fechei"), TRES, { appliedEdits: 0 }).outcomes;
    const txt = priorOutcomeFactBlock([...prior.slice(0, 2), contestado[2]]);
    expect(txt).toContain("PERMANECE ABERTO");
    expect(txt).toContain("NÃO É DEFEITO");
    expect(txt).toContain("NENHUMA edição foi aplicada");
    expect(txt).toContain("tente uma DIFERENTE");
  });

  it("A2: `corrigido` DESMENTIDO pelo juiz volta ao agente com a via que falhou", () => {
    const limpos = parseGapOutcomes(bloco("3) corrigido: removi o critério (iii)"), TRES, { appliedEdits: 2 }).outcomes;
    const desmentido = limpos.map((o) => (o.verb === "corrigido" ? { ...o, refutedByJudge: true } : o));
    const txt = priorOutcomeFactBlock(desmentido);
    expect(txt).toContain("a edição FOI aplicada");
    expect(txt).toContain("CONTINUA nesta âncora");
    expect(txt).toContain("removi o critério (iii)");
    expect(txt).not.toContain("NENHUMA edição foi aplicada");
  });

  it("`corrigido` limpo e `nao_declarado` não geram bloco (nada a cobrar ⇒ nenhum token pago)", () => {
    const limpos = parseGapOutcomes(bloco("3) corrigido: fechei"), TRES, { appliedEdits: 2 }).outcomes;
    expect(priorOutcomeFactBlock(limpos)).toBe("");
    expect(priorOutcomeFactBlock(null)).toBe("");
    expect(priorOutcomeFactBlock([])).toBe("");
  });
});

describe("A1 — gapOutcomeInstruction", () => {
  it("declara o vocabulário fechado e as duas regras que evitam fechamento fake", () => {
    const txt = gapOutcomeInstruction(7);
    for (const v of GAP_OUTCOME_VERBS) expect(txt).toContain(v);
    expect(txt).toContain("7 GAPs");
    // As duas regras que existem para o desfecho não virar caneta de fechar GAP.
    expect(txt).toContain("`nao_e_defeito` NÃO apaga o GAP");
    expect(txt).toContain("NÃO DECLARADO");
  });
});

describe("A1 — lastDeclaredOutcomes", () => {
  it("A2: `corrigido` limpo vira DESMENTIDO só quando uma validação rodou depois da declaração", async () => {
    const outs = [
      { index: 1, verb: "corrigido", contested: null },
      { index: 2, verb: "corrigido", contested: "declarou sem edição" },
      { index: 3, verb: "permanece_aberto", contested: null },
    ];
    const depois = { query: vi.fn().mockResolvedValue({ rows: [{ gap_outcomes: outs, judged_after: true }] }) };
    const r1 = (await lastDeclaredOutcomes(depois, "p", "a.md"))!;
    expect(r1.map((o) => o.refutedByJudge)).toEqual([true, undefined, undefined]);
    // Duas rodadas no MESMO passe (sem revalidação entre elas) ⇒ ninguém foi desmentido.
    const antes = { query: vi.fn().mockResolvedValue({ rows: [{ gap_outcomes: outs, judged_after: false }] }) };
    const r2 = (await lastDeclaredOutcomes(antes, "p", "a.md"))!;
    expect(r2.every((o) => !o.refutedByJudge)).toBe(true);
  });

  it("devolve o array do último job que pediu contas neste arquivo", async () => {
    const rows = [{ gap_outcomes: [{ index: 1, verb: "permanece_aberto" }], judged_after: false }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) };
    const r = await lastDeclaredOutcomes(db, "p1", "privacidade-lgpd.md");
    expect(r).toHaveLength(1);
    const sql = db.query.mock.calls[0][0] as string;
    // Case-insensitive no path e o mais RECENTE primeiro: o relato é o da última rodada, não o de uma
    // rodada qualquer do histórico.
    expect(sql).toMatch(/lower\(j\.file_path\) = lower\(\$2\)/);
    expect(sql).toMatch(/ORDER BY j\.created_at DESC/);
  });

  it("nenhum job / valor não-array / falha de banco ⇒ null (o laço não afirma nada ao agente)", async () => {
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockResolvedValue({ rows: [] }) }, "p", "a.md")).toBeNull();
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockResolvedValue({ rows: [{ gap_outcomes: {} }] }) }, "p", "a.md")).toBeNull();
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockRejectedValue(new Error("boom")) }, "p", "a.md")).toBeNull();
  });
});

/**
 * 🔴 GAP-131 — a memória de tentativas tinha PROFUNDIDADE 1.
 *
 * Medido em prod (NVX LastMile): agrupando desfechos por `fingerprint`, o MESMO GAP foi declarado
 * `corrigido` 8× (`visao-escopo.md §1.3`), 6× em três outros, ≥3× em quinze; e `modelo-dados.md §7.2`
 * teve 4 de 4 rodadas com o aviso "trecho apontado ficou IDÊNTICO". `lastDeclaredOutcomes` lê UM job,
 * então o agente nunca soube quais vias já havia tentado.
 */
describe("🔴 GAP-131 — declaredAttemptHistory", () => {
  /** Dois jobs (o SQL devolve DESC: o mais novo primeiro) sobre o mesmo GAP. */
  const jobs = (fp = "fp-a") => [
    { gap_outcomes: [{ index: 1, verb: "corrigido", note: "via NOVA: reescrevi a tabela", contested: null, fingerprint: fp, titleFingerprint: "t-a", title: "Título de hoje", anchor: "§1.3" }] },
    { gap_outcomes: [{ index: 1, verb: "corrigido", note: "via ANTIGA: troquei o 409 por 422", contested: null, fingerprint: fp, titleFingerprint: "t-a", title: "Título de ontem", anchor: "§1.3" }] },
  ];

  it("junta as tentativas do MESMO fingerprint em ordem CRONOLÓGICA (a mais antiga primeiro)", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: jobs() }) };
    const h = await declaredAttemptHistory(db, "p1", "visao-escopo.md");
    expect(h).toHaveLength(1);
    expect(h[0].attempts.map((a) => a.note)).toEqual([
      "via ANTIGA: troquei o 409 por 422",
      "via NOVA: reescrevi a tabela",
    ]);
    // Título/âncora do relato mais RECENTE — é como o GAP se chama hoje.
    expect(h[0].title).toBe("Título de hoje");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/ORDER BY created_at DESC LIMIT \$3/);
    expect(sql).toMatch(/lower\(file_path\) = lower\(\$2\)/);
  });

  it("`nao_declarado` e desfecho sem fingerprint NÃO entram (ninguém tentou nada)", async () => {
    const rows = [{ gap_outcomes: [
      { index: 1, verb: "nao_declarado", note: "", fingerprint: "fp-a", titleFingerprint: "t-a", title: "T", anchor: null },
      { index: 2, verb: "corrigido", note: "x", fingerprint: "", titleFingerprint: "", title: "T2", anchor: null },
    ] }];
    const h = await declaredAttemptHistory({ query: vi.fn().mockResolvedValue({ rows }) }, "p1", "a.md");
    expect(h).toEqual([]);
  });

  it("falha de banco / valor não-array ⇒ [] (ler o histórico nunca derruba a rodada)", async () => {
    expect(await declaredAttemptHistory({ query: vi.fn().mockRejectedValue(new Error("boom")) }, "p", "a.md")).toEqual([]);
    expect(await declaredAttemptHistory({ query: vi.fn().mockResolvedValue({ rows: [{ gap_outcomes: {} }] }) }, "p", "a.md")).toEqual([]);
  });
});

describe("🔴 GAP-131 — selectAttemptHistory + attemptHistoryFactBlock", () => {
  const cadeia = (over = {}) => ({
    fingerprint: "x", titleFingerprint: "tx", title: "GAP teimoso", anchor: "§1.3",
    attempts: [
      { verb: "corrigido" as const, note: "primeira via", contested: null },
      { verb: "corrigido" as const, note: "segunda via", contested: null },
    ],
    ...over,
  });

  it("cadeia só volta para GAP que a rodada está mandando, e basta UMA via já tentada (GAP-132)", () => {
    const alvo = f();
    const { outcomes } = parseGapOutcomes(bloco("1) corrigido: fechei"), [alvo], { appliedEdits: 1 });
    const fp = outcomes[0].fingerprint;
    const comDuas = cadeia({ fingerprint: fp, titleFingerprint: outcomes[0].titleFingerprint });
    expect(selectAttemptHistory([comDuas], [alvo])).toHaveLength(1);
    // GAP-132 (MEDIDO em prod): com piso 2, 10 de 13 arquivos recebiam ZERO via, porque a rodada
    // dedicada rotaciona entre 6–9 GAPs. Uma via refutada já é fato — o GAP está sendo despachado
    // AGORA, logo a validação posterior àquela tentativa o manteve.
    const comUma = { ...comDuas, attempts: comDuas.attempts.slice(0, 1) };
    expect(selectAttemptHistory([comUma], [alvo])).toHaveLength(1);
    // Zero via declarada: não há o que dizer (e `nao_declarado` nunca entra na cadeia).
    expect(selectAttemptHistory([{ ...comDuas, attempts: [] }], [alvo])).toEqual([]);
    // GAP de outro arquivo/âncora não casa: cadeia colada no GAP errado seria falso positivo.
    expect(selectAttemptHistory([cadeia()], [alvo])).toEqual([]);
  });

  it("mais teimoso primeiro (ordena por número de tentativas)", () => {
    const alvos = [f(), f({ anchor: "§9 Outro", title: "Outro GAP" })];
    const { outcomes } = parseGapOutcomes(bloco("1) corrigido: a", "2) corrigido: b"), alvos, { appliedEdits: 1 });
    const tres = cadeia({ fingerprint: outcomes[0].fingerprint, titleFingerprint: outcomes[0].titleFingerprint,
      attempts: [1, 2, 3].map((n) => ({ verb: "corrigido" as const, note: `via ${n}`, contested: null })) });
    const duas = cadeia({ fingerprint: outcomes[1].fingerprint, titleFingerprint: outcomes[1].titleFingerprint });
    const sel = selectAttemptHistory([duas, tres], alvos);
    expect(sel.map((h) => h.attempts.length)).toEqual([3, 2]);
  });

  it("sem cadeia nenhuma o bloco é VAZIO (bloco vazio no prompt seria ruído pago)", () => {
    expect(attemptHistoryFactBlock([])).toBe("");
    expect(attemptHistoryFactBlock(null)).toBe("");
  });

  it("o bloco diz quantas vias já falharam, cita cada uma e lista as SAÍDAS legítimas", () => {
    const b = attemptHistoryFactBlock([cadeia()]);
    expect(b).toContain("2 tentativa(s) anterior(es), NENHUMA fechou o GAP");
    expect(b).toContain("1ª via");
    expect(b).toContain("primeira via");
    expect(b).toContain("2ª via");
    expect(b).toContain("nao_e_deste_arquivo");
    expect(b).toContain("nao_e_defeito");
    expect(b).toContain("DENTRO do trecho ancorado");
  });

  it("corte de vias e corte de GAPs são DECLARADOS (GAP-128/129: teto pode existir, silêncio não)", () => {
    const muitasVias = cadeia({
      attempts: Array.from({ length: ATTEMPT_HISTORY_VIAS + 3 }, (_, i) => ({ verb: "corrigido" as const, note: `via ${i + 1}`, contested: null })),
    });
    const b = attemptHistoryFactBlock([muitasVias]);
    expect(b).toContain(`CORTADO: ${ATTEMPT_HISTORY_VIAS} de ${ATTEMPT_HISTORY_VIAS + 3} vias`);
    // Mantém as MAIS RECENTES e a numeração continua sendo a real (não reinicia em 1ª).
    expect(b).toContain(`${ATTEMPT_HISTORY_VIAS + 3}ª via`);
    // As cortadas somem de verdade: a 1ª e a 3ª via não aparecem como linha própria.
    expect(b).not.toContain("\n    1ª via");
    expect(b).not.toContain("\n    3ª via");
    expect(b).toContain(`${ATTEMPT_HISTORY_VIAS + 3 - ATTEMPT_HISTORY_VIAS + 1}ª via`);

    const muitosGaps = Array.from({ length: ATTEMPT_HISTORY_GAPS + 2 }, (_, i) => cadeia({ fingerprint: `x${i}`, title: `GAP ${i}` }));
    const b2 = attemptHistoryFactBlock(muitosGaps);
    expect(b2).toContain(`CORTADO: ${ATTEMPT_HISTORY_GAPS} de ${ATTEMPT_HISTORY_GAPS + 2} GAPs`);
  });

  it("nota longa vai cortada COM declaração (não faz o agente defender frase que não é dele)", () => {
    const b = attemptHistoryFactBlock([cadeia({
      attempts: [
        { verb: "corrigido", note: "z".repeat(ATTEMPT_NOTE_MAX + 200), contested: null },
        { verb: "permanece_aberto", note: "curta", contested: "declarou corrigido sem edição" },
      ],
    })]);
    expect(b).toContain("CORTADO");
    expect(b).toContain(String(ATTEMPT_NOTE_MAX + 200));
    // Contestação do código viaja colada na via — é fato verificável, não opinião.
    expect(b).toContain("[contestado pelo código: declarou corrigido sem edição]");
  });
});
