"use client";

/**
 * Agente de Operações da Zentriz — pergunta em português, resposta com o TRACE do que ele fez.
 *
 * ⚖️ Jean, 2026-09-10: *"podemos ter um agente de IA usando LLM configurável na conta principal da
 * Zentriz para executar e auxiliar em operações internas"*.
 *
 * Por que o trace é obrigatório na tela e não um detalhe de debug: a resposta é gerada por um LLM
 * sobre dados de produção. Sem ver QUAIS consultas produziram o número, o operador não tem como
 * separar um dado apurado de uma frase plausível — e é justamente essa distinção que justifica o
 * agente existir. O trace também mostra as recusas da guarda (consulta bloqueada), que são
 * comportamento correto, não erro.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import HistoryIcon from "@mui/icons-material/History";
import SendIcon from "@mui/icons-material/Send";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import { apiGet, apiPost } from "@/lib/api";
import { authStore } from "@/stores/authStore";

interface AgentStep {
  step: number;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: unknown;
}

interface AgentAnswer {
  ok: boolean;
  answer: string;
  steps: AgentStep[];
  max_steps: number;
  provider: string;
  model_id: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  error?: string;
  code?: string;
}

interface HistoryRun {
  id: string;
  user_email: string | null;
  question: string;
  answer: string | null;
  provider: string | null;
  model_id: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** Perguntas que respondem ao que a equipe realmente abre o banco para saber. */
const EXEMPLOS = [
  "Quantos tenants existem e quantos projetos cada um tem?",
  "Quais runs falharam nas últimas 24 horas e em que etapa?",
  "Quais tenants estão sem nenhum slot de LLM utilizável?",
  "Quais projetos estão parados há mais de 3 dias?",
];

function OpsAgentInner() {
  const [question, setQuestion] = useState("");
  const [asking, setAsking]     = useState(false);
  const [resp, setResp]         = useState<AgentAnswer | null>(null);
  const [erro, setErro]         = useState<{ text: string; naoConfigurado: boolean } | null>(null);
  const [historico, setHistorico] = useState<HistoryRun[]>([]);
  const [verHistorico, setVerHistorico] = useState(false);

  const carregarHistorico = useCallback(async () => {
    try {
      const r = await apiGet<{ runs: HistoryRun[] }>("/api/management/ops-agent/history?limit=20");
      setHistorico(r?.runs ?? []);
    } catch { /* histórico é acessório: falhar aqui não pode atrapalhar a pergunta */ }
  }, []);

  useEffect(() => { void carregarHistorico(); }, [carregarHistorico]);

  const perguntar = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true); setErro(null); setResp(null);
    try {
      const r = await apiPost<AgentAnswer>("/api/management/ops-agent/ask", { question: q });
      setResp(r);
      await carregarHistorico();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao consultar o agente.";
      // 409 = a conta de gestão não tem slot de LLM. Não é falha: é configuração que falta, e a
      // tela manda o operador ao lugar exato de resolver.
      setErro({ text: msg, naoConfigurado: /PLATFORM_LLM_NOT_CONFIGURED|slot de LLM/i.test(msg) });
    } finally { setAsking(false); }
  };

  if (!authStore.isZentrizAdmin) {
    return (
      <Box sx={{ maxWidth: 900, mx: "auto", p: { xs: 2, md: 4 } }}>
        <Alert severity="error">Esta tela é exclusiva da conta de gestão da Zentriz.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <SmartToyIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5" fontWeight={700}>Agente de Operações</Typography>
          <Typography variant="body2" color="text.secondary">
            Pergunte sobre o estado real da plataforma. O agente consulta o banco em modo
            <strong> somente-leitura</strong> e mostra as consultas que fez.
          </Typography>
        </Box>
        <Button size="small" startIcon={<HistoryIcon />} onClick={() => setVerHistorico((v) => !v)}>
          {verHistorico ? "Ocultar histórico" : "Histórico"}
        </Button>
      </Stack>

      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Custeado pela <strong>conta de gestão da Zentriz</strong> (Zentriz › LLM da Zentriz) — nunca
          pelos slots de um tenant. Credenciais, chaves e segredos são recusados pelo servidor, e
          e-mails e documentos saem mascarados antes de chegar ao modelo.
        </Typography>
      </Alert>

      <TextField
        label="Pergunta"
        placeholder="ex.: quantos projetos estão em execução agora, por tenant?"
        multiline minRows={2} fullWidth value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void perguntar(); }}
        helperText="⌘/Ctrl + Enter envia."
        sx={{ mb: 1.5 }}
      />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        {EXEMPLOS.map((ex) => (
          <Chip key={ex} label={ex} size="small" variant="outlined" onClick={() => setQuestion(ex)}
            sx={{ fontSize: "0.7rem" }} />
        ))}
        <Box sx={{ flexGrow: 1 }} />
        <Button variant="contained" onClick={() => void perguntar()} disabled={asking || !question.trim()}
          startIcon={asking ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}>
          {asking ? "Consultando…" : "Perguntar"}
        </Button>
      </Stack>

      {erro && (
        <Alert severity={erro.naoConfigurado ? "warning" : "error"} sx={{ mb: 2 }}>
          {erro.naoConfigurado ? (
            <>
              <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                A conta de gestão ainda não tem um LLM configurado
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Cadastre um slot em <strong>Zentriz › LLM da Zentriz</strong>. O agente não usa o
                ambiente do servidor nem os slots de nenhum tenant — sem slot próprio, ele não roda.
              </Typography>
            </>
          ) : erro.text}
        </Alert>
      )}

      {resp && (
        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
              <Chip size="small" icon={resp.ok ? <CheckCircleIcon /> : <BlockIcon />}
                label={resp.ok ? "Concluído" : (resp.code ?? "Não concluiu")}
                color={resp.ok ? "success" : "warning"} sx={{ height: 22, fontSize: "0.68rem" }} />
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                {resp.provider} · {resp.model_id}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {resp.steps.length}/{resp.max_steps} passos · {(resp.duration_ms / 1000).toFixed(1)}s ·{" "}
                {resp.input_tokens + resp.output_tokens} tokens
              </Typography>
            </Stack>

            <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", mb: 1 }}>
              {resp.answer || resp.error || "—"}
            </Typography>

            {resp.steps.length > 0 && (
              <>
                <Divider sx={{ my: 1.5 }}>
                  <Typography variant="caption" color="text.disabled">
                    o que o agente fez para responder
                  </Typography>
                </Divider>
                {resp.steps.map((s) => (
                  <Accordion key={s.step} disableGutters elevation={0}
                    sx={{ border: "1px solid", borderColor: "divider", "&:before": { display: "none" }, mb: 0.5 }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                        <Chip size="small" label={s.step} sx={{ height: 18, fontSize: "0.65rem" }} />
                        <Typography variant="caption" fontWeight={600} sx={{ fontFamily: "monospace" }}>
                          {s.tool}
                        </Typography>
                        {!s.ok && (
                          <Chip size="small" icon={<BlockIcon />} label="recusado pela guarda"
                            color="warning" sx={{ height: 18, fontSize: "0.62rem" }} />
                        )}
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Typography variant="caption" color="text.secondary" component="pre"
                        sx={{ fontFamily: "monospace", fontSize: "0.7rem", whiteSpace: "pre-wrap",
                              wordBreak: "break-word", m: 0 }}>
                        {JSON.stringify(s.input, null, 2)}
                      </Typography>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="caption" color="text.secondary" component="pre"
                        sx={{ fontFamily: "monospace", fontSize: "0.7rem", whiteSpace: "pre-wrap",
                              wordBreak: "break-word", m: 0, maxHeight: 320, overflow: "auto" }}>
                        {JSON.stringify(s.result, null, 2)}
                      </Typography>
                    </AccordionDetails>
                  </Accordion>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {verHistorico && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
              Últimas execuções (auditoria)
            </Typography>
            {historico.length === 0 ? (
              <Typography variant="caption" color="text.secondary">Nenhuma execução registrada.</Typography>
            ) : (
              <Stack divider={<Divider />} spacing={1}>
                {historico.map((h) => (
                  <Box key={h.id} sx={{ pt: 0.5 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Chip size="small" label={h.status}
                        color={h.status === "ok" ? "success" : "warning"}
                        sx={{ height: 18, fontSize: "0.62rem" }} />
                      <Typography variant="caption" color="text.secondary">
                        {new Date(h.created_at).toLocaleString("pt-BR")} · {h.user_email ?? "—"}
                        {h.model_id ? ` · ${h.model_id}` : ""}
                      </Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 0.25 }}>{h.question}</Typography>
                    {h.error && (
                      <Typography variant="caption" color="error.main">{h.error}</Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}

export default observer(OpsAgentInner);
