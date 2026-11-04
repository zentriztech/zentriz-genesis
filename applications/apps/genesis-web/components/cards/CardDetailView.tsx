"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import NextLink from "next/link";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import { useCardsCapabilities } from "@/lib/cards/useCardsEnabled";
import type { CardDetail } from "@/lib/cards/types";
import SpecVersionsPanel from "@/components/SpecVersionsPanel";
import { CardActionsBar } from "./CardActionsBar";
import { CardJourneyTab } from "./CardJourneyTab";
import { CardRequestTab } from "./CardRequestTab";
import { CardSpecTab } from "./CardSpecTab";
import { KindChip, StateChip } from "./KindChip";
import { PromotePanel } from "./PromotePanel";

export const CARD_TABS = ["request", "spec", "versions", "state"] as const;
export type CardTab = (typeof CARD_TABS)[number];
const TAB_LABEL: Record<CardTab, string> = { request: "Pedido", spec: "Especificação do card", versions: "Versões", state: "Estado e linha do tempo" };

/** Tela do card (3.3/3.4/3.5): Pedido, Especificação do card, Versões e Estado. */
export function CardDetailView({ cardId, initialTab = "request" }: { cardId: string; initialTab?: CardTab }) {
  const router = useRouter();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CardTab>(initialTab);
  const [baseStale, setBaseStale] = useState<boolean | null>(null);
  const { caps } = useCardsCapabilities(card?.productId);

  const load = useCallback(async () => {
    try { setCard(await cardsApi.get(cardId)); setError(null); }
    catch (e) { setError(cardErrorMessage(e)); }
  }, [cardId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !card) return <Alert severity="error" role="alert" action={<Button color="inherit" size="small" onClick={() => void load()}>Tentar de novo</Button>}>{error}</Alert>;
  if (!card) return <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress aria-label="Carregando card" /></Box>;

  // Trava da spec: o campo é do backend (K1, `specLocked`); sem ele, `ready` é a única fase travada.
  const locked = card.specLocked ?? card.state === "ready";
  return (
    <Box>
      <Link component={NextLink} href={`/products/${card.productId}/cards`} variant="body2">← Quadro de cards</Link>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1, mb: 1 }}>
        <Typography variant="h5" component="h1" fontWeight={700} sx={{ overflowWrap: "anywhere" }}>{card.code} · {card.title}</Typography>
        <StateChip state={card.state} /><KindChip kind={card.kind} />
      </Stack>
      {card.state === "blocked" && <Alert severity="error" sx={{ mb: 1 }}>Card bloqueado{card.blockedReason ? `: ${card.blockedReason}` : ""}. Use “Retomar” depois de resolver a causa.</Alert>}
      <CardActionsBar card={card} onChanged={load} onDeleted={() => router.push(`/products/${card.productId}/cards`)} />
      <Box sx={{ mt: 2 }}><PromotePanel card={card} caps={caps} baseStale={baseStale} onBaseStale={setBaseStale} onChanged={load} /></Box>
      <Tabs value={tab} onChange={(_, v: CardTab) => setTab(v)} variant="scrollable" scrollButtons="auto" aria-label="Seções do card" sx={{ mt: 2, borderBottom: 1, borderColor: "divider" }}>
        {CARD_TABS.map((t) => <Tab key={t} value={t} label={TAB_LABEL[t]} id={`card-tab-${t}`} aria-controls={`card-panel-${t}`} />)}
      </Tabs>
      <Box role="tabpanel" id={`card-panel-${tab}`} aria-labelledby={`card-tab-${tab}`} sx={{ pt: 2 }}>
        {tab === "request" && <CardRequestTab card={card} onChanged={load} />}
        {tab === "spec" && <CardSpecTab card={card} locked={locked} onChanged={load} onStale={setBaseStale} />}
        {tab === "versions" && (card.draftProjectId
          ? <SpecVersionsPanel projectId={card.draftProjectId} onRestored={() => void load()} />
          : <Alert severity="info">Sem rascunho de especificação para este card.</Alert>)}
        {tab === "state" && <CardJourneyTab card={card} />}
      </Box>
    </Box>
  );
}
