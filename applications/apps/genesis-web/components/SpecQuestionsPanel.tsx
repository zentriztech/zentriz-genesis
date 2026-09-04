"use client";

/**
 * SpecQuestionsPanel — D3: a fábrica PAROU com perguntas ao humano (status `needs_spec_input`).
 * Mostra a rodada aberta, coleta UMA resposta (texto livre cobrindo todas as perguntas) e chama
 * POST /api/projects/:id/answer — que grava a resposta, volta o status para `spec_submitted` e
 * redispara o run (retoma do checkpoint). Histórico de rodadas anteriores fica visível.
 */
import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import QuestionAnswerIcon from "@mui/icons-material/QuestionAnswer";
import { apiGet, apiPost } from "@/lib/api";

type Question = {
  id: string; round: number; stage: string; questions: string[]; askedBy: string;
  answer: string | null; answeredAt: string | null; createdAt: string;
};
type Resp = { projectId: string; status: string; maxRounds: number; questions: Question[] };

export function SpecQuestionsPanel({ projectId, status, onAnswered }: {
  projectId: string; status: string; onAnswered?: () => void;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<Resp>(`/api/projects/${projectId}/questions`);
      setData(r);
    } catch {
      setData(null);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, status]);

  const open = data?.questions.find((q) => !q.answeredAt) ?? null;
  const history = (data?.questions ?? []).filter((q) => q.answeredAt);
  if (!data || (!open && history.length === 0)) return null;

  const submit = async () => {
    if (!open || answer.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPost<{ ok: boolean; dispatch?: { dispatched: boolean; reason?: string } }>(
        `/api/projects/${projectId}/answer`, { answer: answer.trim(), questionId: open.id },
      );
      setDone(r.dispatch?.dispatched ? "Resposta enviada — a fábrica retomou do ponto onde parou." : `Resposta salva. Retomada: ${r.dispatch?.reason ?? "pendente"}.`);
      setAnswer("");
      await load();
      onAnswered?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao enviar a resposta.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: open ? "secondary.main" : "divider", borderRadius: 2, p: 2, mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <QuestionAnswerIcon color={open ? "secondary" : "disabled"} fontSize="small" />
        <Typography variant="subtitle1" fontWeight={700}>Perguntas da fábrica</Typography>
        {open && <Chip size="small" color="secondary" label={`rodada ${open.round}/${data.maxRounds} · ${open.stage}`} />}
      </Stack>
      {open ? (
        <>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            O CTO da fábrica pausou o pipeline: só você pode decidir os pontos abaixo. Responda a todos numa única mensagem —
            a fábrica retoma exatamente de onde parou (sem refazer o que já foi feito).
          </Alert>
          <Box component="ol" sx={{ pl: 3, m: 0, mb: 1.5 }}>
            {open.questions.map((q, i) => (
              <Typography key={i} component="li" variant="body2" sx={{ mb: 0.5 }}>{q}</Typography>
            ))}
          </Box>
          <TextField
            multiline minRows={4} fullWidth value={answer} onChange={(e) => setAnswer(e.target.value)}
            placeholder="Ex.: 1) SLA 99,9%. 2) Sim, multi-tenant por schema. 3) Não haverá fila nesta fase."
            disabled={busy}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
            <Button variant="contained" color="secondary" disabled={busy || answer.trim().length < 3} onClick={submit}>
              {busy ? "Enviando…" : "Responder e retomar a fábrica"}
            </Button>
            {error && <Typography variant="caption" color="error">{error}</Typography>}
          </Stack>
        </>
      ) : (
        done && <Alert severity="success" sx={{ mb: 1 }}>{done}</Alert>
      )}
      {history.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={700}>Rodadas anteriores</Typography>
          {history.map((h) => (
            <Box key={h.id} sx={{ mt: 0.75, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
              <Typography variant="caption" color="text.secondary">rodada {h.round} · {h.stage} · respondida em {new Date(h.answeredAt!).toLocaleString("pt-BR")}</Typography>
              <Box component="ul" sx={{ pl: 2.5, m: 0 }}>
                {h.questions.map((q, i) => <Typography key={i} component="li" variant="caption">{q}</Typography>)}
              </Box>
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.25 }}>{h.answer}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default SpecQuestionsPanel;
