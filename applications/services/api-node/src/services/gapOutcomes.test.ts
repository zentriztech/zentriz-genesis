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

  it("desfecho sem fingerprint (gravado antes do campo existir) é IGNORADO, não casado por título", () => {
    const legado = prior.map((o) => ({ ...o, fingerprint: "" })) as GapOutcome[];
    expect(selectPriorOutcomes(legado, TRES)).toEqual([]);
  });

  it("o bloco entrega `permanece_aberto`, `nao_e_defeito` e `corrigido` CONTESTADO — e nada mais", () => {
    const contestado = parseGapOutcomes(bloco("3) corrigido: fechei"), TRES, { appliedEdits: 0 }).outcomes;
    const txt = priorOutcomeFactBlock([...prior.slice(0, 2), contestado[2]]);
    expect(txt).toContain("PERMANECE ABERTO");
    expect(txt).toContain("NÃO É DEFEITO");
    expect(txt).toContain("NENHUMA edição foi aplicada");
    expect(txt).toContain("tente uma DIFERENTE");
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
  it("devolve o array do último job que pediu contas neste arquivo", async () => {
    const rows = [{ gap_outcomes: [{ index: 1, verb: "permanece_aberto" }] }];
    const db = { query: vi.fn().mockResolvedValue({ rows }) };
    const r = await lastDeclaredOutcomes(db, "p1", "privacidade-lgpd.md");
    expect(r).toHaveLength(1);
    const sql = db.query.mock.calls[0][0] as string;
    // Case-insensitive no path e o mais RECENTE primeiro: o relato é o da última rodada, não o de uma
    // rodada qualquer do histórico.
    expect(sql).toMatch(/lower\(file_path\) = lower\(\$2\)/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
  });

  it("nenhum job / valor não-array / falha de banco ⇒ null (o laço não afirma nada ao agente)", async () => {
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockResolvedValue({ rows: [] }) }, "p", "a.md")).toBeNull();
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockResolvedValue({ rows: [{ gap_outcomes: {} }] }) }, "p", "a.md")).toBeNull();
    expect(await lastDeclaredOutcomes({ query: vi.fn().mockRejectedValue(new Error("boom")) }, "p", "a.md")).toBeNull();
  });
});
