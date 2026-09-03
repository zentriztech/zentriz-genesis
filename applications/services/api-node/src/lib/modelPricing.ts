/**
 * modelPricing.ts — RFC-0004 Onda 2 (F6/T2.2): tabela ÚNICA de preços por modelo (USD/MTok).
 *
 * Substitui 4 cópias hardcoded (auditoria adversarial F10/F11):
 *   1. projects.ts GET /:id/metrics — CASE SQL opus 15/75 else 3/15
 *   2. projects.ts /task-metrics(+detail) — consts PRICE_*_OPUS/SONNET
 *   3. tenantCostCap.ts MODEL_PRICE_CASE_SQL — idem
 *   4. projects.ts stop de POST /runs — assumia SEMPRE Sonnet (subestimava Opus)
 *
 * Preços vigentes (Bedrock/Anthropic, 2026): Haiku 4.5 = 1/5 · Sonnet = 3/15 ·
 * Opus (≥4.5, inclui 4.8) = 5/25. NOTA: a tabela anterior cobrava Opus a 15/75 (preço da
 * geração antiga) e QUALQUER-não-opus a 3/15 (Haiku 3× mais caro que o real) — a troca
 * altera valores exibidos/limites: Opus fica ~3× mais barato e Haiku 3× mais barato que
 * antes, aproximando o medidor da fatura real.
 *
 * O match é por substring do model id (ex.: "us.anthropic.claude-sonnet-4-6"). Modelo
 * desconhecido → preço de Sonnet (default conservador do stack).
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Array<{ match: string; price: ModelPrice }> = [
  { match: "haiku", price: { inputPerMTok: 1, outputPerMTok: 5 } },
  { match: "opus", price: { inputPerMTok: 5, outputPerMTok: 25 } },
  { match: "sonnet", price: { inputPerMTok: 3, outputPerMTok: 15 } },
];

export const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

export function priceForModel(model: string | null | undefined): ModelPrice {
  const m = (model ?? "").toLowerCase();
  for (const entry of MODEL_PRICES) {
    if (m.includes(entry.match)) return entry.price;
  }
  return DEFAULT_PRICE;
}

export function costUsd(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const p = priceForModel(model);
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
}

/**
 * Gera o CASE SQL de preço para agregações (mesma tabela acima — fonte única).
 * `col` é o prefixo da coluna (ex.: "m." ou ""). Usa ILIKE por substring do model id.
 */
export function priceCaseSql(col: string): string {
  const input = `${col}input_tokens`;
  const output = `${col}output_tokens`;
  const model = `${col}model`;
  const branches = MODEL_PRICES
    .map((e) => `WHEN ${model} ILIKE '%${e.match}%' THEN (${input} / 1000000.0) * ${e.price.inputPerMTok} + (${output} / 1000000.0) * ${e.price.outputPerMTok}`)
    .join("\n       ");
  return `CASE ${branches}
       ELSE (${input} / 1000000.0) * ${DEFAULT_PRICE.inputPerMTok} + (${output} / 1000000.0) * ${DEFAULT_PRICE.outputPerMTok}
  END`;
}
