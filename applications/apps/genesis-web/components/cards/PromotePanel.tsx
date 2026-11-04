"use client";
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
import type { CardDetail, CardJourney } from "@/lib/cards/types";
import { VisuallyHidden } from "./VisuallyHidden";
import type { CardRunner } from "./useCardRunner";

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

const BUDGET_CODES = /^(BUDGET_|CARD_BUDGET_BLOCKED|KILL_SWITCH|GLOBAL_|GUARD_ERROR|REPEAT_PAYLOAD|UNATTRIBUTED_|TENANT_LLM_|PROJECT_NOT_FOUND)/;

/** Pré-requisitos da promoção, lidos dos `blockers` do servidor (a tela não recalcula saldo nem base). */
export function promoteChecks(card: CardDetail, journey: CardJourney | null): { spec: Check; budget: Check; base: Check } {
  if (!journey) return { spec: card.state === "ready" ? "ok" : "pending", budget: "unknown", base: "unknown" };
  const codes = journey.blockers.map((b) => b.code);
  return {
    spec: card.state === "ready" && !codes.includes("CARD_NOT_READY") ? "ok" : "pending",
    budget: codes.some((c) => BUDGET_CODES.test(c)) ? "pending" : "ok",
    base: journey.base?.stale || codes.includes("CARD_BASE_STALE") ? "pending" : "ok",
  };
}

/** Promover (3.5): pré-requisitos visíveis (do servidor), base vencida com “Revalidar”, clique duplo sem duplicar, ligação com o filho e o PR. */
export function PromotePanel({ card, journey, runner }: { card: CardDetail; journey: CardJourney | null; runner: CardRunner }) {
  const { busy, run, error, promoted: done } = runner;
  const promotedState = ["promoted", "in_factory", "delivered"].includes(card.state);
  const ready = card.state === "ready";
  const checks = promoteChecks(card, journey);
  const blocked = journey ? journey.blockers.length > 0 : false;

  if (promotedState) {
    const childId = done?.childProjectId ?? card.childProjectId;
    const prUrl = journey?.execution?.prUrl ?? card.prUrl;
    return (
      <Alert severity="success" role="status" data-testid="promote-done">
        {card.state === "delivered" ? "Card entregue." : "Card promovido à fábrica."}{" "}
        {done?.replayed ? "A promoção já havia sido feita; nada foi duplicado. " : ""}
        {childId && <>Projeto filho: <Link component={NextLink} href={`/projects/${childId}`}>{card.executionTitle || "abrir projeto"}</Link>{done?.versionNumber ? ` (v${done.versionNumber})` : ""}. </>}
        {prUrl && <>PR: <Link href={prUrl} target="_blank" rel="noopener noreferrer">abrir no GitHub<VisuallyHidden> (abre em nova aba)</VisuallyHidden></Link>.</>}
      </Alert>
    );
  }
  const staleError = error?.code === "CARD_BASE_STALE" ? error : null;
  const revalidateBtn = card.actions.revalidate ? (
    <Button color="inherit" size="small" disabled={busy !== null} onClick={() => void run("revalidate")} sx={{ minHeight: 32 }}>{busy === "revalidate" ? "Revalidando…" : "Revalidar agora"}</Button>
  ) : undefined;
  const banners = staleError && (
    <Alert severity="warning" role="alert" sx={{ mb: 1.5 }} action={revalidateBtn}>{staleError.message}</Alert>
  );
  if (!ready && !card.actions.promote) {
    return (
      <Box component="section" aria-label="Promoção">
        {banners}
        <Typography variant="body2" color="text.secondary">Para promover, valide a especificação do card (botão “Validar”). A promoção só fica disponível com o card em “Pronto”.</Typography>
      </Box>
    );
  }
  return (
    <Box component="section" aria-labelledby="promote-title" sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Typography id="promote-title" variant="subtitle2" component="h3" sx={{ mb: 1 }}>Promover à fábrica</Typography>
      <Box component="ul" sx={{ m: 0, p: 0, mb: 1.5, display: "grid", gap: 0.5 }} aria-label="Pré-requisitos da promoção">
        <Item state={checks.spec}>especificação do card validada e pronta.</Item>
        <Item state={checks.budget}>saldo livre do orçamento da versão corrente, conforme o servidor.</Item>
        <Item state={checks.base}>base atual: o produto não mudou de versão desde a validação.</Item>
      </Box>
      {banners}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" color="success" disabled={!card.actions.promote || busy !== null || blocked} onClick={() => void run("promote")} aria-describedby="promote-title">
          {busy === "promote" ? "Promovendo…" : "Promover à fábrica"}
        </Button>
        {card.actions.revalidate && (
          <Button variant="outlined" disabled={busy !== null} onClick={() => void run("revalidate")}>{busy === "revalidate" ? "Revalidando…" : "Revalidar"}</Button>
        )}
      </Stack>
      {blocked && <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.75 }}>A promoção está indisponível enquanto houver bloqueio na situação do card (acima).</Typography>}
    </Box>
  );
}
