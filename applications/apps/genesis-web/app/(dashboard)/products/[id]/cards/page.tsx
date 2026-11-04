"use client";

// 3.1 — Quadro de cards do produto (plano EVOLUIR-PROJETO). Só tem efeito com a flag CARDS_BANCADA do
// tenant; sem ela a tela mostra um aviso e o fluxo antigo segue na página do projeto.
import { useParams } from "next/navigation";
import Box from "@mui/material/Box";
import { CardBoardView } from "@/components/cards/CardBoardView";

export default function ProductCardsPage() {
  const params = useParams<{ id: string }>();
  return (
    <Box sx={{ p: { xs: 1.5, md: 3 } }}>
      <CardBoardView productId={params.id} />
    </Box>
  );
}
