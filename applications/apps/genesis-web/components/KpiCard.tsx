"use client";
/**
 * KpiCard — card de indicador do painel (Épico Spec/Bancada, Onda 5 §4.4).
 *
 * Extraído do `StatCard` local de `app/(dashboard)/dashboard/page.tsx` e estendido:
 *   - `hint`      → definição do KPI em Tooltip (ícone ⓘ só a partir de `sm`);
 *   - `delta`     → variação vs. período anterior com SETA + sinal (nunca só cor);
 *   - `progress`  → 0–1 em `LinearProgress` (sem gauge/donut — NN/g);
 *   - `loading`   → Skeleton (o chamador só liga no 1º load: refresh sem flicker);
 *   - `href`      → card inteiro navegável (CardActionArea, acessível por teclado);
 *   - `tone`      → default|success|warning|error — muda acento e cor do valor,
 *                   sempre acompanhado de ícone/texto (cor nunca é o único sinal);
 *   - `sub`/`footer` → linha secundária curta / conteúdo extra (ex.: top modelos).
 * `prefers-reduced-motion` desliga a animação do framer-motion.
 * Em `xs` o valor cai para `h5` e o rótulo fica em 1 linha (`noWrap`).
 */
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Theme } from "@mui/material/styles";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import RemoveIcon from "@mui/icons-material/Remove";
import { formatDelta } from "@/lib/format";

const MotionCard = motion(Card);

export type KpiTone = "default" | "success" | "warning" | "error";

export interface KpiCardProps {
  label: string;
  /** Valor já formatado (string) ou número; null/undefined → "—". */
  value: string | number | null | undefined;
  icon: ReactNode;
  /** Gradiente CSS do acento superior (mantido do StatCard original). Ignorado quando `tone` ≠ default. */
  gradient?: string;
  delay?: number;
  /** Definição do KPI (Tooltip) — texto ou nó (ex.: lista compacta). */
  hint?: ReactNode;
  /** Variação absoluta vs. período anterior (ex.: entregues 30 d − 30 d anteriores). */
  delta?: number | null;
  /** Rótulo curto do delta, ex.: "vs. 30 d anteriores". */
  deltaLabel?: string;
  /** Direção "boa" do delta: colore a seta (success/error). Sem isso, cor neutra. */
  deltaGood?: "up" | "down";
  /** Razão 0–1 para barra linear. */
  progress?: number | null;
  loading?: boolean;
  href?: string;
  tone?: KpiTone;
  /** Linha secundária curta sob o valor (ex.: "3 na fila"). */
  sub?: string;
  /** Conteúdo extra no rodapé (lista compacta). */
  footer?: ReactNode;
}

const TONE_GRADIENT: Record<Exclude<KpiTone, "default">, string> = {
  success: "linear-gradient(135deg, #10B981 0%, #059669 100%)",
  warning: "linear-gradient(135deg, #F59E0B 0%, #D97706 100%)",
  error:   "linear-gradient(135deg, #EF4444 0%, #DC2626 100%)",
};

/** Cor de texto do tom com contraste AA nos dois temas (light usa a variante `dark`). */
function toneTextColor(tone: KpiTone) {
  if (tone === "default") return undefined;
  return (theme: Theme) => (theme.palette.mode === "dark" ? theme.palette[tone].light : theme.palette[tone].dark);
}

export function KpiCard({
  label, value, icon, gradient, delay = 0, hint, delta, deltaLabel, deltaGood,
  progress, loading = false, href, tone = "default", sub, footer,
}: KpiCardProps) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  const accent = tone === "default"
    ? (gradient ?? "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)")
    : TONE_GRADIENT[tone];
  const shown = value === null || value === undefined || value === "" ? "—" : value;
  const d = formatDelta(delta);
  const deltaColor = (() => {
    if (!d || d.direction === "flat" || !deltaGood) return "text.secondary";
    return d.direction === deltaGood ? toneTextColor("success") : toneTextColor("error");
  })();
  const pct = progress === null || progress === undefined || !Number.isFinite(progress)
    ? null
    : Math.max(0, Math.min(100, Math.round(progress * 100)));

  const motionProps = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0, transition: { delay: delay * 0.06, duration: 0.3 } },
        whileHover: { y: -2, transition: { duration: 0.15 } },
      };

  const body = (
    <CardContent sx={{ pt: 1.5, px: { xs: 1.5, sm: 2 }, pb: { xs: "12px !important", sm: "16px !important" }, height: "100%" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ minWidth: 0 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap
              sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: { xs: "0.62rem", sm: "0.72rem" } }}>
              {label}
            </Typography>
            {hint && (
              <Tooltip title={hint} arrow enterTouchDelay={0} leaveTouchDelay={4000}>
                <InfoOutlinedIcon
                  aria-label={`Definição: ${label}`}
                  sx={{ fontSize: "0.85rem", color: "text.disabled", display: { xs: "none", sm: "inline-flex" }, cursor: "help", flexShrink: 0 }}
                />
              </Tooltip>
            )}
          </Stack>

          {loading ? (
            <Skeleton variant="text" width="60%" sx={{ fontSize: { xs: "1.5rem", sm: "2.125rem" }, mt: 0.5 }} />
          ) : (
            <Typography
              component="div"
              fontWeight={700}
              sx={{
                mt: 0.5, lineHeight: 1.1, overflowWrap: "anywhere",
                typography: { xs: "h5", sm: "h4" },
                color: toneTextColor(tone),
              }}
            >
              {shown}
            </Typography>
          )}

          {!loading && (d || sub) && (
            <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5, minWidth: 0 }}>
              {d && (
                <Stack direction="row" alignItems="center" spacing={0.25} sx={{ color: deltaColor, flexShrink: 0 }}
                  aria-label={`Variação ${d.text}${deltaLabel ? ` ${deltaLabel}` : ""}`}>
                  {d.direction === "up" && <ArrowUpwardIcon sx={{ fontSize: "0.85rem" }} />}
                  {d.direction === "down" && <ArrowDownwardIcon sx={{ fontSize: "0.85rem" }} />}
                  {d.direction === "flat" && <RemoveIcon sx={{ fontSize: "0.85rem" }} />}
                  <Typography variant="caption" fontWeight={600} sx={{ color: "inherit" }}>{d.text}</Typography>
                  {deltaLabel && (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "inline" } }}>
                      {deltaLabel}
                    </Typography>
                  )}
                </Stack>
              )}
              {sub && (
                <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, fontSize: { xs: "0.62rem", sm: "0.72rem" } }}>
                  {sub}
                </Typography>
              )}
            </Stack>
          )}
        </Box>

        <Box sx={{
          width: { xs: 32, sm: 40 }, height: { xs: 32, sm: 40 }, borderRadius: "10px", background: accent + "22", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center", "& svg": { fontSize: { xs: "1.05rem", sm: "1.25rem" } },
        }}>
          {icon}
        </Box>
      </Stack>

      {pct !== null && !loading && (
        <LinearProgress
          variant="determinate"
          value={pct}
          color={tone === "default" ? "primary" : tone}
          aria-label={`${label}: ${pct}%`}
          sx={{ mt: 1.25, height: 4, borderRadius: 2, bgcolor: "divider" }}
        />
      )}
      {footer && !loading && <Box sx={{ mt: 1 }}>{footer}</Box>}
    </CardContent>
  );

  return (
    <MotionCard {...motionProps} sx={{ overflow: "hidden", height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ height: 3, background: accent, flexShrink: 0 }} />
      {href ? (
        <CardActionArea onClick={() => router.push(href)} aria-label={`${label}: abrir`} sx={{ flex: 1, alignItems: "stretch" }}>
          {body}
        </CardActionArea>
      ) : body}
    </MotionCard>
  );
}

export default KpiCard;
