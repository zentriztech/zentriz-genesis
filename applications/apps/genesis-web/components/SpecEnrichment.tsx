"use client";

// UI compartilhada dos enriquecimentos determinísticos da Bancada (RFC-0003 E2/E3).
// Os tipos espelham o backend (services/specEnrichment.ts); nada aqui usa LLM.
//   • ReadinessBadge — chip de prontidão + pré-flight (4 checks) em popover.
//   • EstimateChip   — estimativa de tempo/custo com a base (histórico vs aproximada).
//   • formatDuration / formatCost — formatadores puros, reusados na tela de produtos.

import { useState } from "react";
import Chip from "@mui/material/Chip";
import Box from "@mui/material/Box";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import ScheduleIcon from "@mui/icons-material/Schedule";

export type ReadinessLevel = "not_ready" | "almost" | "ready";
export interface ReadinessCheck { key: string; label: string; ok: boolean; hint: string }
export interface Readiness { score: number; level: ReadinessLevel; checks: ReadinessCheck[] }
export interface Estimate {
  durationSec: number;
  costUsd: number;
  basis: "history" | "default";
  sampleSize: number;
  complexity: string;
}

// ── Formatadores puros ────────────────────────────────────────────────────────
export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "—";
  if (sec < 90 * 60) return `~${Math.round(sec / 60)} min`;
  const h = sec / 3600;
  if (h < 16) return `~${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `~${(sec / 86400).toFixed(1)} d`;
}
export function formatCost(usd: number): string {
  if (usd == null) return "—";
  const digits = usd < 10 ? 2 : 0;
  return `~US$ ${usd.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
}

const LEVEL_META: Record<ReadinessLevel, { label: string; color: "success" | "warning" | "default" }> = {
  ready: { label: "Pronta", color: "success" },
  almost: { label: "Quase", color: "warning" },
  not_ready: { label: "Incompleta", color: "default" },
};

// Chip clicável que abre o pré-flight (os 4 checks + dica de cada pendência).
export function ReadinessBadge({ readiness, compact = false }: { readiness: Readiness; compact?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const meta = LEVEL_META[readiness.level];
  return (
    <>
      <Chip
        size="small"
        color={meta.color}
        variant={readiness.level === "not_ready" ? "outlined" : "filled"}
        label={compact ? `${readiness.score}%` : `${meta.label} · ${readiness.score}%`}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ fontSize: "0.62rem", height: 20, fontWeight: 700, cursor: "pointer" }}
      />
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1.5, maxWidth: 320 }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: "block", mb: 1 }}>
            Pré-flight de promoção
          </Typography>
          <Stack spacing={1}>
            {readiness.checks.map((c) => (
              <Box key={c.key} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                {c.ok
                  ? <CheckCircleIcon sx={{ fontSize: "1rem", color: "#22C55E", mt: "1px" }} />
                  : <CancelIcon sx={{ fontSize: "1rem", color: "#EF4444", mt: "1px" }} />}
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" fontWeight={600} sx={{ display: "block" }}>{c.label}</Typography>
                  {!c.ok && c.hint && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.4 }}>
                      {c.hint}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
          </Stack>
        </Box>
      </Popover>
    </>
  );
}

// Chip de estimativa (tempo · custo) com tooltip sobre a base do cálculo.
export function EstimateChip({ estimate }: { estimate: Estimate }) {
  const basisText =
    estimate.basis === "history"
      ? `Baseado em ${estimate.sampleSize} execução(ões) real(is) de complexidade "${estimate.complexity}".`
      : `Estimativa aproximada por complexidade "${estimate.complexity}" — ainda sem histórico similar.`;
  return (
    <Tooltip title={basisText}>
      <Chip
        size="small"
        variant="outlined"
        icon={<ScheduleIcon sx={{ fontSize: "0.8rem !important" }} />}
        label={`${formatDuration(estimate.durationSec)} · ${formatCost(estimate.costUsd)}`}
        sx={{
          fontSize: "0.62rem",
          height: 20,
          borderStyle: estimate.basis === "history" ? "solid" : "dashed",
          color: "text.secondary",
        }}
      />
    </Tooltip>
  );
}
