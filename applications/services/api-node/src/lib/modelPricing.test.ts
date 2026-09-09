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
  it("fable 10/50 (preço OFICIAL Anthropic; é o dobro do Opus)", () => {
    expect(priceForModel("us.anthropic.claude-fable-5")).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(priceForModel("us.anthropic.claude-fable-5-1").outputPerMTok).toBe(50);
  });
  it("sonnet-5 2/10 (Claude 5, mais barato que Sonnet 4.x) — ramo antes do sonnet genérico", () => {
    expect(priceForModel("us.anthropic.claude-sonnet-5")).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(priceForModel("us.anthropic.claude-sonnet-4-6").inputPerMTok).toBe(3);
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
    expect(sql).toContain("m.model ILIKE '%sonnet-5%'");
    expect(sql).toContain("m.model ILIKE '%sonnet%'");
    expect(sql).toContain("m.model ILIKE '%fable%'");
    expect(sql).toContain("ELSE");
    expect(sql).toContain("* 25");
    expect(sql).toContain("* 50"); // Fable output oficial 10/50
    expect(sql).not.toContain("* 75"); // preço antigo do Opus não pode voltar
  });
});

/**
 * 🔴 GAP-147 — o cache de prompt (GAP-142) fez o medidor CEGAR. Medido ao vivo em prod (run
 * 81ac10d9): o refutador gravou 163.941 tokens no cache, dois votos os leram, e as TRÊS linhas
 * registraram `input_tokens = 2`. Como o custo derivava só de input+output, a validação — 54% de
 * toda a entrada da Bancada — passou a custar ~zero no papel. Economia real não pode virar
 * economia fictícia: cache é entrada faturada (escrita 1,25x, leitura 0,1x).
 */
describe("GAP-147 — cache de prompt no custo", () => {
  it("escrita de cache custa 1,25x a entrada; leitura, 0,1x", () => {
    // sonnet 3/MTok → escrita 3,75 · leitura 0,30
    expect(costUsd("sonnet", 0, 0, 0, 1_000_000)).toBeCloseTo(3.75, 10);
    expect(costUsd("sonnet", 0, 0, 1_000_000, 0)).toBeCloseTo(0.3, 10);
    // haiku 1/MTok → escrita 1,25 · leitura 0,10
    expect(costUsd("haiku", 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(1.35, 10);
  });
  it("ler o cache é ~12x mais barato que reenviar a mesma entrada (o porquê do GAP-142)", () => {
    const reenviando = costUsd("sonnet", 163_941, 0);
    const lendoDoCache = costUsd("sonnet", 2, 0, 163_941, 0);
    expect(lendoDoCache).toBeLessThan(reenviando / 9);
  });
  it("a soma dos 3 votos com cache é ~1,45x um voto — e NÃO ~zero como o medidor cego dizia", () => {
    const umVoto = costUsd("sonnet", 163_941, 5_776);
    const comCache = costUsd("sonnet", 2, 5_776, 0, 163_941)      // voto 1: gravou
      + costUsd("sonnet", 2, 4_345, 163_941, 0)                   // voto 2: leu
      + costUsd("sonnet", 2, 3_480, 163_941, 0);                  // voto 3: leu
    const soEntrada = (n: number) => (n / 1_000_000) * 3;
    const entradaFaturada = soEntrada(163_941) * 1.25 + soEntrada(163_941) * 0.1 * 2;
    expect(entradaFaturada / soEntrada(163_941)).toBeCloseTo(1.45, 10);
    // sem o GAP-147 este valor seria ~o custo de 2 tokens de entrada (subestimação de ~99%).
    expect(comCache).toBeGreaterThan(umVoto);
  });
  it("linha sem cache medido (NULL→0) mantém EXATAMENTE o valor de antes do GAP-142", () => {
    expect(costUsd("sonnet", 1_000_000, 1_000_000, 0, 0)).toBe(18);
    expect(costUsd("sonnet", 1_000_000, 1_000_000)).toBe(18);
  });
  it("priceCaseSql soma cache com COALESCE em TODOS os ramos e no ELSE", () => {
    const sql = priceCaseSql("m.");
    // 5 ramos + ELSE = 6 ocorrências de cada coluna
    expect(sql.match(/COALESCE\(m\.cache_write_tokens, 0\)/g)?.length).toBe(6);
    expect(sql.match(/COALESCE\(m\.cache_read_tokens, 0\)/g)?.length).toBe(6);
    // multiplicadores aplicados sobre o preço de ENTRADA do ramo (haiku=1, opus=5)
    expect(sql).toContain("* 1 * 1.25");
    expect(sql).toContain("* 5 * 0.1");
  });
  it("priceCaseSql sem prefixo de coluna funciona (chamadores usam \"\" e \"m.\")", () => {
    expect(priceCaseSql("")).toContain("COALESCE(cache_read_tokens, 0)");
  });
});
