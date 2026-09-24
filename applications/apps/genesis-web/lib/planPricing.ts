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

/** Taxa BRL→USD usada na exibição internacional (2026-09-24, fixa por ora — pedido do
 * Jean: "depois colocamos dinâmico". Se/quando existir uma fonte de cotação viva,
 * substituir aqui SEM tocar nos chamadores (formatUSD/convertBRLtoUSDCents). */
export const USD_BRL_RATE = 5.5;

/** Formata centavos (BRL) como moeda: 9900 -> "R$ 99,00". */
export function formatBRL(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Formata centavos (USD) como moeda: 9900 -> "US$ 99.00". */
export function formatUSD(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Converte centavos BRL para centavos USD pela taxa fixa acima. */
export function convertBRLtoUSDCents(brlCents: number): number {
  return Math.round(brlCents / USD_BRL_RATE);
}

export type PlanInstallmentPlan = {
  /** true quando há valor cadastrado (> 0); 0 = gratuito/a definir, não exibir parcelamento. */
  hasPrice: boolean;
  /** true quando o plano é explicitamente "sob consulta" (preço nulo, não 0). */
  contactOnly: boolean;
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
 * `null` = plano "sob consulta" (ex.: Fábrica) — distinto de 0 (gratuito/a definir).
 */
export function planInstallmentPlan(monthlyPriceCents: number | null): PlanInstallmentPlan {
  if (monthlyPriceCents === null) {
    return { hasPrice: false, contactOnly: true, entradaCents: 0, parcelaCents: 0, installments: PLAN_INSTALLMENTS, totalCents: 0 };
  }
  const value = Math.max(0, Math.round(monthlyPriceCents ?? 0));
  return {
    hasPrice: value > 0,
    contactOnly: false,
    entradaCents: value,
    parcelaCents: value,
    installments: PLAN_INSTALLMENTS,
    totalCents: value * (PLAN_INSTALLMENTS + 1),
  };
}
