"use client";
import { useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import NextLink from "next/link";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorCode, cardErrorMessage } from "@/lib/cards/cardErrors";
import type { CardCapabilities, CardDetail } from "@/lib/cards/types";

type Check = "ok" | "pending" | "unknown";
function Item({ state, children }: { state: Check; children: React.ReactNode }) {
  const Icon = state === "ok" ? CheckCircleOutlineIcon : state === "pending" ? RadioButtonUncheckedIcon : HelpOutlineIcon;
  const text = state === "ok" ? "Atendido" : state === "pending" ? "Pendente" : "Conferido ao promover";
  return (
    <Stack component="li" direction="row" spacing={1} alignItems="flex-start" sx={{ listStyle: "none" }}>
      <Icon fontSize="small" color={state === "ok" ? "success" : state === "pending" ? "warning" : "disabled"} aria-hidden />
      <Typography variant="body2"><b>{text}:</b> {children}</Typography>
    </Stack>
  );
}

/** Promover (3.5): pré-requisitos visíveis, base vencida com “Revalidar”, clique duplo sem duplicar, ligação com o filho. */
export function PromotePanel({ card, caps, baseStale, onBaseStale, onChanged }: {
  card: CardDetail; caps?: CardCapabilities | null; baseStale: boolean | null; onBaseStale: (v: boolean) => void; onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"promote" | "revalidate" | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [done, setDone] = useState<{ childProjectId: string; versionNumber: number; replayed: boolean } | null>(null);
  const inFlight = useRef(false);

  const promoted = ["promoted", "in_factory", "delivered"].includes(card.state);
  const ready = card.state === "ready";
  const bud = caps?.budget;
  const budState: Check = bud && bud.freeUsd != null && bud.minFreeUsd != null ? (bud.freeUsd >= bud.minFreeUsd ? "ok" : "pending") : "unknown";

  const run = async (kind: "promote" | "revalidate") => {
    if (inFlight.current) return;            // clique duplo: o segundo é descartado (o servidor também é idempotente)
    inFlight.current = true; setBusy(kind); setError(null);
    try {
      if (kind === "promote") {
        const r = await cardsApi.promote(card.id);
        setDone({ childProjectId: r.childProjectId, versionNumber: r.versionNumber, replayed: !!(r.replayed || r.resumed) });
      } else {
        await cardsApi.revalidate(card.id);
        onBaseStale(false);
      }
      await onChanged();
    } catch (e) {
      const code = cardErrorCode(e);
      if (code === "CARD_BASE_STALE") onBaseStale(true);
      setError({ code, message: cardErrorMessage(e) });
      if (code === "CARD_NOT_READY" || code === "CARD_INVALID_TRANSITION") await onChanged();
    } finally { inFlight.current = false; setBusy(null); }
  };

  if (promoted) {
    const childId = done?.childProjectId ?? card.childProjectId;
    return (
      <Alert severity="success" role="status" data-testid="promote-done">
        {card.state === "delivered" ? "Card entregue." : "Card promovido à fábrica."}{" "}
        {done?.replayed ? "A promoção já havia sido feita; nada foi duplicado. " : ""}
        {childId && <>Projeto filho: <Link component={NextLink} href={`/projects/${childId}`}>{card.executionTitle || "abrir projeto"}</Link>{done?.versionNumber ? ` (v${done.versionNumber})` : ""}. </>}
        {card.prUrl && <>PR: <Link href={card.prUrl} target="_blank" rel="noopener noreferrer">abrir no GitHub (nova aba)</Link>.</>}
      </Alert>
    );
  }
  if (!ready && !card.actions.promote) {
    return (
      <Box component="section" aria-label="Promoção">
        <Typography variant="body2" color="text.secondary">Para promover, valide a especificação do card (botão “Validar”). A promoção só fica disponível com o card em “Pronto”.</Typography>
      </Box>
    );
  }
  return (
    <Box component="section" aria-labelledby="promote-title" sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Typography id="promote-title" variant="subtitle2" component="h3" sx={{ mb: 1 }}>Promover à fábrica</Typography>
      <Box component="ul" sx={{ m: 0, p: 0, mb: 1.5, display: "grid", gap: 0.5 }} aria-label="Pré-requisitos da promoção">
        <Item state={ready ? "ok" : "pending"}>especificação do card validada e pronta.</Item>
        <Item state={budState}>saldo livre do orçamento{bud?.freeUsd != null && bud?.minFreeUsd != null ? ` (US$ ${bud.freeUsd.toFixed(2)} livres, mínimo US$ ${bud.minFreeUsd.toFixed(2)})` : " acima do mínimo exigido"}.</Item>
        <Item state={baseStale === null ? "unknown" : baseStale ? "pending" : "ok"}>base atual: o produto não mudou de versão desde a validação.</Item>
      </Box>
      {error && (
        <Alert severity={error.code === "CARD_BASE_STALE" ? "warning" : "error"} role="alert" sx={{ mb: 1.5 }}
          action={error.code === "CARD_BASE_STALE"
            ? <Button color="inherit" size="small" disabled={busy !== null} onClick={() => void run("revalidate")}>{busy === "revalidate" ? "Revalidando…" : "Revalidar"}</Button>
            : undefined}>
          {error.message}
        </Alert>
      )}
      {baseStale && !error && (
        <Alert severity="warning" sx={{ mb: 1.5 }} action={<Button color="inherit" size="small" disabled={busy !== null} onClick={() => void run("revalidate")}>Revalidar</Button>}>
          {"A base do card está vencida: o produto avançou de versão. Revalide antes de promover."}
        </Alert>
      )}
      <Button variant="contained" color="success" disabled={!card.actions.promote || busy !== null} onClick={() => void run("promote")}
        aria-describedby="promote-title">
        {busy === "promote" ? "Promovendo…" : "Promover à fábrica"}
      </Button>
    </Box>
  );
}
