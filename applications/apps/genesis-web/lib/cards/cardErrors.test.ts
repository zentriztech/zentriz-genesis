import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { CARD_ERRORS, cardErrorMessage } from "./cardErrors";

const err = (status: number, code: string, message = "msg do servidor", body?: Record<string, unknown>) => new ApiError(message, status, code, body);

describe("cardErrorMessage (tabela única PT-BR)", () => {
  it("traduz os códigos do contrato R §2 com acentuação", () => {
    expect(cardErrorMessage(err(409, "CARD_BASE_STALE"))).toMatch(/base vencida/);
    expect(cardErrorMessage(err(409, "USE_CARD_PROMOTE"))).toMatch(/Promova-o pela tela do card/);
    expect(cardErrorMessage(err(409, "CARD_SPEC_LOCKED"))).toMatch(/Reabrir para edição/);
    expect(cardErrorMessage(err(409, "CARD_KIND_MISMATCH"))).toMatch(/Correção/);
    expect(cardErrorMessage(err(409, "NO_ACCEPTED_HEAD"))).toMatch(/fabricado e aceito/);
  });
  it("CARD_KIND_REQUIREMENT escolhe a frase pelo campo faltante", () => {
    expect(cardErrorMessage(err(409, "CARD_KIND_REQUIREMENT", "x", { details: { missing: "repro_scenario" } }))).toMatch(/cenário de reprodução/);
    expect(cardErrorMessage(err(409, "CARD_KIND_REQUIREMENT", "x", { details: { missing: "non_goals" } }))).toMatch(/Non-goals/);
  });
  it("orçamento: saldo livre e mínimo vêm do corpo; 402 sem código usa a mensagem do servidor", () => {
    expect(cardErrorMessage(err(402, "BUDGET_FREE_BELOW_MIN", "x", { freeUsd: 1.5, minFreeUsd: 5 }))).toMatch(/US\$ 1\.50 livres, mínimo exigido US\$ 5\.00/);
    expect(cardErrorMessage(err(402, "GUARD_X", "Limite do Guard atingido"))).toBe("Limite do Guard atingido");
  });
  it("anexos: lista os motivos do servidor", () => {
    expect(cardErrorMessage(err(400, "ATTACHMENT_INVALID", "x", { errors: ["a.png: tipo não permitido", "b.pdf: acima do teto"] }))).toMatch(/a\.png: tipo não permitido; b\.pdf: acima do teto/);
  });
  it("código desconhecido ⇒ mensagem do servidor; sem nada ⇒ genérico", () => {
    expect(cardErrorMessage(err(409, "GITHUB_APP_NOT_INSTALLED", "Instale o GitHub App no repositório"))).toBe("Instale o GitHub App no repositório");
    expect(cardErrorMessage(new ApiError("", 500))).toMatch(/Não foi possível concluir/);
    expect(cardErrorMessage("boom")).toMatch(/Não foi possível concluir/);
  });
  it("todas as mensagens fixas estão em PT-BR acentuado (sem 'nao', 'voce')", () => {
    for (const [code, e] of Object.entries(CARD_ERRORS)) {
      const m = typeof e === "string" ? e : e({ status: 409, body: {}, serverMessage: "s" });
      expect(m, code).not.toMatch(/\b(nao|voce|especificacao|promocao)\b/i);
    }
  });
});
