/** modelPricing.test.ts — RFC-0004 F6/T2.2: tabela única de preços por modelo. */
import { describe, it, expect } from "vitest";
import { priceForModel, costUsd, priceCaseSql } from "./modelPricing.js";

describe("modelPricing — fonte única", () => {
  it("haiku 1/5 (antes era debitado a 3/15 — 3x o real)", () => {
    expect(priceForModel("us.anthropic.claude-haiku-4-5")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });
  it("opus 5/25 (geração >=4.5; a tabela antiga cobrava 15/75)", () => {
    expect(priceForModel("us.anthropic.claude-opus-4-8")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });
  it("sonnet 3/15 e default desconhecido = sonnet", () => {
    expect(priceForModel("us.anthropic.claude-sonnet-4-6").inputPerMTok).toBe(3);
    expect(priceForModel("modelo-misterioso").outputPerMTok).toBe(15);
    expect(priceForModel(null).inputPerMTok).toBe(3);
  });
  it("costUsd calcula por MTok", () => {
    expect(costUsd("sonnet", 1_000_000, 1_000_000)).toBe(18);
    expect(costUsd("haiku", 2_000_000, 0)).toBe(2);
    expect(costUsd("opus", 0, 1_000_000)).toBe(25);
  });
  it("priceCaseSql cobre haiku/opus/sonnet + ELSE, com prefixo de coluna", () => {
    const sql = priceCaseSql("m.");
    expect(sql).toContain("m.model ILIKE '%haiku%'");
    expect(sql).toContain("m.model ILIKE '%opus%'");
    expect(sql).toContain("m.model ILIKE '%sonnet%'");
    expect(sql).toContain("ELSE");
    expect(sql).toContain("* 25");
    expect(sql).not.toContain("* 75"); // preço antigo do Opus não pode voltar
  });
});
