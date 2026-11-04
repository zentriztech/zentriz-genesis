"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { STATE_LABEL, type CardDetail, type CardJourney, type JourneyStep } from "@/lib/cards/types";
import { blockedReasonLabel, eventReasonLabel } from "@/lib/cards/cardErrors";

const STEP_MARK: Record<JourneyStep["state"], string> = { done: "Concluída", current: "Etapa atual", todo: "A fazer", blocked: "Bloqueada" };

/** Aba “Estado”: etapas e próxima etapa vêm do servidor (`journey`); o histórico vem dos eventos do card (mais recente primeiro). */
export function CardJourneyTab({ card, journey, error, loading = false }: { card: CardDetail; journey: CardJourney | null; error: string | null; loading?: boolean }) {
  const next = journey?.steps.find((s) => s.key === journey.next);
  return (
    <Box>
      {loading && !journey && <Box sx={{ py: 1 }}><CircularProgress size={20} aria-label="Carregando a situação do card" /></Box>}
      {error && !journey && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
      {journey && (
        <>
          <Box component="ol" aria-label="Etapas do card" sx={{ p: 0, m: 0, listStyle: "none", display: "grid", gap: 0.75 }}>
            {journey.steps.map((s) => (
              <Box component="li" key={s.key} aria-current={s.state === "current" || s.state === "blocked" ? "step" : undefined} data-testid={`journey-${s.key}`}
                sx={{ display: "flex", gap: 1, alignItems: "baseline", fontWeight: s.state === "current" || s.state === "blocked" ? 700 : 400, color: s.state === "blocked" ? "error.main" : "text.primary" }}>
                <span aria-hidden>{s.state === "done" ? "✓" : s.state === "current" ? "●" : s.state === "blocked" ? "✕" : "○"}</span>
                <span>{s.label} — {STEP_MARK[s.state]}</span>
              </Box>
            ))}
          </Box>
          {next && <Typography variant="body2" sx={{ mt: 1.5 }} data-testid="journey-next">Próxima etapa: <b>{next.label}</b></Typography>}
          {journey.action && <Alert severity="info" icon={false} role="note" sx={{ mt: 1.5 }}>Ação sugerida: <b>{journey.action.label}</b>{journey.action.enabled ? "" : " (indisponível agora)"}</Alert>}
          {journey.phase === "rejected" && <Alert severity="warning" sx={{ mt: 1.5 }}>Card recusado: ele saiu da trilha e não será promovido.</Alert>}
        </>
      )}
      {card.state === "blocked" && <Alert severity="error" sx={{ mt: 1 }}>Motivo do bloqueio: {blockedReasonLabel(card.blockedReason)}</Alert>}
      <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>Histórico</Typography>
      {card.events.length === 0 ? <Typography variant="body2" color="text.secondary">Sem eventos.</Typography> : (
        <Box component="ul" sx={{ m: 0, pl: 2 }}>
          {card.events.map((e, i) => (
            <li key={i}><Typography variant="body2">{new Date(e.at).toLocaleString("pt-BR")} · {e.from ? STATE_LABEL[e.from] : "—"} → {STATE_LABEL[e.to]}{e.reason ? ` (${eventReasonLabel(e.reason)})` : ""}</Typography></li>
          ))}
        </Box>
      )}
    </Box>
  );
}
