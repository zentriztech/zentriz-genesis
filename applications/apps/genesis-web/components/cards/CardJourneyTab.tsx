"use client";
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorMessage } from "@/lib/cards/cardErrors";
import { NEXT_ACTION, STATE_LABEL, type CardDetail, type CardJourney, type JourneyStep } from "@/lib/cards/types";

const FLOW = ["draft", "refining", "ready", "promoted", "in_factory", "delivered"] as const;
const STEP_MARK: Record<JourneyStep["state"], string> = { done: "Concluída", current: "Etapa atual", todo: "A fazer", blocked: "Bloqueada" };

/** Fallback quando `GET /api/cards/:id/journey` (K1) ainda não existe: deriva das etapas fixas e do estado atual. */
export function deriveJourney(card: CardDetail): CardJourney {
  const idx = FLOW.indexOf(card.state as (typeof FLOW)[number]);
  const at = (s: string) => card.events.find((e) => e.to === s)?.at ?? null;
  const steps: JourneyStep[] = FLOW.map((k, i) => ({
    key: k, label: STATE_LABEL[k], at: at(k),
    state: card.state === "blocked" || card.state === "rejected" ? (at(k) ? "done" : "todo") : i < idx ? "done" : i === idx ? "current" : "todo",
  }));
  if (card.state === "blocked") steps.push({ key: "blocked", label: STATE_LABEL.blocked, state: "blocked", at: at("blocked") });
  if (card.state === "rejected") steps.push({ key: "rejected", label: STATE_LABEL.rejected, state: "current", at: at("rejected") });
  return { cardId: card.id, state: card.state, steps, nextAction: { label: NEXT_ACTION[card.state] } };
}

export function CardJourneyTab({ card }: { card: CardDetail }) {
  const [journey, setJourney] = useState<CardJourney | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assumed, setAssumed] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    cardsApi.journey(card.id)
      .then((j) => { if (!alive) return; if (j) { setJourney(j); setAssumed(false); } else { setJourney(deriveJourney(card)); setAssumed(true); } })
      .catch((e) => { if (alive) { setError(cardErrorMessage(e)); setJourney(deriveJourney(card)); setAssumed(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [card]);
  if (loading) return <CircularProgress size={24} aria-label="Carregando linha do tempo" />;
  return (
    <Box>
      {error && <Alert severity="warning" sx={{ mb: 1 }}>{error} Exibindo a linha do tempo calculada pelo portal.</Alert>}
      {assumed && !error && <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>Linha do tempo calculada a partir dos eventos do card.</Typography>}
      <Box component="ol" aria-label="Etapas do card" sx={{ p: 0, m: 0, listStyle: "none", display: "grid", gap: 0.75 }}>
        {journey?.steps.map((s) => (
          <Box component="li" key={s.key} aria-current={s.state === "current" ? "step" : undefined} data-testid={`journey-${s.key}`}
            sx={{ display: "flex", gap: 1, alignItems: "baseline", fontWeight: s.state === "current" ? 700 : 400, color: s.state === "blocked" ? "error.main" : "text.primary" }}>
            <span aria-hidden>{s.state === "done" ? "✓" : s.state === "current" ? "●" : s.state === "blocked" ? "✕" : "○"}</span>
            <span>{s.label} — {STEP_MARK[s.state]}</span>
            {s.at && <Typography variant="caption" color="text.secondary">{new Date(s.at).toLocaleString("pt-BR")}</Typography>}
          </Box>
        ))}
      </Box>
      {journey?.nextAction && <Alert severity="info" icon={false} role="note" sx={{ mt: 1.5 }}>Próxima ação: <b>{journey.nextAction.label}</b></Alert>}
      {card.state === "blocked" && card.blockedReason && <Alert severity="error" sx={{ mt: 1 }}>Motivo do bloqueio: {card.blockedReason}</Alert>}
      <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>Histórico</Typography>
      {card.events.length === 0 ? <Typography variant="body2" color="text.secondary">Sem eventos.</Typography> : (
        <Box component="ul" sx={{ m: 0, pl: 2 }}>
          {card.events.map((e, i) => (
            <li key={i}><Typography variant="body2">{new Date(e.at).toLocaleString("pt-BR")} · {e.from ? STATE_LABEL[e.from] : "—"} → {STATE_LABEL[e.to]}{e.reason ? ` (${e.reason})` : ""}</Typography></li>
          ))}
        </Box>
      )}
    </Box>
  );
}
