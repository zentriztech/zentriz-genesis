"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatBRL, formatUSD, convertBRLtoUSDCents, planInstallmentPlan } from "@/lib/planPricing";

/**
 * Exibe, em letras menores, a estrutura de aquisição do plano a partir do valor
 * cadastrado: entrada (no ato da aquisição) + 12 parcelas + total.
 * Usa tokens de tema (`text.secondary`) → legível em fundo claro e escuro.
 * `monthlyPriceCents=null` (plano "sob consulta", ex.: Fábrica) mostra uma chamada pra
 * contato em vez do parcelamento. `monthlyPriceCents=0` continua sem renderizar nada
 * (gratuito/a definir — comportamento anterior preservado).
 */
export function PlanInstallments({
  monthlyPriceCents,
  currency = "BRL",
  sx,
}: {
  monthlyPriceCents: number | null;
  currency?: "BRL" | "USD";
  sx?: object;
}) {
  const p = planInstallmentPlan(monthlyPriceCents);

  if (p.contactOnly) {
    return (
      <Box sx={{ mt: 0.5, ...sx }}>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4, fontWeight: 600 }}>
          {currency === "USD" ? "Contact us for pricing" : "Sob consulta"}
        </Typography>
      </Box>
    );
  }
  if (!p.hasPrice) return null;

  const fmt = currency === "USD" ? formatUSD : formatBRL;
  const entrada = currency === "USD" ? convertBRLtoUSDCents(p.entradaCents) : p.entradaCents;
  const parcela = currency === "USD" ? convertBRLtoUSDCents(p.parcelaCents) : p.parcelaCents;
  const total = currency === "USD" ? convertBRLtoUSDCents(p.totalCents) : p.totalCents;

  return (
    <Box sx={{ mt: 0.5, ...sx }}>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4 }}>
        {currency === "USD" ? "Due at signup: " : "Entrada (no ato da aquisição): "}{fmt(entrada)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4 }}>
        {currency === "USD" ? `+ ${p.installments} installments of ` : `+ ${p.installments} parcelas de `}{fmt(parcela)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4, fontWeight: 600 }}>
        {currency === "USD" ? "Total: " : "Total: "}{fmt(total)}
      </Typography>
    </Box>
  );
}
