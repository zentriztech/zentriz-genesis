"use client";
/**
 * SpecValidationPanel — RFC-0004 Onda 4 (F4/UI): operação Validar na Bancada.
 *
 * Estado DERIVADO do servidor (run 'passed' cobre o hash ATUAL?): editar a spec depois
 * de um verde o torna 'stale' — e o gate de promoção volta a travar. Findings vêm com
 * arquivo/severidade; warnings exigem "Reconhecer" (ack) para promover; blockers só um
 * zentriz_admin força (auditado). O job roda no SERVIDOR (sobrevive a sair da página).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import { apiGet, apiPost } from "@/lib/api";

interface Finding { file: string; line: number | null; severity: "blocker" | "warning" | "info"; title: string; rationale: string; source: string }
interface ValidationState {
  derivedStatus: string;
  currentSpecHash: string | null;
  latestRun: {
    id: string; status: string; findings: Finding[];
    acked_role: string | null; finished_at: string | null;
  } | null;
}

const STATUS_META: Record<string, { label: string; color: "default" | "success" | "error" | "warning" | "info" }> = {
  never_validated: { label: "Nunca validada", color: "default" },
  validating: { label: "Validando…", color: "info" },
  validated: { label: "Validada ✓", color: "success" },
  failed: { label: "Reprovada", color: "error" },
  stale: { label: "Editada após validação", color: "warning" },
  superseded: { label: "Editada durante validação", color: "warning" },
  interrupted: { label: "Interrompida", color: "warning" },
  error: { label: "Erro na validação", color: "error" },
};

const SEV_COLOR: Record<Finding["severity"], "error" | "warning" | "info"> = {
  blocker: "error", warning: "warning", info: "info",
};

export default function SpecValidationPanel({ projectId, isAdmin, reloadSignal, onFindingsChange }: {
  projectId: string; isAdmin?: boolean; reloadSignal?: number;
  // Onda 3 — avisa o pai do nº de GAPs (findings da última validação) sempre que o estado
  // recarrega (load/validar/ack/poll). null = nunca validada. Mantém o badge da aba GAPs e o
  // gate "Promover à Fábrica" SINCRONIZADOS quando a validação roda DENTRO da aba.
  onFindingsChange?: (count: number | null) => void;
}) {
  const [state, setState] = useState<ValidationState | null>(null);
  const [busy, setBusy] = useState<"validate" | "ack" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Callback via ref → não entra nas deps de `load` (evita recriar o loader a cada render do pai).
  const onFindingsChangeRef = useRef(onFindingsChange);
  onFindingsChangeRef.current = onFindingsChange;

  const load = useCallback(async () => {
    try {
      const s = await apiGet<ValidationState>(`/api/specs/${projectId}/validation`);
      setState(s);
      // GAPs = findings da última run; sem run → null (nunca validada).
      const count = s?.latestRun ? (Array.isArray(s.latestRun.findings) ? s.latestRun.findings.length : 0) : null;
      onFindingsChangeRef.current?.(count);
      return s;
    } catch { return null; }
  }, [projectId]);

  useEffect(() => {
    void load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  // T4.3 (M3): o pai aplicou uma revisão de arquivo → recarrega o estado de validação
  // (a validação anterior pode ter sido invalidada pela mudança).
  const lastReload = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastReload.current) return;
    lastReload.current = reloadSignal;
    void load();
  }, [reloadSignal, load]);

  // poll enquanto valida (o job é do servidor — o poll é só exibição)
  useEffect(() => {
    if (state?.derivedStatus === "validating" && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const s = await load();
        if (s && s.derivedStatus !== "validating" && pollRef.current) {
          clearInterval(pollRef.current); pollRef.current = null;
        }
      }, 6000);
    }
  }, [state?.derivedStatus, load]);

  const validate = useCallback(async () => {
    setBusy("validate"); setError(null);
    try {
      await apiPost(`/api/specs/${projectId}/validate`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao validar");
    } finally { setBusy(null); }
  }, [projectId, load]);

  const ack = useCallback(async () => {
    const run = state?.latestRun;
    if (!run) return;
    setBusy("ack"); setError(null);
    try {
      await apiPost(`/api/specs/${projectId}/validation/${run.id}/ack`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha no acknowledgment");
    } finally { setBusy(null); }
  }, [projectId, state, load]);

  if (!state) return null;
  const meta = STATUS_META[state.derivedStatus] ?? { label: state.derivedStatus, color: "default" as const };
  const run = state.latestRun;
  const findings = run?.findings ?? [];
  const hasBlocker = findings.some((f) => f.severity === "blocker");
  const hasWarning = findings.some((f) => f.severity === "warning");
  const acked = !!run?.acked_role;
  const showFindings = ["validated", "failed", "stale"].includes(state.derivedStatus) && findings.length > 0;
  const canAck = run && ["validated", "failed"].includes(state.derivedStatus) && !acked &&
    ((hasWarning && !hasBlocker) || (hasBlocker && isAdmin));

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5, p: 1.5, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <FactCheckOutlinedIcon sx={{ fontSize: "1.1rem" }} />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 160 }}>Validação da especificação</Typography>
        <Chip size="small" color={meta.color} label={meta.label} />
        {acked && <Chip size="small" color={run?.acked_role === "zentriz_admin" && hasBlocker ? "error" : "success"}
                        label={run?.acked_role === "zentriz_admin" && hasBlocker ? "forçada (admin)" : "avisos reconhecidos"} />}
        <Button size="small" variant="outlined"
                startIcon={busy === "validate" || state.derivedStatus === "validating" ? <CircularProgress size={14} /> : undefined}
                disabled={busy !== null || state.derivedStatus === "validating"}
                onClick={() => void validate()}>
          {state.derivedStatus === "validating" ? "Validando…" : "Validar"}
        </Button>
        {canAck && (
          <Button size="small" color={hasBlocker ? "error" : "warning"} variant="outlined"
                  disabled={busy !== null} onClick={() => void ack()}>
            {hasBlocker ? "Forçar (admin, auditado)" : "Reconhecer avisos"}
          </Button>
        )}
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>{error}</Alert>}
      {state.derivedStatus === "stale" && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          A spec foi editada depois da última validação — o resultado abaixo é da versão anterior. Revalide antes de promover.
        </Alert>
      )}
      {showFindings && (
        <Stack spacing={0.75} sx={{ mt: 1.5 }}>
          {findings.map((f, i) => (
            <Alert key={i} severity={SEV_COLOR[f.severity]} sx={{ py: 0.25, "& .MuiAlert-message": { py: 0.5 } }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {f.title}{f.file ? <Typography component="span" variant="caption" sx={{ fontFamily: "monospace", ml: 1 }}>({f.file}{f.line ? `:${f.line}` : ""})</Typography> : null}
              </Typography>
              <Typography variant="caption" color="text.secondary">{f.rationale}</Typography>
            </Alert>
          ))}
        </Stack>
      )}
    </Box>
  );
}
