"use client";

/**
 * CourtesyCreditCard — mostra ao tenant_admin o saldo de crédito de cortesia disponível.
 *
 * Consome GET /api/me/credit (server-side; tenant_id vem só do JWT). A rota revela o saldo
 * APENAS quando é positivo (decisão C do plano de créditos): { hasCredit:true, balanceCents } ;
 * caso contrário { hasCredit:false } e o card não renderiza (degrada limpo, sem poluir a página
 * de quem não tem crédito). O saldo é derivado do ledger de dupla-entrada (view tenant_credit_balance),
 * decresce a cada ciclo à medida que abate a cobrança mensal por pagamento method='credit'.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import RedeemIcon from "@mui/icons-material/Redeem";
import { apiGet } from "@/lib/api";
import { authStore } from "@/stores/authStore";
import { formatBRL } from "@/lib/planPricing";

type CreditState = { hasCredit: boolean; balanceCents?: number };

function CourtesyCreditCardInner() {
  const [state, setState] = useState<CreditState | null>(null);
  const isAdmin = authStore.isTenantAdmin; // inclui zentriz_admin (que, sem tenantId, recebe hasCredit:false)

  useEffect(() => {
    if (!isAdmin) return;
    apiGet<CreditState>("/api/me/credit")
      .then(setState)
      // Degrada limpo: qualquer erro → sem estado → card não renderiza.
      .catch(() => setState(null));
  }, [isAdmin]);

  if (!isAdmin || !state?.hasCredit) return null;

  return (
    <Card sx={{ mt: 2, borderLeft: "4px solid", borderColor: "success.main" }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <RedeemIcon color="success" />
          <div>
            <Typography variant="h6">Crédito de cortesia disponível</Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, mt: 0.5 }}>
              {formatBRL(state.balanceCents ?? 0)}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Este saldo abate automaticamente a cobrança mensal do seu plano até se esgotar.
            </Typography>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default observer(CourtesyCreditCardInner);
