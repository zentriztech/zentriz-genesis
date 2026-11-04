"use client";

// 3.3 — Tela do card (Pedido, Especificação do card, Versões, Estado). Rota nova; só é alcançada pelo
// quadro de cards, que depende da flag CARDS_BANCADA do tenant.
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Box from "@mui/material/Box";
import { CARD_TABS, CardDetailView, type CardTab } from "@/components/cards/CardDetailView";

function Inner() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const t = sp?.get("tab") as CardTab | null;
  return <CardDetailView cardId={params.id} initialTab={t && (CARD_TABS as readonly string[]).includes(t) ? t : "request"} />;
}

export default function CardPage() {
  return (
    <Box sx={{ p: { xs: 1.5, md: 3 } }}>
      <Suspense fallback={null}><Inner /></Suspense>
    </Box>
  );
}
