import { describe, it, expect } from "vitest";

import {
  applyPolicyDecisions, archetypeHash, assertionSha, normalizeConstraints, normalizeKey,
  normalizeVerdicts, parseWaivers, policyNote, policyTally, type PolicyVerdict, type SpecConstraint,
} from "./specPolicyGate.js";

/**
 * F2 — CONSTRAINTS DECLARADAS + POLICY GATE.
 *
 * Cada bloco abaixo fixa um achado das DUAS revisões adversariais cross-family que atacaram o
 * desenho antes de existir código (Nova Pro, 5 achados; Mistral Large 3, 7 achados). O teste não
 * existe para provar que o código roda — existe para que o achado não volte em silêncio.
 *
 * O eixo é o EQUILÍBRIO que o Jean exigiu, e ele tem DOIS modos de falha opostos:
 *   • **deixar passar** — evidência inventada virando `satisfied`, waiver de "não deu tempo"
 *     dispensando constraint de segurança, resposta parcial do juiz somindo na contagem;
 *   • **loop infinito** — constraint vaga sem critério objetivo bloqueando para sempre, constraint
 *     de runtime virando `indecidivel` eterno na Bancada, onde o produto ainda não existe.
 * Um teste que só cobre uma das metades deixa a outra viva.
 */

const SPEC = [
  "# API de Pedidos",
  "",
  "## Contrato de erro",
  "Toda resposta de erro devolve o envelope {code, message, traceId} com HTTP status coerente.",
  "",
  "## Latência",
  "O endpoint de consulta responde em menos de 200ms no percentil 95.",
].join("\n");

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    constraint_key: "error-envelope-declared",
    applies_to: "api.md",
    assertion: "Toda resposta de erro usa o envelope code/message/traceId.",
    evidence_hint: "a seção Contrato de erro da spec da API",
    verifiable_at: "spec",
    severity: "blocker",
    source_anchor: "Toda resposta de erro devolve o envelope {code, message, traceId}",
    ...over,
  };
}

function constraint(over: Partial<SpecConstraint> = {}): SpecConstraint {
  return {
    constraintKey: "error-envelope-declared", appliesTo: "api.md",
    assertion: "Toda resposta de erro usa o envelope code/message/traceId.",
    assertionSha: assertionSha("Toda resposta de erro usa o envelope code/message/traceId."),
    evidenceHint: "a seção Contrato de erro", verifiableAt: "spec", severity: "blocker",
    sourceAnchor: "Toda resposta de erro devolve o envelope", anchorVerbatim: true,
    supersededByKey: null, drift: false, declaredByModel: "claude", ...over,
  };
}

const ARTIFACTS = [{ name: "api.md", content: SPEC }];

describe("normalizeKey — a identidade da constraint tem de sobreviver às rodadas (GAP-49/50)", () => {
  it("normaliza acento, caixa e pontuação para o MESMO slug", () => {
    expect(normalizeKey("Envelope de Erro Declarado")).toBe("envelope-de-erro-declarado");
    expect(normalizeKey("  ENVELOPE_DE_ERRO  ")).toBe("envelope-de-erro");
    expect(normalizeKey("latência-p95")).toBe("latencia-p95");
  });

  it("chave ilegível devolve string vazia em vez de virar prosa", () => {
    expect(normalizeKey("!!!")).toBe("");
    expect(normalizeKey(undefined)).toBe("");
  });
});

describe("normalizeConstraints — Context Integrity na DERIVAÇÃO (Mistral B5)", () => {
  it("aceita a constraint bem formada e guarda o sha da afirmação", () => {
    const { accepted, rejected } = normalizeConstraints([raw()], { specText: SPEC, model: "claude" });
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].constraintKey).toBe("error-envelope-declared");
    expect(accepted[0].anchorVerbatim).toBe(true);
    expect(accepted[0].assertionSha).toHaveLength(64);
  });

  it("🔴 RECUSA âncora que NÃO existe literalmente na spec — premissa fabricada não é rigor", () => {
    const { accepted, rejected } = normalizeConstraints(
      [raw({ source_anchor: "A spec exige autenticação mútua por mTLS em todos os endpoints." })],
      { specText: SPEC, model: "claude" },
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/não existe literalmente/);
  });

  it("🔴 RECUSA constraint sem evidence_hint — ela viraria `indecidivel` eterno (GAP-84)", () => {
    const { accepted, rejected } = normalizeConstraints([raw({ evidence_hint: "" })],
      { specText: SPEC, model: "claude" });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/evidence_hint/);
  });

  it("recusa verifiable_at fora do vocabulário em vez de assumir `spec` calado", () => {
    const { accepted, rejected } = normalizeConstraints([raw({ verifiable_at: "quando der" })],
      { specText: SPEC, model: "claude" });
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/verifiable_at/);
  });

  it("recusa chave duplicada na mesma derivação e CONTA a recusa", () => {
    const { accepted, rejected } = normalizeConstraints([raw(), raw()],
      { specText: SPEC, model: "claude" });
    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/duplicada/);
  });

  it("respeita o teto de prompt sem apagar o que não caiu — a sobra é DECLARADA", () => {
    const lista = [raw(), raw({ constraint_key: "latency-p95",
      assertion: "A consulta responde abaixo de 200ms no p95.",
      source_anchor: "O endpoint de consulta responde em menos de 200ms" })];
    const { accepted, rejected } = normalizeConstraints(lista, { specText: SPEC, model: "claude", max: 1 });
    expect(accepted).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ key: "latency-p95" });
    expect(rejected[0].reason).toMatch(/teto de 1/);
  });

  it("🔴 Mistral B1: chave reusada com significado NOVO e sem declarar supersedência ⇒ drift", () => {
    const previous = [constraint({ assertion: "Erros devolvem apenas o campo message.",
      assertionSha: assertionSha("Erros devolvem apenas o campo message.") })];
    const { accepted } = normalizeConstraints([raw()], { specText: SPEC, model: "claude", previous });
    expect(accepted[0].drift).toBe(true);
  });

  it("mesma chave com a MESMA afirmação não é drift — reuso de identidade é o comportamento pedido", () => {
    const previous = [constraint()];
    const { accepted } = normalizeConstraints(
      [raw({ assertion: previous[0].assertion })], { specText: SPEC, model: "claude", previous });
    expect(accepted[0].drift).toBe(false);
  });

  it("troca DECLARADA em supersedes_key não é drift — anunciar a mudança é o caminho legítimo", () => {
    const previous = [constraint({ assertion: "Erros devolvem apenas message.",
      assertionSha: assertionSha("Erros devolvem apenas message.") })];
    const { accepted } = normalizeConstraints(
      [raw({ supersedes_key: "error-envelope-declared" })], { specText: SPEC, model: "claude", previous });
    expect(accepted[0].drift).toBe(false);
    expect(accepted[0].supersededByKey).toBe("error-envelope-declared");
  });
});

describe("archetypeHash — mudar o checklist muda a derivação da MESMA spec (Mistral B5)", () => {
  it("checklist diferente ⇒ hash diferente, então a idempotência não mente", () => {
    const a = archetypeHash({ id: "api-backend", checklist: ["tem contrato de erro"] });
    const b = archetypeHash({ id: "api-backend", checklist: ["tem contrato de erro", "tem paginação"] });
    expect(a).not.toBe(b);
  });

  it("ausência de arquétipo é um valor estável, não vazio", () => {
    expect(archetypeHash(null)).toBe(archetypeHash(undefined));
    expect(archetypeHash(null)).toHaveLength(16);
  });
});

describe("normalizeVerdicts — cobertura MEDIDA, não presumida (Mistral B4 / GAP-17/18)", () => {
  it("satisfied com citação VERBATIM do artefato nomeado passa", () => {
    const { verdicts, judged } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "satisfied", artifact: "api.md",
      evidence: "devolve o envelope {code, message, traceId}",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0].status).toBe("satisfied");
    expect(verdicts[0].evidenceVerbatim).toBe(true);
    expect(judged).toBe(1);
  });

  it("🔴 Nova A4: satisfied com evidência INVENTADA degrada para indecidivel e é contado", () => {
    const { verdicts } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "satisfied", artifact: "api.md",
      evidence: "a spec define claramente um envelope de erro completo e adequado",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0].status).toBe("indecidivel");
    expect(verdicts[0].reason).toBe("evidence_not_found");
    expect(verdicts[0].blocking).toBe(false);
  });

  it("satisfied citando artefato que não existe entre os entregues ⇒ artifact_not_found", () => {
    const { verdicts } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "satisfied", artifact: "inexistente.md",
      evidence: "devolve o envelope",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0].status).toBe("indecidivel");
    expect(verdicts[0].reason).toBe("artifact_not_found");
  });

  it("🔴 constraint SEM veredicto na resposta vira indecidivel/not_judged — nunca ausente", () => {
    const cs = [constraint(), constraint({ constraintKey: "latency-p95", verifiableAt: "spec" })];
    const { verdicts, judged } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "satisfied", artifact: "api.md",
      evidence: "devolve o envelope",
    }], cs, ARTIFACTS);
    expect(verdicts).toHaveLength(2);
    const faltante = verdicts.find((v) => v.constraintKey === "latency-p95")!;
    expect(faltante).toMatchObject({ status: "indecidivel", reason: "not_judged" });
    expect(judged).toBe(1);
  });

  it("🔴 chave que ninguém pediu é DESCARTADA e contada — não infla o denominador", () => {
    const { verdicts, unknownKeys } = normalizeVerdicts([
      { constraint_key: "error-envelope-declared", status: "violated", artifact: "api.md", evidence: "falta traceId" },
      { constraint_key: "inventada-pelo-juiz", status: "violated", artifact: "api.md", evidence: "x" },
    ], [constraint()], ARTIFACTS);
    expect(verdicts).toHaveLength(1);
    expect(unknownKeys).toEqual(["inventada-pelo-juiz"]);
  });

  it("violated com artefato concreto bloqueia — é a razão de o gate existir", () => {
    const { verdicts } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "violated", artifact: "api.md",
      evidence: "a seção não menciona traceId em erros 5xx",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0]).toMatchObject({ status: "violated", blocking: true });
  });

  it("violated SEM artefato concreto não bloqueia — o ônus da prova é de quem acusa", () => {
    const { verdicts } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "violated", artifact: "", evidence: "está errado",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0]).toMatchObject({ status: "indecidivel", reason: "no_artifact", blocking: false });
  });

  it("🔴 Mistral B2: constraint de runtime é `pending` na Bancada, não indecidivel eterno", () => {
    const { verdicts, judged } = normalizeVerdicts([], [constraint({ verifiableAt: "runtime" })], ARTIFACTS);
    expect(verdicts[0].status).toBe("pending");
    expect(verdicts[0].reason).toMatch(/runtime/);
    expect(judged).toBe(0);
    // pending fica FORA do denominador do julgável: forçar veredicto aqui produziria número falso.
    expect(policyTally(verdicts).judgeable).toBe(0);
  });

  it("status fora do vocabulário cai em indecidivel COM o nome do status recebido", () => {
    const { verdicts } = normalizeVerdicts([{
      constraint_key: "error-envelope-declared", status: "parcialmente ok", artifact: "api.md", evidence: "",
    }], [constraint()], ARTIFACTS);
    expect(verdicts[0].status).toBe("indecidivel");
    expect(verdicts[0].reason).toMatch(/status desconhecido/);
  });
});

describe("parseWaivers — a dispensa vive ANCORADA na spec, não escondida no banco", () => {
  it("extrai chave e motivo até a próxima seção", () => {
    const spec = [SPEC, "", "### WAIVER DE POLICY: latency-p95",
      "Este produto é um batch noturno: não existe percentil de latência de usuário.",
      "", "## Outra seção", "conteúdo alheio"].join("\n");
    const w = parseWaivers(spec);
    expect(w).toHaveLength(1);
    expect(w[0].constraintKey).toBe("latency-p95");
    expect(w[0].reason).toMatch(/batch noturno/);
    expect(w[0].reason).not.toMatch(/conteúdo alheio/);
  });

  it("spec sem waiver devolve lista vazia (nada de dispensa implícita)", () => {
    expect(parseWaivers(SPEC)).toEqual([]);
  });
});

describe("applyPolicyDecisions — as DUAS pernas do equilíbrio", () => {
  const violada: PolicyVerdict = {
    constraintKey: "error-envelope-declared", status: "violated", evidence: "falta traceId",
    evidenceVerbatim: true, artifact: "api.md", reason: "", waiverKind: "", auditVerdict: "",
    blocking: true,
  };

  it("🔴 Mistral B3: waiver `inapplicable` dispensa — e `waived` é categoria PRÓPRIA", () => {
    const [v] = applyPolicyDecisions([violada],
      { waivers: [{ constraintKey: "error-envelope-declared", kind: "inapplicable" }] });
    expect(v.status).toBe("waived");
    expect(v.blocking).toBe(false);
    // nunca contada como cumprida: dispensar não é cumprir.
    expect(policyTally([v]).satisfied).toBe(0);
    expect(policyTally([v]).waived).toBe(1);
  });

  it("🔴 Mistral B3: 'não deu tempo' (postponement) NÃO dispensa e SEGUE bloqueando", () => {
    const [v] = applyPolicyDecisions([violada],
      { waivers: [{ constraintKey: "error-envelope-declared", kind: "postponement" }] });
    expect(v.status).toBe("violated");
    expect(v.blocking).toBe(true);
    expect(v.waiverKind).toBe("postponement");
  });

  it("constraint `vaga` pela outra família perde o BLOQUEIO sem perder a linha (anti-loop)", () => {
    const [v] = applyPolicyDecisions([violada],
      { audits: [{ constraintKey: "error-envelope-declared", verdict: "vaga" }] });
    expect(v.status).toBe("violated");
    expect(v.blocking).toBe(false);
    expect(v.reason).toBe("cross_family_vaga");
  });

  it("constraint `verificavel` pela outra família CONTINUA bloqueando — auditor não absolve", () => {
    const [v] = applyPolicyDecisions([violada],
      { audits: [{ constraintKey: "error-envelope-declared", verdict: "verificavel" }] });
    expect(v.blocking).toBe(true);
  });

  it("sem parecer do auditor a violação segue bloqueando — ausência não é absolvição (GAP-62)", () => {
    const [v] = applyPolicyDecisions([violada], {});
    expect(v.blocking).toBe(true);
    expect(v.auditVerdict).toBe("");
  });

  it("waiver e parecer não transformam `satisfied` em coisa nenhuma", () => {
    const ok: PolicyVerdict = { ...violada, status: "satisfied", blocking: false };
    const [v] = applyPolicyDecisions([ok], {
      waivers: [{ constraintKey: "error-envelope-declared", kind: "inapplicable" }],
      audits: [{ constraintKey: "error-envelope-declared", verdict: "vaga" }],
    });
    expect(v.status).toBe("satisfied");
    expect(v.blocking).toBe(false);
  });
});

describe("policyTally / policyNote — a contagem tem de poder CAIR (GAP-42/43)", () => {
  const v = (over: Partial<PolicyVerdict>): PolicyVerdict => ({
    constraintKey: "k", status: "satisfied", evidence: "", evidenceVerbatim: false, artifact: "",
    reason: "", waiverKind: "", auditVerdict: "", blocking: false, ...over,
  });

  it("soma cada categoria e conta só o `blocking` como impedimento", () => {
    const t = policyTally([
      v({ constraintKey: "a" }),
      v({ constraintKey: "b", status: "violated", blocking: true }),
      v({ constraintKey: "c", status: "violated", blocking: false, auditVerdict: "vaga" }),
      v({ constraintKey: "d", status: "indecidivel", reason: "not_judged" }),
      v({ constraintKey: "e", status: "pending" }),
      v({ constraintKey: "f", status: "waived", waiverKind: "inapplicable" }),
    ]);
    expect(t).toMatchObject({
      total: 6, satisfied: 1, violated: 2, indecidivel: 1, pending: 1, waived: 1,
      blocking: 1, judgeable: 5, judged: 4, notJudged: 1, vagas: 1,
    });
  });

  it("gate 100% verde por construção é impossível: not_judged e evidence_not_found aparecem", () => {
    const t = policyTally([
      v({ status: "indecidivel", reason: "not_judged" }),
      v({ status: "indecidivel", reason: "evidence_not_found" }),
    ]);
    expect(t.satisfied).toBe(0);
    expect(t.notJudged).toBe(1);
    expect(t.evidenceNotFound).toBe(1);
  });

  it("drift vem das CONSTRAINTS, não dos veredictos", () => {
    expect(policyTally([], [constraint({ drift: true }), constraint()]).drift).toBe(1);
  });

  it("a nota diz a COBERTURA primeiro e nomeia o que é incômodo", () => {
    const nota = policyNote(policyTally([
      v({ constraintKey: "a", status: "violated", blocking: true }),
      v({ constraintKey: "b", status: "indecidivel", reason: "not_judged" }),
      v({ constraintKey: "c", status: "violated", blocking: false, auditVerdict: "vaga" }),
      v({ constraintKey: "d", status: "violated", blocking: true, waiverKind: "postponement" }),
      v({ constraintKey: "e", status: "pending" }),
    ], [constraint({ drift: true })]));
    // 4 julgáveis (o `pending` sai do denominador), 3 julgadas: a que ninguém julgou APARECE.
    expect(nota).toMatch(/^3\/4 constraint\(s\) julgada\(s\) na spec/);
    expect(nota).toMatch(/2 violação\(ões\) impeditiva\(s\)/);
    expect(nota).toMatch(/1 violação\(ões\) sem poder de bloquear/);
    expect(nota).toMatch(/1 sem veredicto/);
    expect(nota).toMatch(/1 pedido\(s\) de adiamento RECUSADO\(s\)/);
    expect(nota).toMatch(/1 pendente\(s\) de build\/runtime/);
    expect(nota).toMatch(/1 com significado trocado sem declarar/);
  });

  it("nenhuma constraint ⇒ contagem zerada, sem divisão por zero e sem verde falso", () => {
    const t = policyTally([]);
    expect(t).toMatchObject({ total: 0, blocking: 0, judged: 0, judgeable: 0 });
    expect(policyNote(t)).toMatch(/^0\/0 constraint/);
  });
});
