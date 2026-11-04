"use client";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import NextLink from "next/link";
import type { CardDetail, CardJourney, JourneyAction, RevalidateResponse } from "@/lib/cards/types";
import { blockedReasonLabel } from "@/lib/cards/cardErrors";
import { safeHttpsUrl } from "@/lib/cards/safeUrl";
import { VisuallyHidden } from "./VisuallyHidden";
import type { CardRunner, RunKey } from "./useCardRunner";
import type { CardTab } from "./CardDetailView";

/** Ações sugeridas pelo servidor (`journey.action.key`) que o portal executa direto pela API de cards. */
const RUNNABLE: Partial<Record<string, RunKey>> = { ready: "ready", promote: "promote", revalidate: "revalidate", reopen: "reopen", resume: "resume" };
/** Ações que levam o usuário a outra aba (editar o RFC com a IA, corrigir o RFC). */
const GO_SPEC = new Set(["edit_rfc"]);

/** `/api/projects/<id>/budget` → página do projeto dono do orçamento. */
export function budgetProjectHref(action: JourneyAction): string | null {
  const m = /^\/api\/projects\/([^/]+)\/budget$/.exec(action.path ?? "");
  return m ? `/projects/${m[1]}` : null;
}

function SuggestedAction({ action, runner, onTab, onGenerateRfc }: { action: JourneyAction; runner: CardRunner; onTab: (t: CardTab) => void; onGenerateRfc?: () => void }) {
  // “Promover à fábrica” já tem o botão próprio do painel de promoção (com os pré-requisitos): aqui só o apontamento em texto.
  if (action.key === "promote") return <Typography variant="body2">{action.label} (botão abaixo)</Typography>;
  const key = RUNNABLE[action.key];
  const href = action.key === "increase_budget" ? budgetProjectHref(action) : null;
  if (key) {
    return <Button size="small" variant="outlined" color="inherit" disabled={!action.enabled || !!runner.busy} onClick={() => void runner.run(key)} sx={{ minHeight: 32 }}>{action.label}</Button>;
  }
  // “Gerar o RFC com a IA”: chama o planner de RFC (evolution-plan) na aba Especificação, que mostra o progresso e o resultado.
  if (action.key === "generate_rfc" && onGenerateRfc) {
    return <Button size="small" variant="outlined" color="inherit" disabled={!action.enabled || !!runner.busy} onClick={onGenerateRfc} sx={{ minHeight: 32 }}>{action.label}</Button>;
  }
  if (GO_SPEC.has(action.key) || action.key === "generate_rfc") {
    return <Button size="small" variant="outlined" color="inherit" disabled={!action.enabled} onClick={() => onTab("spec")} sx={{ minHeight: 32 }}>{action.label}</Button>;
  }
  if (href) {
    return <Button size="small" variant="outlined" color="inherit" component={NextLink} href={href} disabled={!action.enabled} sx={{ minHeight: 32 }}>{action.label}<VisuallyHidden> (abre a página do projeto dono do orçamento)</VisuallyHidden></Button>;
  }
  return <Typography variant="body2">{action.label}</Typography>;
}

/** Resultado de “Revalidar”: ok (alinhado), stale (rebaseado, validar de novo) ou conflict (ajustar o RFC), com os motivos do servidor. */
export function RevalidateResult({ r }: { r: RevalidateResponse }) {
  const severity = r.result === "ok" ? "success" : r.result === "stale" ? "warning" : "error";
  const title = r.result === "ok" ? "Base alinhada" : r.result === "stale" ? "Base atualizada: valide o card de novo" : "Conflito com a versão corrente";
  return (
    <Alert severity={severity} role={r.result === "conflict" ? "alert" : "status"} data-testid={`revalidate-${r.result}`} sx={{ mt: 1.5 }}>
      <AlertTitle>{title}</AlertTitle>
      {r.message}
      {r.reasons.length > 0 && (
        <Box component="ul" aria-label="Motivos da revalidação" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {r.reasons.map((x, i) => (
            <li key={`${x.code}-${i}`}><Typography variant="body2" component="span"><b>{x.severity === "conflict" ? "Conflito" : x.severity === "warning" ? "Atenção" : "Informação"}:</b> {x.message}</Typography></li>
          ))}
        </Box>
      )}
      {r.reopened && <Typography variant="body2" sx={{ mt: 0.5 }}>O card voltou a “Refinando” para você ajustar o RFC.</Typography>}
    </Alert>
  );
}

/**
 * Situação do card segundo o SERVIDOR (`GET /api/cards/:id/journey`): `headline` + `detail`, `blockers` (o que impede a próxima etapa),
 * `action` (próxima ação sugerida), PR/execução e base vencida. A tela não recalcula nada disso.
 */
export function CardStatusPanel({ card, journey, journeyError, runner, onTab, onGenerateRfc, onReloadJourney }: {
  card: CardDetail; journey: CardJourney | null; journeyError: string | null; runner: CardRunner; onTab: (t: CardTab) => void; onGenerateRfc?: () => void; onReloadJourney: () => void;
}) {
  if (!journey) {
    return journeyError
      ? <Alert severity="warning" role="status" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={onReloadJourney}>Tentar de novo</Button>}>{journeyError} Os botões abaixo seguem valendo; o servidor confere cada ação.</Alert>
      : null;
  }
  const exec = journey.execution;
  const prUrl = safeHttpsUrl(exec?.prUrl ?? card.prUrl);
  return (
    <Box component="section" aria-label="Situação do card" data-testid="card-status" sx={{ mb: 1 }}>
      <Alert severity={journey.severity} role="status" sx={{ alignItems: "flex-start", "& .MuiAlert-message": { minWidth: 0, overflowWrap: "anywhere" } }}>
        <AlertTitle data-testid="journey-headline">{journey.headline}</AlertTitle>
        {journey.detail && <Typography variant="body2" data-testid="journey-detail">{journey.detail}</Typography>}
        {journey.blocked && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            Motivo do bloqueio: <b>{blockedReasonLabel(journey.blocked.reason)}</b>{journey.blocked.resumable ? "" : " (não pode ser retomado)"}
          </Typography>
        )}
        {journey.blockers.length > 0 && (
          <Box sx={{ mt: 0.75 }}>
            <Typography variant="body2" fontWeight={700} id="blockers-title">O que impede a próxima etapa{journey.next ? ` (${journey.steps.find((x) => x.key === journey.next)?.label ?? journey.next})` : ""}:</Typography>
            <Box component="ul" aria-labelledby="blockers-title" data-testid="journey-blockers" sx={{ m: 0, pl: 2.5 }}>
              {journey.blockers.map((b, i) => (
                <li key={`${b.code}-${i}`}>
                  <Typography variant="body2" component="span">{b.userMessage ?? b.message}</Typography>
                  {b.userMessage && b.message && b.message !== b.userMessage && <Typography variant="caption" component="span" sx={{ color: "inherit" }}> {b.message}</Typography>}
                </li>
              ))}
            </Box>
          </Box>
        )}
        {journey.action && <Box sx={{ mt: 1 }} data-testid="journey-action"><SuggestedAction action={journey.action} runner={runner} onTab={onTab} onGenerateRfc={onGenerateRfc} /></Box>}
        {journey.action && !journey.action.enabled && <Typography variant="caption" component="p" sx={{ mt: 0.5 }}>Próxima ação sugerida (indisponível agora): {journey.action.label}</Typography>}
      </Alert>
      {(exec || prUrl) && (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
          {exec && <Typography variant="body2">Execução: <Link component={NextLink} href={`/projects/${exec.childProjectId}`}>{exec.title || "abrir projeto filho"}</Link> ({exec.status})</Typography>}
          {prUrl && <Typography variant="body2">PR: <Link href={prUrl} target="_blank" rel="noopener noreferrer" data-testid="pr-link">abrir no GitHub<VisuallyHidden> (abre em nova aba)</VisuallyHidden></Link></Typography>}
        </Stack>
      )}
      {journey.base?.stale && (
        <Alert severity="warning" sx={{ mt: 1 }} data-testid="base-stale"
          action={card.actions.revalidate && journey.action?.key !== "revalidate" ? <Button color="inherit" size="small" disabled={!!runner.busy} onClick={() => void runner.run("revalidate")} sx={{ minHeight: 32 }}>{runner.busy === "revalidate" ? "Revalidando…" : "Revalidar agora"}</Button> : undefined}>
          A base do card está vencida: o produto avançou para a v{journey.base.currentHeadVersion ?? "?"} (o card foi escrito sobre a v{journey.base.headVersion ?? "?"}). Revalide antes de promover.
        </Alert>
      )}
      {runner.restart && (
        <Alert severity="warning" sx={{ mt: 1 }} data-testid="restart-needed">
          {runner.restart.message}{" "}
          {(exec?.childProjectId ?? runner.restart.childProjectId) && <Link component={NextLink} href={`/projects/${exec?.childProjectId ?? runner.restart.childProjectId}`}>Abrir o projeto para reiniciar a execução</Link>}
        </Alert>
      )}
      {runner.revalidation && <RevalidateResult r={runner.revalidation} />}
    </Box>
  );
}
