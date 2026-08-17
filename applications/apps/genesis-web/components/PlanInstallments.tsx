"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatBRL, planInstallmentPlan } from "@/lib/planPricing";

/**
 * Exibe, em letras menores, a estrutura de aquisição do plano a partir do valor
 * cadastrado: entrada (no ato da aquisição) + 12 parcelas + total.
 * Usa tokens de tema (`text.secondary`) → legível em fundo claro e escuro.
 * Não renderiza nada quando o plano não tem valor cadastrado (0 = gratuito/a definir).
 */
export function PlanInstallments({
  monthlyPriceCents,
  sx,
}: {
  monthlyPriceCents: number;
  sx?: object;
}) {
  const p = planInstallmentPlan(monthlyPriceCents);
  if (!p.hasPrice) return null;

  return (
    <Box sx={{ mt: 0.5, ...sx }}>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4 }}>
        Entrada (no ato da aquisição): {formatBRL(p.entradaCents)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4 }}>
        + {p.installments} parcelas de {formatBRL(p.parcelaCents)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, lineHeight: 1.4, fontWeight: 600 }}>
        Total: {formatBRL(p.totalCents)}
      </Typography>
    </Box>
  );
}
