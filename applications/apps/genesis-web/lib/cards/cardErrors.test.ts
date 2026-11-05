import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { PREPARED, blockedReasonLabel, cardErrorMessage, errorDetail, eventReasonLabel, tableMessage } from "./cardErrors";

const err = (status: number, code: string | undefined, message = "msg do servidor", body?: Record<string, unknown>, retry?: number) => new ApiError(message, status, code, body, retry);

describe("cardErrorMessage — ordem de precedência", () => {
  it("1) userMessage do servidor vence a tabela local", () => {
    expect(cardErrorMessage(err(409, "CARD_BASE_STALE", "técnica", { userMessage: "Mensagem do servidor." }))).toBe("Mensagem do servidor.");
  });
  it("2) sem userMessage: tabela espelho do backend (flag off, /evolve legado)", () => {
    expect(cardErrorMessage(err(409, "USE_CARD_PROMOTE"))).toBe("Este pedido é um card: promova-o pelo próprio card.");
    expect(cardErrorMessage(err(403, "TENANT_INACTIVE"))).toBe("O tenant está suspenso. Fale com o administrador.");
    expect(tableMessage("CARD_SPEC_LOCKED")).toMatch(/Reabra o card/);
  });
  it("3) código fora da tabela: mensagem do servidor; 402 e 401 têm texto próprio; sem nada, genérico", () => {
    expect(cardErrorMessage(err(409, "GITHUB_APP_NOT_INSTALLED", "Instale o GitHub App no repositório"))).toBe("Instale o GitHub App no repositório");
    expect(cardErrorMessage(err(402, undefined, ""))).toMatch(/Orçamento insuficiente/);
    expect(cardErrorMessage(err(401, undefined, ""))).toMatch(/Sessão expirada/);
    expect(cardErrorMessage(new ApiError("", 500))).toMatch(/Não foi possível concluir/);
    expect(cardErrorMessage("boom")).toMatch(/Não foi possível concluir/);
    expect(cardErrorMessage(new Error("falha de rede"))).toBe("falha de rede");
  });
  it("BAD_REQUEST usa o message do servidor (diz QUAL campo falhou)", () => {
    expect(cardErrorMessage(err(400, "BAD_REQUEST", "Descreva o que o card pede (campo 'body').", { userMessage: "Não entendemos o pedido." }))).toBe("Descreva o que o card pede (campo 'body').");
  });
});

describe("errorDetail — frase extra montada do corpo", () => {
  it("tipo exigido aceita lista (formato real) e texto", () => {
    expect(errorDetail(err(409, "CARD_KIND_REQUIREMENT", "x", { details: { missing: ["non_goals"] } }))).toBe("Falta: seção “Non-goals” (não-objetivos).");
    expect(errorDetail(err(409, "CARD_KIND_REQUIREMENT", "x", { details: { missing: "repro_scenario" } }))).toMatch(/FAIL_TO_PASS/);
    expect(errorDetail(err(409, "CARD_KIND_REQUIREMENT", "x", { details: {} }))).toBe("");
  });
  it("serviços do produto (lista de objetos) e transição inválida", () => {
    expect(errorDetail(err(400, "SERVICE_REQUIRED", "x", { services: [{ projectId: "p", title: "API", versionNumber: 3 }, { projectId: "q", title: null, versionNumber: 1 }] }))).toBe("Serviços: API (v3), q (v1).");
    expect(errorDetail(err(409, "CARD_INVALID_TRANSITION", "x", { from: "ready", to: "ready" }))).toMatch(/De “ready” para “ready”/);
  });
  it("base não mergeada (4.5c): cita o card e o PR bloqueantes e a ação; busca do código falhou explica que nada veio do disco", () => {
    const d = errorDetail(err(409, "CARD_PREVIOUS_UNMERGED", "x", { blockingCardCode: "TK-0006", blockingPrNumber: 8, action: "Mergeie o PR do TK-0006 em dev e promova de novo." }));
    expect(d).toContain("TK-0006 · PR #8");
    expect(d).toContain("Mergeie o PR");
    expect(tableMessage("CARD_PREVIOUS_UNMERGED")).toMatch(/ainda não foi integrado/);
    expect(errorDetail(err(500, "MATERIALIZATION_FAILED", "x", { reason: "CODE_BASE_FETCH_FAILED" }))).toMatch(/nada foi copiado do disco/);
    expect(errorDetail(err(500, "MATERIALIZATION_FAILED", "x", {}))).toBe("");
  });
  it("outro card em andamento (4.5d): cita o card bloqueante, o estado do filho e a ação (retomar ou recusar)", () => {
    const d = errorDetail(err(409, "CARD_PREVIOUS_IN_PROGRESS", "x", { blockingCardCode: "TK-0008", blockingChildStatus: "blocked_cyborg", action: "Aguarde o TK-0008 terminar ou recuse-o." }));
    expect(d).toContain("TK-0008 · execução “blocked_cyborg”");
    expect(d).toContain("recuse-o");
    expect(errorDetail(err(409, "CARD_PREVIOUS_IN_PROGRESS", "x", {}))).toBe("");
    expect(tableMessage("CARD_PREVIOUS_IN_PROGRESS")).toMatch(/ainda está em andamento/);
  });
  it("recusa na fábrica: entrega real (CARD_ALREADY_DELIVERABLE) traz a ação; rótulos do motivo em PT-BR", () => {
    expect(errorDetail(err(409, "CARD_ALREADY_DELIVERABLE", "x", { action: "Não recuse." }))).toBe("Não recuse.");
    expect(errorDetail(err(409, "CARD_ALREADY_DELIVERABLE", "x", {}))).toBe("");
    expect(tableMessage("CARD_ALREADY_DELIVERABLE")).toMatch(/entrega real/);
    expect(tableMessage("CARD_MERGE_UNVERIFIED")).toMatch(/não foi possível confirmar/i);
    expect(eventReasonLabel("manual_reject_in_factory")).toBe("recusado na fábrica (execução arquivada)");
    expect(blockedReasonLabel("pr_closed_unmerged")).toMatch(/PR da execução foi fechado sem integração/);
  });
  it("Retry-After só aparece quando o servidor manda", () => {
    expect(errorDetail(err(409, "EVOLUTION_BUSY", "x", {}, 2))).toBe("Tente de novo em 2 s.");
    expect(errorDetail(err(409, "EVOLUTION_BUSY"))).toBe("");
  });
});

describe("blockedReasonLabel", () => {
  it("traduz os motivos de bloqueio do backend", () => {
    expect(blockedReasonLabel("budget:BUDGET_PAUSED")).toBe("orçamento — O orçamento de IA está pausado. Aumente o orçamento para continuar.");
    expect(blockedReasonLabel("child_failed")).toBe("a execução não está mais ativa (failed)");
    expect(blockedReasonLabel("materialization_failed:X")).toMatch(/A promoção falhou no meio do caminho/);
    expect(blockedReasonLabel(null)).toBe("não registrado");
    expect(blockedReasonLabel("outro")).toBe("outro");
  });
});

describe("códigos novos do backend da Fase 3 (revisão adversarial) — tabela preparada em PT-BR", () => {
  it("USE_CARDS, INVALID_ID, USE_CARD_DELETE, CARD_PATH_COLLIDES_WITH_BASE e CARD_NOT_READY têm mensagem; o userMessage do servidor sempre vence", () => {
    for (const c of ["USE_CARDS", "INVALID_ID", "USE_CARD_DELETE", "CARD_PATH_COLLIDES_WITH_BASE", "CARD_NOT_READY"]) {
      expect(tableMessage(c), c).toBeTruthy();
      expect(PREPARED[c], c).toMatch(/[.!?]$/);
      expect(cardErrorMessage(err(409, c, "técnica", { userMessage: "Do servidor." })), c).toBe("Do servidor.");
    }
    expect(cardErrorMessage(err(409, "USE_CARDS", "x"))).toMatch(/usa cards/);
    expect(cardErrorMessage(err(409, "USE_CARD_DELETE", "x"))).toMatch(/rascunho de um card/);
  });
  it("403 de papel (sem código conhecido) vira texto claro", () => {
    expect(cardErrorMessage(err(403, undefined, ""))).toMatch(/papel neste tenant não permite/);
  });
});

describe("eventReasonLabel — motivos do histórico para pessoas", () => {
  it("traduz os motivos conhecidos, reaproveita bloqueios e deixa o desconhecido como veio", () => {
    expect(eventReasonLabel("spec_write")).toBe("especificação alterada");
    expect(eventReasonLabel("budget:BUDGET_PAUSED")).toMatch(/^orçamento — /);
    expect(eventReasonLabel("child_failed")).toMatch(/não está mais ativa \(failed\)/);
    expect(eventReasonLabel("outro_motivo")).toBe("outro_motivo");
    expect(eventReasonLabel(null)).toBe("");
  });
});
