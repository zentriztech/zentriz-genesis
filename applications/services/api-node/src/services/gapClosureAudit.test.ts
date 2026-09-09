/**
 * 🔴 GAP-169 — o fechamento por SILÊNCIO do juiz.
 *
 * Medido em prod (NVX LastMile, 39 validações em 36 h): 56 ressurreições em 46 âncoras ⇒ **≥30% dos
 * fechamentos por ausência eram defeito VIVO**, e a única saída positiva do laço (`gaps.important === 0`)
 * lia justamente o conjunto de onde eles tinham sido removidos.
 *
 * Estes testes travam as três propriedades que a correção precisa ter, em ordem de importância:
 *   1. **fail-CLOSED** — sem prova, o candidato continua ATIVO (nunca resolvido);
 *   2. **monotonicidade** — a mudança não pode criar nenhum fechamento que já não acontecesse;
 *   3. **honestidade do log** — o que não foi verificado aparece, e o que foi "absolvido" sem citação
 *      verbatim não conta como fechado.
 */
import { describe, it, expect, afterEach } from "vitest";
import { orderClosureCandidates, describeClosureAudit, type ClosureAuditResult } from "./gapClosureAudit.js";
import { surveyFindings, findingFingerprint, loadClosureProofs, type ClosureCandidate } from "./findingTriage.js";
import type { ValidationFinding } from "./specValidation.js";

const F = (o: Partial<ValidationFinding>): ValidationFinding => ({
  file: "spec.md", line: null, severity: "warning", title: "t", rationale: "",
  source: "stage_b", category: "other", anchor: null, ...o,
});
const cov = (...judged: string[]) => ({ judged });

const gA = F({ file: "a.md", title: "GAP de A", anchor: "§1" });

/** Três runs: o GAP apareceu na mais antiga e as duas seguintes julgaram o arquivo e calaram. */
const runsComSilencio = [
  { id: "r3", created_at: "3", findings: [], coverage: cov("a.md") },
  { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
  { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
];

describe("GAP-169 — ausência do juiz ELEGE candidato, não fecha", () => {
  it("🔴 sem prova: o GAP continua ATIVO e vira candidato (fail-CLOSED)", () => {
    const s = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: new Set() });
    // O ponto inteiro da onda: era `resolved` aqui, e era esse salto que fabricava os 30%.
    expect(s.resolved).toEqual([]);
    expect(s.active.map((f) => f.title)).toEqual(["GAP de A"]);
    expect(s.closureCandidates.map((c) => ({ fp: c.fingerprint, n: c.absentRuns }))).toEqual([
      { fp: findingFingerprint(gA), n: 2 },
    ]);
  });

  it("🔴 com prova do auditor de outra família: fecha, e o motivo fica REGISTRADO como prova", () => {
    const s = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: new Set([findingFingerprint(gA)]) });
    expect(s.active).toEqual([]);
    expect(s.closureCandidates).toEqual([]);
    // `closedBy` existe para que ninguém confunda depois um fechamento provado com um inferido.
    expect(s.resolved.map((r) => ({ t: r.title, by: r.closedBy }))).toEqual([{ t: "GAP de A", by: "proof" }]);
  });

  it("prova de OUTRO finding não absolve este (a régua é o fingerprint, não a boa vontade)", () => {
    const s = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: new Set(["fingerprint-de-outro-gap"]) });
    expect(s.resolved).toEqual([]);
    expect(s.closureCandidates).toHaveLength(1);
  });

  it("⚖️ `proven: null` = comportamento LEGADO — o silêncio fecha, e o `closedBy` DIZ que foi silêncio", () => {
    // Este é o caminho de quem não tem auditor no ambiente (`SPEC_CROSS_AUDIT != on`). Exigir prova onde
    // ninguém pode produzi-la deixaria todo finding de stage_b ativo para sempre. O erro fica visível no
    // `closedBy`, em vez de virar um fechamento indistinguível dos provados.
    const s = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: null });
    expect(s.resolved.map((r) => ({ t: r.title, by: r.closedBy }))).toEqual([{ t: "GAP de A", by: "silence" }]);
    expect(s.closureCandidates).toEqual([]);
    // e o default (nenhum opts) tem de ser o MESMO legado, senão um chamador antigo muda de
    // comportamento sem ninguém decidir.
    expect(surveyFindings(runsComSilencio, new Set(["a.md"])).resolved).toHaveLength(1);
  });

  it("🔴 `stage_a` fecha por ausência mesmo com auditor ligado — é programa determinístico, não juiz", () => {
    // Ele relê a spec inteira em toda run; auditar isso com LLM seria pagar para reconfirmar aritmética.
    const sa = F({ file: "a.md", source: "stage_a", severity: "blocker", title: "Spec sem manifesto" });
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [sa], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["a.md"]), { proven: new Set() });
    expect(s.resolved.map((r) => ({ t: r.title, by: r.closedBy }))).toEqual([{ t: "Spec sem manifesto", by: "deterministic" }]);
    expect(s.closureCandidates).toEqual([]);
  });

  it("🔴 arquivo REMOVIDO fecha sem auditor: é fato verificável, não inferência", () => {
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("b.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["b.md"]), { proven: new Set() });
    expect(s.resolved.map((r) => ({ by: r.closedBy, rm: r.fileRemoved }))).toEqual([{ by: "removal", rm: true }]);
  });

  it("⚖️ MONOTONICIDADE: exigir prova nunca fecha algo que o legado deixava aberto", () => {
    // Propriedade central do desenho. Para o mesmo conjunto de runs, o resultado com prova é sempre um
    // SUBCONJUNTO do resultado legado — a mudança só aperta. Se este teste cair, a onda virou anistia.
    const legado = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: null });
    const comProva = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: new Set([findingFingerprint(gA)]) });
    const semProva = surveyFindings(runsComSilencio, new Set(["a.md"]), { proven: new Set() });
    const fps = (s: { resolved: Array<{ fingerprint: string }> }) => new Set(s.resolved.map((r) => r.fingerprint));
    for (const s of [comProva, semProva]) {
      for (const fp of fps(s)) expect(fps(legado).has(fp)).toBe(true);
    }
  });

  it("🔴 finding que o auditor NÃO PODE examinar não fica eterno: volta ao legado, rotulado", () => {
    // O buraco que quase entrou: `crossFamilyAudit` descarta finding sem âncora e `info` (não há trecho
    // a recortar / não muda decisão). Se o survey exigisse prova deles, ficariam ATIVOS para sempre —
    // sem nenhum caminho possível para fechar. É o estado eterno da família do GAP-84.
    const semAncora = F({ file: "a.md", title: "GAP sem endereço", anchor: null, severity: "blocker" });
    const infoGap = F({ file: "a.md", title: "GAP de baixo risco", anchor: "§9", severity: "info" });
    const runs = [
      { id: "r3", created_at: "3", findings: [], coverage: cov("a.md") },
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [semAncora, infoGap], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["a.md"]), { proven: new Set() });
    expect(s.closureCandidates).toEqual([]);
    expect(s.active).toEqual([]);
    expect(s.resolved.map((r) => ({ t: r.title, by: r.closedBy })).sort((a, b) => a.t.localeCompare(b.t))).toEqual([
      { t: "GAP de baixo risco", by: "silence" },
      { t: "GAP sem endereço", by: "silence" },
    ]);
  });

  it("limbo de 1 ausência não é candidato (o anti-flapping do RFC-0005 continua de pé)", () => {
    const runs = [
      { id: "r2", created_at: "2", findings: [], coverage: cov("a.md") },
      { id: "r1", created_at: "1", findings: [gA], coverage: cov("a.md") },
    ];
    const s = surveyFindings(runs, new Set(["a.md"]), { proven: new Set() });
    expect(s.resolved).toEqual([]);
    expect(s.active).toEqual([]);          // limbo: nem ativo, nem resolvido — preservado
    expect(s.closureCandidates).toEqual([]);
  });
});

describe("loadClosureProofs — as quatro condições, todas necessárias", () => {
  const flag = process.env.SPEC_CROSS_AUDIT;
  afterEach(() => { if (flag === undefined) delete process.env.SPEC_CROSS_AUDIT; else process.env.SPEC_CROSS_AUDIT = flag; });

  const fakeDb = (rows: Array<Record<string, unknown>>, sql: string[] = []) => ({
    query: async (text: string) => { sql.push(text); return { rows }; },
  });

  it("⚖️ auditor DESLIGADO ⇒ `null` (legado) e nenhuma consulta — não se exige prova de quem não pode provar", async () => {
    process.env.SPEC_CROSS_AUDIT = "off";
    const sql: string[] = [];
    expect(await loadClosureProofs(fakeDb([], sql), "p1")).toBeNull();
    expect(sql).toEqual([]);
  });

  it("auditor LIGADO ⇒ conjunto de fingerprints provados", async () => {
    process.env.SPEC_CROSS_AUDIT = "on";
    const sql: string[] = [];
    const got = await loadClosureProofs(fakeDb([{ fingerprint: "fp1" }, { fingerprint: "fp2" }], sql), "p1");
    expect(got).toEqual(new Set(["fp1", "fp2"]));
    // As quatro condições vivem no SQL; se alguma cair, um "ausente" sem prova ou de um sha VELHO
    // passaria a fechar GAP — exatamente o defeito que esta onda mata.
    const q = sql[0];
    expect(q).toContain("a.purpose = 'fechamento'");
    expect(q).toContain("a.verdict = 'ausente'");
    expect(q).toContain("a.evidence_verbatim = true");
    expect(q).toContain("f.content_sha256 = a.file_sha_at");
  });

  it("🔴 erro de banco ⇒ conjunto VAZIO, nunca `null`: falha de leitura não pode virar absolvição", async () => {
    process.env.SPEC_CROSS_AUDIT = "on";
    const db = { query: async () => { throw new Error("boom"); } };
    // `null` aqui reativaria o legado (silêncio fecha) na pior hora possível — quando não se sabe nada.
    expect(await loadClosureProofs(db, "p1")).toEqual(new Set());
  });
});

describe("orderClosureCandidates", () => {
  const C = (severity: ValidationFinding["severity"], absentRuns: number, title: string): ClosureCandidate => ({
    fingerprint: title, finding: F({ severity, title }), absentRuns, lastSeenRunId: "r", lastSeenAt: "1",
  });

  it("🔴 blocker antes de warning; dentro da severidade, o mais ANTIGO primeiro", () => {
    // O teto por rodada só é honesto se a fila for por consequência: blocker trava a promoção, e o
    // candidato mais velho é o que há mais tempo está mentindo na contagem.
    const ord = orderClosureCandidates([
      C("warning", 9, "w-velho"), C("blocker", 2, "b-novo"), C("info", 30, "i"), C("blocker", 7, "b-velho"),
    ]);
    expect(ord.map((c) => c.fingerprint)).toEqual(["b-velho", "b-novo", "w-velho", "i"]);
  });

  it("não muta a lista recebida", () => {
    const orig = [C("warning", 1, "a"), C("blocker", 1, "b")];
    orderClosureCandidates(orig);
    expect(orig.map((c) => c.fingerprint)).toEqual(["a", "b"]);
  });
});

describe("describeClosureAudit — o log não pode prometer mais do que fechou", () => {
  const R = (o: Partial<ClosureAuditResult>): ClosureAuditResult => ({
    ran: true, audited: 3, fechados: 1, ausenteSemProva: 0, reabertos: 1, indecidiveis: 1,
    sobraram: 0, falhas: 0, model: "amazon.nova-pro-v1:0", ...o,
  });

  it("diz os quatro destinos, não só o número bom", () => {
    const s = describeClosureAudit(R({}));
    expect(s).toContain("3 candidato(s) verificado(s) por amazon.nova-pro-v1:0");
    expect(s).toContain("**1 fechado(s) COM prova**");
    expect(s).toContain("1 REABERTO(s)");
    expect(s).toContain("1 indecidível(is)");
  });

  it("🔴 o que sobrou do teto é DECLARADO e dito como AINDA ATIVO (cortar é ok, cortar em silêncio não)", () => {
    expect(describeClosureAudit(R({ sobraram: 82 }))).toContain("82 candidato(s) ficaram para a próxima rodada e seguem ATIVOS");
  });

  it("🔴 `ausente` sem citação verbatim aparece como NÃO fechado — senão o log absolve por opinião", () => {
    const s = describeClosureAudit(R({ fechados: 0, ausenteSemProva: 2 }));
    expect(s).toContain('2 disse(ram) "ausente" SEM citação verbatim — não fecha');
    expect(s).toContain("**0 fechado(s) COM prova**");
  });

  it("não rodou: diz o motivo em vez de sugerir que estava tudo limpo", () => {
    expect(describeClosureAudit(R({ ran: false, reason: "SPEC_CROSS_AUDIT != on" })))
      .toBe("verificação de fechamento não rodou — SPEC_CROSS_AUDIT != on.");
    expect(describeClosureAudit(R({ ran: false, reason: undefined }))).toContain("motivo não declarado");
  });
});
