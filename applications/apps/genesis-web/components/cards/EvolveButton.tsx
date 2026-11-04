"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { useCardsCapabilities } from "@/lib/cards/useCardsEnabled";

/**
 * Botão “Evoluir” da página do projeto aceito. Com `CARDS_BANCADA` do tenant ligada leva ao quadro de cards; desligada, abre o diálogo
 * legado. Enquanto a flag CARREGA, ou se a consulta FALHA, o botão NÃO cai no diálogo legado (que aceita evolução sem card): fica
 * desabilitado e, na falha, mostra o erro com “Tentar de novo” (Y-10).
 */
export function EvolveButton({ productId, openTickets, onCards, onLegacy }: { productId: string | null | undefined; openTickets: number; onCards: (productId: string) => void; onLegacy: () => void }) {
  const caps = useCardsCapabilities(productId);
  const cards = caps.caps?.cardsBancada === true;
  const label = caps.loading ? "Verificando…" : openTickets > 0 ? `Evoluir (${openTickets} pedido${openTickets > 1 ? "s" : ""})` : "Evoluir";
  return (
    <>
      <Button variant="outlined" color="secondary" size="small" startIcon={<span style={{ fontSize: "1rem" }}>🔄</span>}
        disabled={caps.loading || caps.error} aria-describedby={caps.error ? "cards-caps-error" : undefined}
        onClick={() => (cards && productId ? onCards(productId) : onLegacy())}>
        {label}
      </Button>
      {caps.error && (
        <Alert id="cards-caps-error" severity="warning" role="alert" sx={{ py: 0 }} action={<Button color="inherit" size="small" onClick={caps.retry}>Tentar de novo</Button>}>
          Não foi possível verificar se este produto usa cards. Tente de novo antes de evoluir.
        </Alert>
      )}
    </>
  );
}
