/**
 * Fase 3 / 3.5 — tabela única de erros de card: toda `code: "…"` das rotas/serviços de card tem mensagem PT-BR curta na tabela,
 * e `userMessage` só entra em respostas de erro de códigos conhecidos (sucesso e flag off intocados).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CARD_ERRORS, cardUserMessage, isCardErrorCode, withCardUserMessage } from "./cardErrors.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = ["../routes/cards.ts", "./cardService.ts", "./cardPromote.ts", "./cardSpecGuard.ts", "./cardJourney.ts", "./evolveClaim.ts"];
// códigos de fontes compartilhadas que NÃO são de card (ex.: evolveClaim atende também o /evolve legado) ficam de fora desta varredura
const NOT_CARD = new Set(["TICKET_NOT_FOUND", "TICKET_WRONG_PRODUCT", "TICKET_REJECTED", "TICKET_NOT_PROMOTED", "IDEMPOTENCY_KEY_REUSED", "HEAD_NOT_FOUND", "CONFLICT"]);

describe("tabela de erros de card", () => {
  it("toda code literal das fontes de card está na tabela", () => {
    const missing: string[] = [];
    for (const rel of SOURCES) {
      const src = readFileSync(join(here, rel), "utf-8");
      for (const m of src.matchAll(/\bcode: "([A-Z][A-Z0-9_]+)"/g)) {
        if (!isCardErrorCode(m[1]) && !NOT_CARD.has(m[1])) missing.push(`${rel}:${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("mensagens: PT-BR curtas, status coerente e área válida", () => {
    for (const [code, def] of Object.entries(CARD_ERRORS)) {
      expect(def.message.length, code).toBeGreaterThan(15);
      expect(def.message.length, code).toBeLessThanOrEqual(160);
      expect(def.message, code).toMatch(/[a-zá-ú]/);
      expect([400, 402, 403, 404, 409, 410, 422, 500]).toContain(def.http);
      expect(["geral", "estado", "spec", "gate", "orcamento", "promocao", "anexo"]).toContain(def.area);
    }
    expect(cardUserMessage("CARD_SPEC_LOCKED")).toContain("Reabra o card");
    expect(cardUserMessage("NAO_EXISTE")).toBeNull();
  });
  it("withCardUserMessage: só erro, só código conhecido, sem tocar nos campos", () => {
    const body = { code: "CARD_BASE_STALE", message: "técnico", expectedHead: "a" };
    expect(withCardUserMessage(409, body)).toEqual({ ...body, userMessage: CARD_ERRORS.CARD_BASE_STALE.message });
    expect(withCardUserMessage(200, body)).toBe(body);
    expect(withCardUserMessage(409, { code: "OUTRO", message: "x" })).toEqual({ code: "OUTRO", message: "x" });
    expect(withCardUserMessage(404, { message: "sem code" })).toEqual({ message: "sem code" });
    expect(withCardUserMessage(409, [1])).toEqual([1]);
    const had = { code: "CARD_BASE_STALE", userMessage: "já tinha" };
    expect(withCardUserMessage(409, had)).toBe(had);
  });
});
