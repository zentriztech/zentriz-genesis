"use client";

// FactoryJourney — as 4 etapas até a Fábrica (Normalizar → Validar → Revisar GAPs → Promover) com o
// estado de cada uma e UMA frase do que falta. Mesma peça no card de /specs (`compact`) e na faixa
// da Bancada em /spec (`strip`), para as duas telas contarem a mesma história.
//
// Pedido do Jean (2026-10-16): a mensagem do bloqueio era um parágrafo cru do servidor ("VNX Judge -
// Backend: Validação passou com avisos — reconheça os findings (ack) antes de promover. Clique em
// Reconhecer avisos. Ordem: Normalizar → Validar → …"). A "Ordem" virou o stepper, o título virou
// "em <spec>", e o texto completo continua acessível no ícone ⓘ (tooltip + aria) — nada sumiu.

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import type { Journey } from "@/lib/factoryJourney";

const SEVERITY_COLOR: Record<Journey["severity"], string> = {
  success: "success.main", info: "info.main", warning: "warning.main", error: "error.main",
};

function Steps({ journey, dense }: { journey: Journey; dense: boolean }) {
  const size = dense ? 16 : 20;
  const accent = SEVERITY_COLOR[journey.severity];
  return (
    <Box component="ol" aria-label="Etapas até a fábrica"
      sx={{ display: "flex", alignItems: "center", gap: 0.5, m: 0, p: 0, listStyle: "none", minWidth: 0 }}>
      {journey.steps.map((s, i) => {
        const done = s.state === "done";
        const current = s.state === "current";
        return (
          <Box component="li" key={s.key} aria-current={current ? "step" : undefined}
            sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0, flex: i < journey.steps.length - 1 ? "1 1 auto" : "0 0 auto" }}>
            <Box title={s.label} sx={{
              width: size, height: size, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: dense ? "0.6rem" : "0.7rem", fontWeight: 700,
              border: "1.5px solid",
              borderColor: done ? "success.main" : current ? accent : "divider",
              bgcolor: done ? "success.main" : "transparent",
              color: done ? "background.paper" : current ? accent : "text.disabled",
            }}>
              {done ? <CheckRoundedIcon sx={{ fontSize: dense ? "0.7rem" : "0.85rem" }} /> : i + 1}
            </Box>
            {/* No card (≈300 px) os 4 rótulos não cabem — medido, viravam "Norm…/Val…". Lá só a etapa
                ATUAL leva rótulo; as outras são o círculo (o nome completo fica no `title`). */}
            {(!dense || current) && (
            <Typography component="span" noWrap
              sx={{
                fontSize: dense ? "0.66rem" : "0.75rem", minWidth: 0,
                fontWeight: current ? 700 : 500,
                color: current ? accent : done ? "text.secondary" : "text.disabled",
              }}>
              {/* O leitor de tela ouve o estado; o visual já o mostra pelo círculo. */}
              {s.label}
              <Box component="span" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                {done ? " (feito)" : current ? " (etapa atual)" : " (pendente)"}
              </Box>
            </Typography>
            )}
            {dense && !current && (
              <Box component="span" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                {s.label}{done ? " (feito)" : " (pendente)"}
              </Box>
            )}
            {i < journey.steps.length - 1 && (
              <Box aria-hidden sx={{ flex: "1 1 8px", minWidth: 6, height: "1.5px", bgcolor: done ? "success.main" : "divider" }} />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function Headline({ journey, dense }: { journey: Journey; dense: boolean }) {
  const accent = SEVERITY_COLOR[journey.severity];
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
      <Typography variant="caption" sx={{ color: accent, fontWeight: 600, fontSize: dense ? "0.72rem" : "0.8rem", lineHeight: 1.35 }}>
        {journey.headline}
        {journey.blockingProjectTitle && (
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}> · em {journey.blockingProjectTitle}</Box>
        )}
      </Typography>
      {journey.detail && (
        <Tooltip title={journey.detail}>
          <InfoOutlinedIcon tabIndex={0} aria-label={journey.detail}
            sx={{ fontSize: "0.9rem", color: "text.secondary", flexShrink: 0, cursor: "help" }} />
        </Tooltip>
      )}
    </Stack>
  );
}

/** Card de /specs: stepper + frase. A AÇÃO fica na linha de botões do card (fonte única de ações). */
export function FactoryJourneyCompact({ journey }: { journey: Journey }) {
  if (journey.phase === "unknown") return null;
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Steps journey={journey} dense />
      <Headline journey={journey} dense />
    </Stack>
  );
}

/**
 * Faixa da Bancada em /spec: stepper + frase + o botão da etapa atual. O botão aqui é o MESMO
 * comando da barra de cima (mesmo handler) — está colado na explicação de por que ele é o próximo.
 */
export function FactoryJourneyStrip({
  journey, onAction, busy = false, disabled = false,
}: {
  journey: Journey;
  onAction?: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  if (journey.phase === "unknown") return null;
  const color = journey.severity === "error" ? "error" : journey.severity === "warning" ? "warning" : journey.severity === "success" ? "success" : "info";
  return (
    <Box role="status" aria-live="polite"
      sx={{
        display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5, rowGap: 1,
        px: 1.5, py: 1, mb: 2, border: "1px solid", borderColor: "divider", borderRadius: 1,
        borderLeft: "3px solid", borderLeftColor: SEVERITY_COLOR[journey.severity], bgcolor: "background.paper",
      }}>
      {/* Abaixo de 1200 px os 4 rótulos cortavam ("Normali…") — lá vale a forma compacta do card. */}
      <Box sx={{ flex: "1 1 340px", minWidth: 0, maxWidth: 560, display: { xs: "none", lg: "block" } }}>
        <Steps journey={journey} dense={false} />
      </Box>
      <Box sx={{ flex: "1 1 200px", minWidth: 0, maxWidth: 360, display: { xs: "block", lg: "none" } }}>
        <Steps journey={journey} dense />
      </Box>
      <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
        <Headline journey={journey} dense={false} />
      </Box>
      {journey.actionLabel && onAction && (
        <Button size="small" variant="contained" color={color} disabled={disabled || busy}
          onClick={onAction}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ textTransform: "none", whiteSpace: "nowrap", flexShrink: 0, ml: "auto" }}>
          {journey.actionLabel}
        </Button>
      )}
    </Box>
  );
}
