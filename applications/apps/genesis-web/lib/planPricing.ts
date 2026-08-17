/**
 * Regras de exibição de preço/parcelamento de plano (BRL).
 *
 * Estrutura de aquisição (decisão do Jean, 2026-08-17): a partir do valor
 * cadastrado do plano (`monthlyPriceCents`), o cliente paga uma **entrada no ato
 * da aquisição** de valor igual ao valor cadastrado, **mais 12 parcelas** do mesmo
 * valor. Total = 13 × valor cadastrado. É apenas informação exibida (Controle por
 * plano + signup); a cobrança de fato continua em `charges` (RFC-0002).
 */

/** Número de parcelas exibidas além da entrada. */
export const PLAN_INSTALLMENTS = 12;

/** Formata centavos (BRL) como moeda: 9900 -> "R$ 99,00". */
export function formatBRL(cents: number): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export type PlanInstallmentPlan = {
  /** true quando há valor cadastrado (> 0); 0 = gratuito/a definir, não exibir parcelamento. */
  hasPrice: boolean;
  /** Entrada no ato da aquisição, em centavos (= valor cadastrado). */
  entradaCents: number;
  /** Valor de cada parcela, em centavos (= valor cadastrado). */
  parcelaCents: number;
  /** Quantidade de parcelas (12). */
  installments: number;
  /** Total do contrato, em centavos (entrada + 12 parcelas = 13 × valor). */
  totalCents: number;
};

/**
 * Deriva a estrutura de parcelamento a partir do valor cadastrado do plano.
 * Entrada = 1× valor, 12 parcelas de 1× valor, total = 13× valor.
 */
export function planInstallmentPlan(monthlyPriceCents: number): PlanInstallmentPlan {
  const value = Math.max(0, Math.round(monthlyPriceCents ?? 0));
  return {
    hasPrice: value > 0,
    entradaCents: value,
    parcelaCents: value,
    installments: PLAN_INSTALLMENTS,
    totalCents: value * (PLAN_INSTALLMENTS + 1),
  };
}
