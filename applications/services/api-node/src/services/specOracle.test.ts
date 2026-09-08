/**
 * Testes do F3 (oráculo executável). O que eles guardam é o que já foi medido custar em prod:
 *
 *  * "nada a rodar" nunca vira "tudo cumprido" (GAP-42/43 aplicado à execução);
 *  * citação inventada não satisfaz e não acusa (Context Integrity);
 *  * suíte verde não satisfaz constraint que nenhum teste exercita (arXiv:2609.04167, os 34%);
 *  * veredicto de oráculo só ACRESCENTA impedimento — nunca revisa o que o juiz de spec decidiu.
 */
import { describe, expect, it } from "vitest";
import {
  applyOracleVerdicts, loadOracleFindings, normalizeOracleRun, normalizeOracleVerdicts, oracleEnvSha,
  oracleFindings, oracleNote, oracleOutcome, oracleReport, type OracleRun,
} from "./specOracle.js";
import { policyTally, type PolicyVerdict, type SpecConstraint } from "./specPolicyGate.js";
import type { ValidationFinding } from "./specValidation.js";

function run(over: Partial<OracleRun> = {}): OracleRun {
  return {
    stack: "node", cmd: "npm test", exitCode: 0, passed: 10, failed: 0, skipped: 0, total: 10,
    noTests: false, status: "ok", testsReliable: true, tests: [], output: "10 passing",
    executor: "hostb", ...over,
  };
}

function constraint(over: Partial<SpecConstraint> = {}): SpecConstraint {
  return {
    constraintKey: "c1", appliesTo: "01-visao.md", assertion: "a API responde 201 no POST /pedidos",
    assertionSha: "sha", evidenceHint: "teste de integração do POST", verifiableAt: "runtime",
    severity: "blocker", sourceAnchor: "## API", anchorVerbatim: true, supersededByKey: null,
    drift: false, declaredByModel: "m", ...over,
  };
}

describe("normalizeOracleRun — payload que não prova execução é RECUSADO", () => {
  it("recusa resultado sem cmd", () => {
    const r = normalizeOracleRun({ exit_code: 0, passed: 1, total: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("cmd");
  });

  it("recusa resultado sem exit_code (não existe execução sem código de saída)", () => {
    const r = normalizeOracleRun({ cmd: "npm test", passed: 1, total: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("exit_code");
  });

  it("aceita no_tests e status=error sem cmd — são ausências de medição, não payloads inválidos", () => {
    expect(normalizeOracleRun({ no_tests: true }).ok).toBe(true);
    expect(normalizeOracleRun({ status: "error", output: "executor fora do ar" }).ok).toBe(true);
  });

  it("aceita o contrato do /run-tests e normaliza os nomes snake_case", () => {
    const r = normalizeOracleRun({
      stack: "python", cmd: "pytest -q", exit_code: 1, passed: 3, failed: 2, skipped: 1, total: 6,
      no_tests: false, tests_reliable: true, executor: "10.10.9.225",
      tests: [{ id: "t::a", status: "failed", message: "AssertionError: 404 != 201" }],
      output: "FAILED t::a",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.stack).toBe("python");
    expect(r.run.exitCode).toBe(1);
    expect(r.run.failed).toBe(2);
    expect(r.run.tests[0].message).toContain("404 != 201");
  });

  it("recusa payload que não é objeto", () => {
    expect(normalizeOracleRun(null).ok).toBe(false);
    expect(normalizeOracleRun("APROVADO").ok).toBe(false);
    expect(normalizeOracleRun([1, 2]).ok).toBe(false);
  });
});

describe("oracleOutcome — o único lugar onde o código classifica, e classifica o FATO", () => {
  it("exit 0 sem falha = green", () => expect(oracleOutcome(run())).toBe("green"));
  it("exit != 0 = red", () => expect(oracleOutcome(run({ exitCode: 1 }))).toBe("red"));

  it("exit 0 com teste falhando = red (relatório contraditório vale como falha)", () => {
    expect(oracleOutcome(run({ exitCode: 0, failed: 3 }))).toBe("red");
  });

  it("no_tests e error são outcomes PRÓPRIOS — nunca green", () => {
    expect(oracleOutcome(run({ noTests: true }))).toBe("no_tests");
    expect(oracleOutcome(run({ status: "error" }))).toBe("error");
    expect(oracleOutcome(run({ exitCode: null }))).toBe("error");
  });
});

describe("oracleEnvSha — GAP-87: mesma spec em outro ambiente é OUTRA medição", () => {
  it("muda quando o executor muda", () => {
    expect(oracleEnvSha(run({ executor: "hostb" }))).not.toBe(oracleEnvSha(run({ executor: "hostc" })));
  });
  it("muda quando o comando muda", () => {
    expect(oracleEnvSha(run({ cmd: "npm test" }))).not.toBe(oracleEnvSha(run({ cmd: "npm run test:ci" })));
  });
  it("é estável para o mesmo ambiente (idempotência não pode depender de contagem)", () => {
    expect(oracleEnvSha(run({ passed: 10 }))).toBe(oracleEnvSha(run({ passed: 999 })));
  });
});

describe("oracleReport — o juiz recebe o fato verbatim, com os limites declarados", () => {
  it("declara quando o resultado por teste NÃO é confiável", () => {
    expect(oracleReport(run({ testsReliable: false }))).toContain("NÃO — só exit code e contagem");
  });

  it("declara o recorte da saída em vez de calar", () => {
    const r = oracleReport(run({ output: "x".repeat(200) }), { ...cfgBase(), outputChars: 50 });
    expect(r).toContain("RECORTADA: 50 de 200 chars");
  });

  it("lista os testes que falharam verbatim", () => {
    const r = oracleReport(run({
      exitCode: 1, failed: 1,
      tests: [{ id: "t::pedido", status: "failed", message: "esperava 201, recebeu 500" }],
    }));
    expect(r).toContain("t::pedido :: esperava 201, recebeu 500");
  });
});

function cfgBase() {
  return {
    judgeModel: "", maxTokens: 12_000, perPass: 30, maxPasses: 8, outputChars: 60_000,
    maxFindings: 40,
  };
}

describe("normalizeOracleVerdicts — citação fabricada não satisfaz e não acusa", () => {
  const cs = [constraint({ constraintKey: "c1" }), constraint({ constraintKey: "c2" })];

  it("satisfied com citação VERBATIM da saída é aceito", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "satisfied", evidence: "test pedido criado com 201", reason: "ok" }],
      cs, run({ output: "PASS: test pedido criado com 201 (12ms)" }),
    );
    const v = r.verdicts.find((x) => x.constraintKey === "c1");
    expect(v?.status).toBe("satisfied");
    expect(v?.evidenceVerbatim).toBe(true);
  });

  it("satisfied com citação INVENTADA degrada para indecidivel", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "satisfied", evidence: "test que jamais existiu no log" }],
      cs, run({ output: "10 passing" }),
    );
    const v = r.verdicts.find((x) => x.constraintKey === "c1");
    expect(v?.status).toBe("indecidivel");
    expect(v?.reason).toBe("evidence_not_found");
    expect(v?.blocking).toBe(false);
  });

  it("violated com citação INVENTADA também degrada — acusar sem prova não é acusar", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "violated", evidence: "erro que nao aparece na saida real" }],
      cs, run({ exitCode: 1, failed: 1, output: "FAILED t::outro" }),
    );
    expect(r.verdicts[0].status).toBe("indecidivel");
    expect(r.verdicts[0].blocking).toBe(false);
  });

  it("violated com citação verbatim BLOQUEIA", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "violated", evidence: "AssertionError: 404 != 201" }],
      cs, run({ exitCode: 1, failed: 1, output: "FAILED t::a\nAssertionError: 404 != 201" }),
    );
    expect(r.verdicts[0].status).toBe("violated");
    expect(r.verdicts[0].blocking).toBe(true);
  });

  it("confere a citação também contra as mensagens dos testes, não só contra o stdout", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "violated", evidence: "timeout ao criar pedido" }],
      cs, run({ exitCode: 1, failed: 1, output: "resumo", tests: [{ id: "t::a", status: "failed", message: "timeout ao criar pedido" }] }),
    );
    expect(r.verdicts[0].status).toBe("violated");
  });

  it("constraint que o juiz NÃO julgou entra como not_judged, jamais como cumprida (GAP-17/18)", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "satisfied", evidence: "10 passing" }], cs, run(),
    );
    const c2 = r.verdicts.find((x) => x.constraintKey === "c2");
    expect(c2?.status).toBe("indecidivel");
    expect(c2?.reason).toBe("not_judged");
    expect(r.judged).toBe(1);
  });

  it("chave que não existe é DECLARADA em unknownKeys, não silenciada", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c9", status: "violated", evidence: "10 passing" }], cs, run(),
    );
    expect(r.unknownKeys).toContain("c9");
    expect(r.verdicts.every((v) => v.reason === "not_judged")).toBe(true);
  });

  it("devolve UMA linha por constraint pendente, mesmo com o juiz repetindo chave", () => {
    const r = normalizeOracleVerdicts(
      [{ constraint_key: "c1", status: "violated", evidence: "10 passing" },
       { constraint_key: "c1", status: "satisfied", evidence: "10 passing" }],
      cs, run(),
    );
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts.filter((v) => v.constraintKey === "c1")).toHaveLength(1);
  });
});

describe("oracleFindings — falha REAL volta como GAP na spec, com a severidade DECLARADA", () => {
  const violado = (over: Partial<PolicyVerdict> = {}): PolicyVerdict => ({
    constraintKey: "c1", status: "violated", evidence: "AssertionError: 404 != 201",
    evidenceVerbatim: true, artifact: "npm test", reason: "", waiverKind: "", auditVerdict: "",
    blocking: true, ...over,
  });

  it("gera finding com source oracle, severidade da constraint e anchor = chave", () => {
    const { findings } = oracleFindings(
      [violado()], [constraint({ severity: "blocker" })], ["01-visao.md"], run({ exitCode: 1, failed: 1 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("oracle");
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].anchor).toBe("c1");
    expect(findings[0].category).toBe("oracle_execution");
    expect(findings[0].file).toBe("01-visao.md");
    expect(findings[0].rationale).toContain("AssertionError: 404 != 201");
  });

  it("respeita a severidade warning declarada — o código não promove gravidade", () => {
    const { findings } = oracleFindings(
      [violado()], [constraint({ severity: "warning" })], ["01-visao.md"], run({ exitCode: 1 }),
    );
    expect(findings[0].severity).toBe("warning");
  });

  it("NÃO gera finding para satisfied, indecidivel nem violação sem poder de bloquear", () => {
    const cs = [constraint()];
    expect(oracleFindings([violado({ status: "satisfied" })], cs, ["01-visao.md"], run()).findings).toHaveLength(0);
    expect(oracleFindings([violado({ status: "indecidivel" })], cs, ["01-visao.md"], run()).findings).toHaveLength(0);
    expect(oracleFindings([violado({ blocking: false })], cs, ["01-visao.md"], run()).findings).toHaveLength(0);
  });

  it("descarta e DECLARA quando applies_to não nomeia arquivo real da spec", () => {
    const { findings, dropped } = oracleFindings(
      [violado()], [constraint({ appliesTo: "arquivo-que-nao-existe.md" })], ["01-visao.md"], run(),
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0].reason).toContain("não nomeia arquivo real");
  });

  it("descarta e DECLARA severidade declarada inválida (o código não inventa gravidade)", () => {
    const { findings, dropped } = oracleFindings(
      [violado()], [constraint({ severity: "high" })], ["01-visao.md"], run(),
    );
    expect(findings).toHaveLength(0);
    expect(dropped[0].reason).toContain("severidade declarada inválida");
  });

  it("aplica o teto de findings por medição e DECLARA o que sobrou de fora", () => {
    const vs = Array.from({ length: 5 }, (_, i) => violado({ constraintKey: `c${i}` }));
    const cs = vs.map((v) => constraint({ constraintKey: v.constraintKey }));
    const { findings, dropped } = oracleFindings(vs, cs, ["01-visao.md"], run(), { ...cfgBase(), maxFindings: 2 });
    expect(findings).toHaveLength(2);
    expect(dropped).toHaveLength(3);
    expect(dropped[0].reason).toContain("teto de 2 findings");
  });
});

describe("applyOracleVerdicts — direção ÚNICA: só sai do pending, nunca revisa julgamento", () => {
  const pend = (key: string): PolicyVerdict => ({
    constraintKey: key, status: "pending", evidence: "", evidenceVerbatim: false, artifact: "",
    reason: "", waiverKind: "", auditVerdict: "", blocking: false,
  });
  const oracular = (key: string, status: PolicyVerdict["status"], blocking = false): PolicyVerdict => ({
    constraintKey: key, status, evidence: "prova verbatim", evidenceVerbatim: true,
    artifact: "npm test", reason: "", waiverKind: "", auditVerdict: "", blocking,
  });

  it("substitui pending pelo veredicto da execução real", () => {
    const out = applyOracleVerdicts([pend("c1")], new Map([["c1", oracular("c1", "violated", true)]]));
    expect(out[0].status).toBe("violated");
    expect(out[0].blocking).toBe(true);
  });

  it("NÃO sobrescreve veredicto que o juiz de spec já decidiu", () => {
    const julgado = { ...pend("c1"), status: "violated" as const, blocking: true };
    const out = applyOracleVerdicts([julgado], new Map([["c1", oracular("c1", "satisfied")]]));
    expect(out[0].status).toBe("violated");
    expect(out[0].blocking).toBe(true);
  });

  it("preserva waiver e auditoria cross-family da linha original", () => {
    const comWaiver = { ...pend("c1"), waiverKind: "postponement" as const, auditVerdict: "vaga" as const };
    const out = applyOracleVerdicts([comWaiver], new Map([["c1", oracular("c1", "satisfied")]]));
    expect(out[0].waiverKind).toBe("postponement");
    expect(out[0].auditVerdict).toBe("vaga");
  });

  it("mapa vazio não muda NADA (fail-CLOSED: oráculo ausente = comportamento antigo)", () => {
    const antes = [pend("c1"), pend("c2")];
    expect(applyOracleVerdicts(antes, new Map())).toEqual(antes);
  });

  it("INVARIANTE: o oráculo nunca REDUZ o número de violações impeditivas", () => {
    const antes = [
      { ...pend("c1"), status: "violated" as const, blocking: true },
      pend("c2"), pend("c3"),
    ];
    const oracle = new Map([
      ["c1", oracular("c1", "satisfied")],          // tentativa de absolver o que já foi julgado
      ["c2", oracular("c2", "violated", true)],
      ["c3", oracular("c3", "satisfied")],
    ]);
    const depois = applyOracleVerdicts(antes, oracle);
    expect(policyTally(depois).blocking).toBeGreaterThanOrEqual(policyTally(antes).blocking);
    expect(policyTally(depois).blocking).toBe(2);
  });
});

describe("loadOracleFindings — o que a validação seguinte une (estágio O)", () => {
  const finding = (over: Partial<ValidationFinding> = {}): ValidationFinding => ({
    file: "01-visao.md", line: null, severity: "blocker", title: "Constraint violada: c1",
    rationale: "prova", source: "oracle", category: "oracle_execution", anchor: "c1", ...over,
  });
  const db = (rows: Array<{ findings: unknown }>) => ({
    query: async () => ({ rows: rows as unknown as Record<string, unknown>[] }),
  });

  it("devolve os findings da medição da MESMA spec", async () => {
    const out = await loadOracleFindings(db([{ findings: [finding()] }]), "p", "h", ["01-visao.md"]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("oracle");
  });

  it("descarta finding de arquivo que não existe mais (GAP preso no índice, J1)", async () => {
    const out = await loadOracleFindings(db([{ findings: [finding({ file: "apagado.md" })] }]), "p", "h", ["01-visao.md"]);
    expect(out).toHaveLength(0);
  });

  it("a MESMA constraint medida em dois ambientes conta UMA vez (GAP-49/50)", async () => {
    const out = await loadOracleFindings(
      db([{ findings: [finding()] }, { findings: [finding({ rationale: "outro ambiente" })] }]),
      "p", "h", ["01-visao.md"],
    );
    expect(out).toHaveLength(1);
    expect(out[0].rationale).toBe("prova"); // a medição MAIS RECENTE vence (ORDER BY created_at DESC)
  });

  it("ignora linha que não é finding de oráculo (nada entra pela porta errada)", async () => {
    const out = await loadOracleFindings(
      db([{ findings: [finding({ source: "stage_b" as ValidationFinding["source"] }), null, "texto", { file: "" }] }]),
      "p", "h", ["01-visao.md"],
    );
    expect(out).toHaveLength(0);
  });

  it("sem projeto ou sem spec_hash não devolve nada (não inventa medição)", async () => {
    expect(await loadOracleFindings(db([{ findings: [finding()] }]), "", "h")).toHaveLength(0);
    expect(await loadOracleFindings(db([{ findings: [finding()] }]), "p", "")).toHaveLength(0);
  });
});

describe("oracleNote — cobertura primeiro; ausência de medição é dita, não maquiada", () => {
  const tally = (over: Partial<ReturnType<typeof policyTally>> = {}) => ({ ...policyTally([]), ...over });

  it("no_tests diz que a constraint SEGUE pendente", () => {
    const n = oracleNote({ outcome: "no_tests", judged: 0, pending: 119, tally: tally(), passesFailed: 0 });
    expect(n).toContain("não tem suíte executável");
    expect(n).toContain("não cumprida");
  });

  it("error diz que nada foi decidido", () => {
    const n = oracleNote({ outcome: "error", judged: 0, pending: 119, tally: tally(), passesFailed: 0 });
    expect(n).toContain("não pôde ser medida");
  });

  it("green com cobertura zero não parece sucesso — diz 0/119", () => {
    const n = oracleNote({ outcome: "green", judged: 0, pending: 119, tally: tally(), passesFailed: 0 });
    expect(n).toContain("0/119");
  });

  it("red anuncia a falha ANTES dos números", () => {
    const n = oracleNote({ outcome: "red", judged: 30, pending: 119, tally: tally({ blocking: 4 }), passesFailed: 1 });
    expect(n.startsWith("a suíte FALHOU")).toBe(true);
    expect(n).toContain("4 violação(ões) impeditiva(s)");
    expect(n).toContain("1 passe(s) do juiz falharam");
  });
});
