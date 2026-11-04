"use client";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import type { CardSummary, FactoryGateKey, FactoryGateStatus, FactoryHealth } from "@/lib/cards/types";

export const HEALTH_LABEL: Record<FactoryHealth, string> = { ok: "Fábrica: ok", attention: "Fábrica: atenção", failed: "Fábrica: falhou" };
const HEALTH_COLOR = { ok: "success", attention: "warning", failed: "error" } as const;
const HEALTH_ICON = { ok: <CheckCircleOutlineIcon />, attention: <WarningAmberIcon />, failed: <ErrorOutlineIcon /> } as const;
export const GATE_LABEL: Record<FactoryGateKey, string> = {
  scope: "Escopo (RFC files_allowed)", symbols: "Símbolos preservados", qa: "QA", fullTest: "TSK-FULL-TEST (e2e)", baseline: "Baseline / não-regressão (P2P)",
};
export const GATE_STATUS_LABEL: Record<FactoryGateStatus, string> = { passed: "passou", failed: "FALHOU", not_run: "não executado / sem evidência" };
const GATE_ORDER: FactoryGateKey[] = ["scope", "symbols", "qa", "fullTest", "baseline"];

/** Indicador de saúde da Fábrica: ícone + texto (a cor nunca é a única pista). Sem gates registrados (filho ainda não aceito) não mostra nada. */
export function FactoryHealthChip({ health }: { health: CardSummary["factoryHealth"] }) {
  if (!health) return null;
  return <Chip size="small" variant="outlined" icon={HEALTH_ICON[health]} color={HEALTH_COLOR[health]} label={HEALTH_LABEL[health]} data-testid={`factory-health-${health}`} />;
}

/**
 * Detalhe do card: a Fábrica ACEITOU o filho, mas os gates reais dizem se o resultado é confiável. Lista os 5 gates com o texto do servidor
 * e avisa quando o código-base do filho veio do disco (pode conter código não mergeado).
 */
export function FactoryHealthPanel({ card }: { card: Pick<CardSummary, "factoryHealth" | "factoryGates" | "codeBaseWarning"> }) {
  const { factoryHealth: health, factoryGates: gates, codeBaseWarning } = card;
  if (!health && !codeBaseWarning) return null;
  return (
    <Box component="section" aria-label="Saúde da Fábrica" data-testid="factory-health" sx={{ mb: 1 }}>
      {codeBaseWarning && (
        <Alert severity="warning" role="alert" data-testid="code-base-warning" sx={{ mb: 1 }}>
          <AlertTitle>Código-base copiado do disco</AlertTitle>
          {codeBaseWarning}
        </Alert>
      )}
      {health && gates && (
        <Alert severity={health === "ok" ? "success" : health === "attention" ? "warning" : "error"} role="status" sx={{ alignItems: "flex-start", "& .MuiAlert-message": { minWidth: 0, overflowWrap: "anywhere" } }}>
          <AlertTitle>{HEALTH_LABEL[health]}{health === "failed" ? " — a Fábrica aceitou o filho, mas há gate reprovado" : health === "attention" ? " — há gate sem evidência de execução" : ""}</AlertTitle>
          <Box component="ul" aria-label="Gates da Fábrica" sx={{ m: 0, pl: 2.5 }}>
            {GATE_ORDER.map((k) => (
              <li key={k}>
                <Typography variant="body2" component="span"><b>{GATE_LABEL[k]}:</b> {GATE_STATUS_LABEL[gates[k].status]}{gates[k].detail ? ` — ${gates[k].detail}` : ""}</Typography>
              </li>
            ))}
          </Box>
          {health !== "ok" && <Typography variant="body2" sx={{ mt: 0.5 }}>“Não executado” não é aprovação: revise o diff do PR antes de integrar.</Typography>}
        </Alert>
      )}
    </Box>
  );
}
