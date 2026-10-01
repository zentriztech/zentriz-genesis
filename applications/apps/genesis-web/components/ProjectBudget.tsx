"use client";

/**
 * Orçamento de LLM do projeto (migração 131 — post-mortem 30/09/2026, BRL 90 mil num laço).
 *
 * `BudgetFields`: campos OBRIGATÓRIOS do envio de rascunho (orçamento em US$ para Bancada +
 * Fábrica e passo de alerta). `ProjectBudgetCard`: gasto por fase, tokens, previsão e pausa, com
 * edição via `GET/PUT /api/projects/:id/budget`.
 */
import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import FormControl from "@mui/material/FormControl";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { apiGet, apiPut } from "@/lib/api";

export const ALERT_STEP_OPTIONS = [10, 20, 30, 40, 50] as const;
export const MANDATORY_REMAINING_ALERTS = "30%, 20%, 10% e 0% restantes";

/** Valida o par do formulário; devolve a mensagem de erro ou null. */
export function budgetError(budgetUsd: string, stepPct: number | ""): string | null {
  const n = Number(String(budgetUsd).replace(",", "."));
  if (!budgetUsd.trim() || !Number.isFinite(n) || n <= 0) return "Informe o orçamento disponível em US$ (Bancada + Fábrica).";
  if (n > 1_000_000) return "Orçamento acima do teto aceito (US$ 1.000.000).";
  if (!stepPct) return "Escolha a cada quantos % gastos receber alerta por e-mail.";
  return null;
}

export function BudgetFields({ budgetUsd, onBudgetUsd, stepPct, onStepPct }: {
  budgetUsd: string; onBudgetUsd: (v: string) => void;
  stepPct: number | ""; onStepPct: (v: number) => void;
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField
          required size="small" fullWidth type="number" label="Orçamento de LLM (Bancada + Fábrica)"
          value={budgetUsd} onChange={(e) => onBudgetUsd(e.target.value)}
          inputProps={{ min: 1, step: "0.01" }}
          InputProps={{ startAdornment: <InputAdornment position="start">US$</InputAdornment> }}
        />
        <FormControl required size="small" fullWidth>
          <InputLabel id="budget-step-label">Alerta a cada</InputLabel>
          <Select labelId="budget-step-label" label="Alerta a cada" value={stepPct}
            onChange={(e) => onStepPct(Number(e.target.value))}>
            {ALERT_STEP_OPTIONS.map((p) => <MenuItem key={p} value={p}>{p}% gastos</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        Alertas obrigatórios com {MANDATORY_REMAINING_ALERTS}. Ao esgotar — ou quando o saldo não paga a
        próxima tarefa — o projeto é pausado e toda execução autônoma (Genesis e Deadpool) é bloqueada.
      </Typography>
    </Box>
  );
}

interface BudgetSummary {
  ownerProjectId: string; inherited: boolean;
  budgetUsd: number | null; alertStepPct: number | null;
  paused: boolean; pausedReason: string | null;
  spentUsd: number; remainingUsd: number | null; consumedPct: number | null;
  spend: { bancadaUsd: number; fabricaUsd: number; deadpoolUsd: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; calls: number };
  forecast: { doneTasks: number; pendingTasks: number; pendingCostUsd: number; projectTotalUsd: number;
    suggestedBudgetUsd: number; basis: string };
}

const usd = (n: number | null | undefined) => (n == null ? "—" : `US$ ${n.toFixed(2)}`);
const tok = (n: number) => n.toLocaleString("pt-BR");

export function ProjectBudgetCard({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) {
  const [data, setData] = useState<BudgetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [budget, setBudget] = useState("");
  const [step, setStep] = useState<number | "">("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiGet<BudgetSummary>(`/api/projects/${projectId}/budget`);
      setData(d); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const err = budgetError(budget, step);
    if (err) { setError(err); return; }
    setSaving(true);
    try {
      await apiPut(`/api/projects/${projectId}/budget`, { budgetUsd: Number(budget.replace(",", ".")), alertStepPct: step });
      setEditing(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  if (!data) return error ? <Alert severity="warning" sx={{ mb: 2 }}>Orçamento: {error}</Alert> : null;
  const pct = Math.min(100, data.consumedPct ?? 0);
  const color = data.paused || pct >= 90 ? "error" : pct >= 70 ? "warning" : "primary";

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>Orçamento de LLM</Typography>
          {!readOnly && !editing && (
            <Button size="small" onClick={() => { setBudget(String(data.budgetUsd ?? "")); setStep(data.alertStepPct ?? ""); setEditing(true); }}>
              {data.budgetUsd == null ? "Definir" : "Alterar"}
            </Button>
          )}
        </Stack>
        {data.inherited && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            Orçamento compartilhado com o projeto de origem.
          </Typography>
        )}
        {data.paused && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            Pausado: {data.pausedReason ?? "orçamento esgotado"}. Execução autônoma bloqueada — aumente o orçamento e retome.
          </Alert>
        )}
        {data.budgetUsd == null && !editing && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>Sem orçamento definido: nenhuma chamada de LLM é liberada para este projeto.</Alert>
        )}
        {error && <Alert severity="warning" sx={{ mb: 1.5 }} onClose={() => setError(null)}>{error}</Alert>}

        {editing ? (
          <>
            <BudgetFields budgetUsd={budget} onBudgetUsd={setBudget} stepPct={step} onStepPct={setStep} />
            <Stack direction="row" spacing={1}>
              <Button variant="contained" size="small" onClick={save} disabled={saving}>Salvar</Button>
              <Button size="small" onClick={() => setEditing(false)} disabled={saving}>Cancelar</Button>
            </Stack>
          </>
        ) : (
          <>
            <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
              <Typography variant="body2">{usd(data.spentUsd)} de {usd(data.budgetUsd)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {data.consumedPct == null ? "" : `${data.consumedPct}% · resta ${usd(data.remainingUsd)}`}
              </Typography>
            </Stack>
            <LinearProgress variant="determinate" value={pct} color={color} sx={{ height: 8, borderRadius: 4, mb: 1.5 }} />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.5, sm: 3 }} sx={{ mb: 1 }}>
              <Typography variant="body2">Bancada: {usd(data.spend.bancadaUsd)}</Typography>
              <Typography variant="body2">Fábrica: {usd(data.spend.fabricaUsd)}</Typography>
              {data.spend.deadpoolUsd > 0 && <Typography variant="body2">Deadpool: {usd(data.spend.deadpoolUsd)}</Typography>}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {tok(data.spend.calls)} chamadas · {tok(data.spend.inputTokens)} tokens de entrada · {tok(data.spend.outputTokens)} de saída
              {data.spend.cacheReadTokens > 0 ? ` · ${tok(data.spend.cacheReadTokens)} lidos do cache` : ""}
              {data.alertStepPct ? ` · alerta a cada ${data.alertStepPct}% + ${MANDATORY_REMAINING_ALERTS}` : ""}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              Previsão: {usd(data.forecast.pendingCostUsd)} para as {data.forecast.pendingTasks} tarefa(s) pendente(s) ·
              projeto completo ≈ {usd(data.forecast.projectTotalUsd)}
              {data.forecast.basis === "default" ? " (estimativa inicial, sem histórico)" : ""}
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}
