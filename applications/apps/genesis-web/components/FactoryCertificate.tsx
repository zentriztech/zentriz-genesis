"use client";

// PR3 do Certificado Genesis Factory — UI do selo que projeta os gates REAIS da fábrica
// (services/factoryCertificate.ts, que por sua vez projeta runnerDispatch.ts).
//
// Princípios que a UI precisa respeitar (os riscos do desenho adversarial):
//   • A1 — o chip não interpreta nada: renderiza `level`/`message`/`checks` como vieram.
//     Nenhuma regra de negócio aqui, ou o selo volta a poder divergir do dispatch.
//   • A2 — quando `gateEnforced === false`, o popover diz explicitamente que a promoção
//     NÃO é barrada hoje. Prometer barreira inexistente seria mentir de novo.
//   • A3 — o texto fala de FORMATO aceito, nunca de sucesso garantido de fabricação.
//   • A7 — `certified_with_acks` é visualmente distinto (outlined) e lista as ressalvas.
//   • D2(b) — o selo Connect é separado e não altera o nível.
//
// Com `FACTORY_CERTIFICATE=off` a API não manda o campo → nada disto aparece (as telas
// caem no `ReadinessBadge` legado).

import { useState } from "react";
import Chip from "@mui/material/Chip";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Popover from "@mui/material/Popover";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import VerifiedRoundedIcon from "@mui/icons-material/VerifiedRounded";
import HistoryToggleOffRoundedIcon from "@mui/icons-material/HistoryToggleOffRounded";
import BlockRoundedIcon from "@mui/icons-material/BlockRounded";
import HelpCenterRoundedIcon from "@mui/icons-material/HelpCenterRounded";

export type FactoryCertificateLevel = "certified" | "certified_with_acks" | "stale" | "blocked" | "unknown";
export interface FactoryCertificateCheck {
  id: string;
  label: string;
  /** `null` = indeterminado (não há como afirmar — ex.: sem validação para o hash atual). */
  ok: boolean | null;
  detail?: string;
}
export interface FactoryCertificate {
  level: FactoryCertificateLevel;
  code: string | null;
  message: string;
  specHash: string | null;
  checks: FactoryCertificateCheck[];
  caveats: string[];
  connect: { level: "connect_ready" | "incomplete" | "absent"; missing: string[] };
  gateEnforced: boolean;
  activeBlockers: number;
  activeWarnings: number;
}
export interface ProductFactoryCertificate {
  level: FactoryCertificateLevel;
  certified: number;
  total: number;
  withCaveats: number;
  blocked: number;
  stale: number;
  unknown: number;
  connectReady: number;
  message: string;
}

type ChipColor = "success" | "warning" | "error" | "default";
const LEVEL_META: Record<
  FactoryCertificateLevel,
  { label: string; color: ChipColor; variant: "filled" | "outlined"; Icon: typeof VerifiedRoundedIcon }
> = {
  certified: { label: "Genesis Factory", color: "success", variant: "filled", Icon: VerifiedRoundedIcon },
  // A7: mesmo rótulo, moldura vazada — certificado COM ressalva humana não é certificado pleno.
  certified_with_acks: { label: "Genesis Factory · com ressalvas", color: "success", variant: "outlined", Icon: VerifiedRoundedIcon },
  stale: { label: "Revalidar", color: "warning", variant: "outlined", Icon: HistoryToggleOffRoundedIcon },
  blocked: { label: "Fábrica recusa", color: "error", variant: "outlined", Icon: BlockRoundedIcon },
  unknown: { label: "Sem certificado", color: "default", variant: "outlined", Icon: HelpCenterRoundedIcon },
};

const CONNECT_META: Record<FactoryCertificate["connect"]["level"], { label: string; color: ChipColor }> = {
  connect_ready: { label: "Connect-ready", color: "success" },
  incomplete: { label: "Connect incompleto", color: "warning" },
  absent: { label: "sem connect.yaml", color: "default" },
};

function CheckIcon({ ok }: { ok: boolean | null }) {
  if (ok === true) return <CheckCircleIcon sx={{ fontSize: "1rem", color: "#22C55E", mt: "1px" }} />;
  if (ok === false) return <CancelIcon sx={{ fontSize: "1rem", color: "#EF4444", mt: "1px" }} />;
  return <HelpOutlineIcon sx={{ fontSize: "1rem", color: "#94A3B8", mt: "1px" }} />;
}

/**
 * Chip do certificado de UMA spec. Clicável: abre o detalhamento dos checks que a fábrica
 * aplica, as ressalvas (se houver) e o selo Connect.
 */
export function FactoryCertificateBadge({
  certificate,
  compact = false,
}: {
  certificate: FactoryCertificate;
  compact?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const meta = LEVEL_META[certificate.level] ?? LEVEL_META.unknown;
  const { Icon } = meta;
  const connectMeta = CONNECT_META[certificate.connect?.level ?? "absent"];
  return (
    <>
      <Tooltip title={certificate.message}>
        <Chip
          size="small"
          color={meta.color}
          variant={meta.variant}
          icon={<Icon sx={{ fontSize: "0.85rem !important" }} />}
          label={compact ? meta.label.split(" · ")[0] : meta.label}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ fontSize: "0.62rem", height: 20, fontWeight: 700, cursor: "pointer", "& .MuiChip-icon": { ml: 0.5 } }}
        />
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1.5, maxWidth: 380 }}>
          <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>
            Certificado Genesis Factory
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, lineHeight: 1.4 }}>
            {certificate.message}
          </Typography>

          <Stack spacing={1}>
            {certificate.checks.map((c) => (
              <Box key={c.id} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <CheckIcon ok={c.ok} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" fontWeight={600} sx={{ display: "block" }}>{c.label}</Typography>
                  {c.detail && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.4 }}>
                      {c.detail}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
          </Stack>

          {certificate.caveats.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" fontWeight={700} sx={{ display: "block", mb: 0.5 }}>
                Ressalvas (decisão humana, auditada)
              </Typography>
              {certificate.caveats.map((c) => (
                <Typography key={c} variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.4 }}>
                  • {c}
                </Typography>
              ))}
            </>
          )}

          <Divider sx={{ my: 1 }} />
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            {/* D2(b): selo separado — não entra no veredito do certificado. */}
            <Tooltip
              title={
                certificate.connect.missing.length > 0
                  ? `Declaração Connect sem: ${certificate.connect.missing.join(", ")}`
                  : "Declaração Connect com todas as chaves obrigatórias presentes."
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={connectMeta.color}
                label={connectMeta.label}
                sx={{ fontSize: "0.6rem", height: 18 }}
              />
            </Tooltip>
            {certificate.specHash && (
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: "0.6rem" }}>
                spec {certificate.specHash.slice(0, 8)}
              </Typography>
            )}
          </Stack>

          {/* A2: com o gate desligado, o certificado é informativo — a promoção não é barrada. */}
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1, lineHeight: 1.4 }}>
            {certificate.gateEnforced
              ? "A fábrica barra a promoção enquanto a spec não passar nestes checks."
              : "O bloqueio por spec está desligado: a promoção não é barrada hoje — o certificado é informativo."}
          </Typography>
          {/* A3: formato aceito ≠ sucesso garantido. */}
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, lineHeight: 1.4 }}>
            O selo atesta que a spec está no formato que a fábrica aceita — não garante o sucesso da fabricação.
          </Typography>
        </Box>
      </Popover>
    </>
  );
}

/**
 * Chip agregado de um PRODUTO. A6: nunca porcentagem — sempre `n/m` explícito, e o nível
 * é o AND dos projetos (um blocker derruba o produto inteiro).
 */
export function ProductCertificateChip({ certificate }: { certificate: ProductFactoryCertificate }) {
  const meta = LEVEL_META[certificate.level] ?? LEVEL_META.unknown;
  const { Icon } = meta;
  return (
    <Tooltip title={certificate.message}>
      <Chip
        size="small"
        color={meta.color}
        variant={certificate.level === "certified" ? "filled" : "outlined"}
        icon={<Icon sx={{ fontSize: "0.85rem !important" }} />}
        label={`Factory ${certificate.certified}/${certificate.total}`}
        sx={{ fontSize: "0.62rem", height: 20, fontWeight: 700, "& .MuiChip-icon": { ml: 0.5 } }}
      />
    </Tooltip>
  );
}

/** Os níveis que valem como "tem selo" — usado na triagem da Bancada (D1a). */
export function isCertified(level: FactoryCertificateLevel | undefined | null): boolean {
  return level === "certified" || level === "certified_with_acks";
}
