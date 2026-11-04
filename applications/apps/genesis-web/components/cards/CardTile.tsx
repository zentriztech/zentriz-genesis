"use client";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import BlockIcon from "@mui/icons-material/Block";
import NextLink from "next/link";
import { NEXT_ACTION, ORIGIN_LABEL, STATE_LABEL, type CardSummary } from "@/lib/cards/types";
import { blockedReasonLabel } from "@/lib/cards/cardErrors";
import { KindChip } from "./KindChip";
import { FactoryHealthChip } from "./FactoryHealth";
import { safeHttpsUrl } from "@/lib/cards/safeUrl";
import { errorTextColor } from "./CardsA11yTheme";
import { VisuallyHidden } from "./VisuallyHidden";

/** Cartão do quadro. Um único link (o título) leva ao card; ligações com spec/filho/PR são links próprios. */
export function CardTile({ card }: { card: CardSummary }) {
  const blocked = card.state === "blocked";
  const prHref = safeHttpsUrl(card.prUrl);
  return (
    <Box component="article" aria-label={`${card.code}: ${card.title}`} data-testid={`card-tile-${card.code}`}
      sx={{ border: "1px solid", borderColor: blocked ? "error.main" : "divider", borderLeftWidth: blocked ? 4 : 1, borderRadius: 1, p: 1.25, bgcolor: "background.paper", minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="caption" fontFamily="monospace" fontWeight={700}>{card.code}</Typography>
        <KindChip kind={card.kind} />
        <Chip size="small" variant="outlined" label={`Origem: ${ORIGIN_LABEL[card.origin] ?? card.origin}`} />
        <FactoryHealthChip health={card.factoryHealth} />
      </Stack>
      <Link component={NextLink} href={`/cards/${card.id}`} underline="hover" color="text.primary" fontWeight={600} variant="body2"
        sx={{ display: "block", overflowWrap: "anywhere", "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } }}>
        {card.title || "(sem título)"}
      </Link>
      {blocked && (
        <Stack direction="row" spacing={0.5} alignItems="flex-start" role="status" sx={{ mt: 0.75, color: errorTextColor }}>
          <BlockIcon sx={{ fontSize: "1rem", mt: "2px" }} aria-hidden />
          <Typography variant="caption" fontWeight={700} sx={{ color: errorTextColor }}>
            Bloqueado{card.blockedReason ? `: ${blockedReasonLabel(card.blockedReason)}` : ""}
          </Typography>
        </Stack>
      )}
      {card.codeBaseWarning && (
        <Typography variant="caption" role="status" data-testid="tile-code-base-warning" sx={{ display: "block", mt: 0.75, color: errorTextColor }}>
          Atenção: código-base copiado do disco (pode conter código não mergeado).
        </Typography>
      )}
      <Stack spacing={0.25} sx={{ mt: 0.75 }}>
        {card.draftProjectId && (
          <Typography variant="caption" color="text.secondary">
            Spec do card: <Link component={NextLink} href={`/cards/${card.id}?tab=spec`}>rascunho {card.code}</Link>
          </Typography>
        )}
        {card.childProjectId && (
          <Typography variant="caption" color="text.secondary">
            Projeto filho: <Link component={NextLink} href={`/projects/${card.childProjectId}`}>{card.executionTitle || "abrir projeto"}</Link>
            {card.executionStatus ? ` (${card.executionStatus})` : ""}
          </Typography>
        )}
        {prHref && (
          <Typography variant="caption" color="text.secondary">
            PR: <Link href={prHref} target="_blank" rel="noopener noreferrer">abrir no GitHub<VisuallyHidden> (abre em nova aba)</VisuallyHidden></Link>
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          Próxima ação: <b>{NEXT_ACTION[card.state]}</b>
          <VisuallyHidden> — estado {STATE_LABEL[card.state]}</VisuallyHidden>
        </Typography>
      </Stack>
    </Box>
  );
}
