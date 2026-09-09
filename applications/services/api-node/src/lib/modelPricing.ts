/**
 * modelPricing.ts — RFC-0004 Onda 2 (F6/T2.2): tabela ÚNICA de preços por modelo (USD/MTok).
 *
 * Substitui 4 cópias hardcoded (auditoria adversarial F10/F11):
 *   1. projects.ts GET /:id/metrics — CASE SQL opus 15/75 else 3/15
 *   2. projects.ts /task-metrics(+detail) — consts PRICE_*_OPUS/SONNET
 *   3. tenantCostCap.ts MODEL_PRICE_CASE_SQL — idem
 *   4. projects.ts stop de POST /runs — assumia SEMPRE Sonnet (subestimava Opus)
 *
 * Preços vigentes (Bedrock/Anthropic, 2026): Haiku 4.5 = 1/5 · Sonnet 4.x = 3/15 ·
 * Sonnet 5 = 2/10 · Opus (≥4.5, inclui 4.8/5) = 5/25 · Fable 5/5.1 = 10/50 (Claude 5).
 * NOTA: a tabela anterior cobrava Opus a 15/75 (preço da geração antiga) e QUALQUER-não-opus
 * a 3/15 (Haiku 3× mais caro que o real) — a troca aproxima o medidor da fatura real.
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
  // Sonnet 5 (Claude 5) = 2/10 — preço OFICIAL Anthropic (mais barato que Sonnet 4.x). DEVE
  // vir antes do "sonnet" genérico (3/15), senão o substring cairia no ramo antigo.
  { match: "sonnet-5", price: { inputPerMTok: 2, outputPerMTok: 10 } },
  { match: "sonnet", price: { inputPerMTok: 3, outputPerMTok: 15 } },
  // Fable 5 / 5.1 (Claude 5) = 10/50 — preço OFICIAL Anthropic (confirmado 2026-09-03 na
  // página de pricing; é o DOBRO do Opus). Antes assumíamos faixa Opus (5/25) — corrigido.
  { match: "fable", price: { inputPerMTok: 10, outputPerMTok: 50 } },
];

export const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

/**
 * 🔴 GAP-147 — multiplicadores do cache de prompt sobre o preço de ENTRADA.
 *
 * Medido ao vivo em prod (run 81ac10d9, 2026-09-09, logo após ligar o GAP-142): com 3 votos, o 1º
 * refutador gravou 163.941 tokens no cache e os votos 2 e 3 os LERAM — e os três registraram
 * `input_tokens = 2`. Ou seja: no instante em que o cache passou a funcionar, o medidor de custo
 * (fonte única) passou a ver ~0 de entrada e a subestimar a validação em ~99% — reabrindo
 * exatamente o buraco que o RFC-0004 F6/T2.1 fechou (gasto invisível ao cost-cap do tenant,
 * migration 068). Economia real não pode virar economia FICTÍCIA no medidor.
 *
 * Tabela do Bedrock/Anthropic: escrita de cache = 1,25× o preço de entrada; leitura = 0,1×.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export function priceForModel(model: string | null | undefined): ModelPrice {
  const m = (model ?? "").toLowerCase();
  for (const entry of MODEL_PRICES) {
    if (m.includes(entry.match)) return entry.price;
  }
  return DEFAULT_PRICE;
}

export function costUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const p = priceForModel(model);
  return (inputTokens / 1_000_000) * p.inputPerMTok
    + (outputTokens / 1_000_000) * p.outputPerMTok
    // GAP-147: cache é entrada FATURADA — ausente/NULL vira 0 e o cálculo antigo fica idêntico.
    + ((cacheWriteTokens || 0) / 1_000_000) * p.inputPerMTok * CACHE_WRITE_MULTIPLIER
    + ((cacheReadTokens || 0) / 1_000_000) * p.inputPerMTok * CACHE_READ_MULTIPLIER;
}

/**
 * Gera o CASE SQL de preço para agregações (mesma tabela acima — fonte única).
 * `col` é o prefixo da coluna (ex.: "m." ou ""). Usa ILIKE por substring do model id.
 */
export function priceCaseSql(col: string): string {
  const input = `${col}input_tokens`;
  const output = `${col}output_tokens`;
  const model = `${col}model`;
  // GAP-147: a entrada faturada = input_tokens + escrita de cache (1,25x) + leitura (0,1x).
  // COALESCE porque as colunas são NULL nas linhas anteriores ao GAP-142 (não medido) — nelas o
  // resultado é IDÊNTICO ao de antes. Todos os chamadores agregam project_agent_metrics.
  const cacheIn = (rate: number) =>
    `+ (COALESCE(${col}cache_write_tokens, 0) / 1000000.0) * ${rate} * ${CACHE_WRITE_MULTIPLIER}`
    + ` + (COALESCE(${col}cache_read_tokens, 0) / 1000000.0) * ${rate} * ${CACHE_READ_MULTIPLIER}`;
  const branches = MODEL_PRICES
    .map((e) => `WHEN ${model} ILIKE '%${e.match}%' THEN (${input} / 1000000.0) * ${e.price.inputPerMTok} + (${output} / 1000000.0) * ${e.price.outputPerMTok} ${cacheIn(e.price.inputPerMTok)}`)
    .join("\n       ");
  return `CASE ${branches}
       ELSE (${input} / 1000000.0) * ${DEFAULT_PRICE.inputPerMTok} + (${output} / 1000000.0) * ${DEFAULT_PRICE.outputPerMTok} ${cacheIn(DEFAULT_PRICE.inputPerMTok)}
  END`;
}
