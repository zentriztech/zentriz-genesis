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
import type { CardDetail, CardJourney } from "@/lib/cards/types";
import SpecVersionsPanel from "@/components/SpecVersionsPanel";
import { CardActionsBar } from "./CardActionsBar";
import { CardJourneyTab } from "./CardJourneyTab";
import { CardRequestTab } from "./CardRequestTab";
import { CardSpecTab } from "./CardSpecTab";
import { KindChip, StateChip } from "./KindChip";
import { PromotePanel } from "./PromotePanel";
import { CardsA11yTheme } from "./CardsA11yTheme";
import { CardStatusPanel } from "./CardStatusPanel";
import { useCardRunner } from "./useCardRunner";

export const CARD_TABS = ["request", "spec", "versions", "state"] as const;
export type CardTab = (typeof CARD_TABS)[number];
const TAB_LABEL: Record<CardTab, string> = { request: "Pedido", spec: "Especificação do card", versions: "Versões", state: "Estado e linha do tempo" };

/** Tela do card (3.3/3.4/3.5): situação (jornada do servidor), ações, promoção e as abas Pedido, Especificação do card, Versões e Estado. */
function CardDetailViewInner({ cardId, initialTab = "request" }: { cardId: string; initialTab?: CardTab }) {
  const router = useRouter();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [journey, setJourney] = useState<CardJourney | null>(null);
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CardTab>(initialTab);
  const [baseSpecStale, setBaseSpecStale] = useState<boolean | null>(null);

  const loadJourney = useCallback(async () => {
    try { setJourney(await cardsApi.journey(cardId)); setJourneyError(null); }
    catch (e) { setJourneyError(`Não foi possível carregar a situação do card: ${cardErrorMessage(e)}`); }
  }, [cardId]);
  const load = useCallback(async () => {
    try { setCard(await cardsApi.get(cardId)); setError(null); }
    catch (e) { setError(cardErrorMessage(e)); }
    await loadJourney();
  }, [cardId, loadJourney]);
  useEffect(() => { void load(); }, [load]);
  const onDeleted = useCallback(() => router.push(card ? `/products/${card.productId}/cards` : "/products"), [router, card]);
  const runner = useCardRunner(card ?? ({ id: cardId, childProjectId: null } as CardDetail), load, onDeleted);

  if (error && !card) return <Alert severity="error" role="alert" action={<Button color="inherit" size="small" onClick={() => void load()}>Tentar de novo</Button>}>{error}</Alert>;
  if (!card) return <Box sx={{ p: 4, textAlign: "center" }}><CircularProgress aria-label="Carregando card" /></Box>;

  // Trava da spec: decisão do servidor (`journey.spec`); sem a jornada, vale o que o detalhe permite editar.
  const locked = journey ? journey.spec.locked : !card.actions.edit;
  const canReopen = journey ? journey.spec.canReopen : card.actions.reopen;
  return (
    <Box>
      <Link component={NextLink} href={`/products/${card.productId}/cards`} variant="body2">← Quadro de cards</Link>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1, mb: 1 }}>
        <Typography variant="h5" component="h1" fontWeight={700} sx={{ overflowWrap: "anywhere" }}>{card.code} · {card.title}</Typography>
        <StateChip state={card.state} /><KindChip kind={card.kind} />
      </Stack>
      <CardStatusPanel card={card} journey={journey} journeyError={journeyError} runner={runner} onTab={setTab} onReloadJourney={() => void loadJourney()} />
      <CardActionsBar card={card} runner={runner} />
      <Box sx={{ mt: 2 }}><PromotePanel card={card} journey={journey} runner={runner} /></Box>
      <Tabs value={tab} onChange={(_, v: CardTab) => setTab(v)} variant="scrollable" scrollButtons="auto" aria-label="Seções do card" sx={{ mt: 2, borderBottom: 1, borderColor: "divider" }}>
        {CARD_TABS.map((t) => <Tab key={t} value={t} label={TAB_LABEL[t]} id={`card-tab-${t}`} aria-controls={`card-panel-${t}`} />)}
      </Tabs>
      <Box role="tabpanel" id={`card-panel-${tab}`} aria-labelledby={`card-tab-${tab}`} sx={{ pt: 2 }}>
        {tab === "request" && <CardRequestTab card={card} onChanged={load} />}
        {tab === "spec" && <CardSpecTab card={card} locked={locked} canReopen={canReopen} runner={runner} onChanged={load} onStale={setBaseSpecStale} baseStale={journey?.base?.stale ?? baseSpecStale} />}
        {tab === "versions" && (card.draftProjectId
          ? <SpecVersionsPanel projectId={card.draftProjectId} onRestored={() => void load()} />
          : <Alert severity="info">Sem rascunho de especificação para este card.</Alert>)}
        {tab === "state" && <CardJourneyTab card={card} journey={journey} error={journeyError} />}
      </Box>
    </Box>
  );
}

export function CardDetailView(props: { cardId: string; initialTab?: CardTab }) {
  return <CardsA11yTheme><CardDetailViewInner {...props} /></CardsA11yTheme>;
}
