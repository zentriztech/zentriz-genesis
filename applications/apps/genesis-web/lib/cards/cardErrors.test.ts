import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { blockedReasonLabel, cardErrorMessage, errorDetail, tableMessage } from "./cardErrors";

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
