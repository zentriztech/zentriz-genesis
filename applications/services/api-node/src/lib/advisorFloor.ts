/**
 * advisorFloor.ts — C4' (desenho 27, §3.1): PISO calculado do teto do Advisor.
 *
 * Um teto do Advisor menor que UMA chamada típica do papel nunca deixa o Advisor trabalhar: é configuração morta
 * (equivale a desligá-lo por engano). Por isso a gravação de `advisor_pct` recusa um orçamento-base que gere teto abaixo
 * deste piso, e o Guard trata teto abaixo do piso como base inválida (`advisor_denied_no_base`).
 *
 * piso = tokens típicos de UMA chamada do Advisor × tabela de preços (`modelPricing.ts`, preço de Opus, o teto do repo).
 *
 * ASSUNÇÃO EXPLÍCITA, `calibrado=false`: os tokens típicos abaixo NÃO foram medidos no ledger. Fonte parcial:
 *  - saída = 16.000, o default de `CLAUDE_MAX_TOKENS_QA` (orchestrator/agents/runtime.py), o papel que mais aciona o Advisor;
 *  - entrada = 40.000 é estimativa do prompt (spec + diff + histórico de rework), sem medição.
 * Quando houver quantis do ledger por papel (C9'), estas constantes passam a vir de lá. Até lá o piso é CONSERVADOR
 * (uma única chamada) e só barra configurações inúteis; nunca é usado para liberar gasto.
 */
import { costUsd } from "./modelPricing.js";

export const ADVISOR_FLOOR_CALIBRATED = false;
export const ADVISOR_FLOOR_TYPICAL_INPUT_TOKENS = 40_000;
export const ADVISOR_FLOOR_TYPICAL_OUTPUT_TOKENS = 16_000;
/** Quantas chamadas típicas o teto precisa comportar no mínimo. */
export const ADVISOR_FLOOR_MIN_CALLS = 1;
/** Modelo de referência de preço do piso: `opus` casa com a linha de teto de `MODEL_PRICES`. */
export const ADVISOR_FLOOR_PRICE_MODEL = "opus";

/** Piso em US$ do teto do Advisor (arredondado a 4 casas). */
export function advisorFloorUsd(): number {
  const one = costUsd(ADVISOR_FLOOR_PRICE_MODEL, ADVISOR_FLOOR_TYPICAL_INPUT_TOKENS, ADVISOR_FLOOR_TYPICAL_OUTPUT_TOKENS);
  return Math.round(one * ADVISOR_FLOOR_MIN_CALLS * 10000) / 10000;
}

/** Piso efetivo: o maior entre o calculado e o `floor_usd` que a política declara (nunca menor que o calculado). */
export function effectiveAdvisorFloorUsd(policyFloorUsd: number | null | undefined): number {
  const calc = advisorFloorUsd();
  return policyFloorUsd != null && policyFloorUsd > calc ? policyFloorUsd : calc;
}

/** `null` se `pct % × baseUsd` cobre o piso; senão a mensagem de recusa. */
export function advisorFloorViolation(pct: number, baseUsd: number, policyFloorUsd?: number | null): string | null {
  if (!(baseUsd > 0) || !Number.isFinite(baseUsd)) return "O orçamento-base deve ser um valor em US$ maior que zero.";
  const cap = baseUsd * (pct / 100);
  const floor = effectiveAdvisorFloorUsd(policyFloorUsd);
  if (cap + 1e-9 < floor) {
    return `Teto do Advisor de US$ ${cap.toFixed(4)} (${pct} % de US$ ${baseUsd}) abaixo do piso de US$ ${floor.toFixed(4)} `
      + `(uma chamada típica; premissa calibrado=${ADVISOR_FLOOR_CALIBRATED}). Aumente o percentual ou o orçamento-base.`;
  }
  return null;
}
