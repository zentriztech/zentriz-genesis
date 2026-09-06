"use client";
/**
 * SpecSplitPanel — F2/PR-3: dividir a spec monolítica em vários arquivos (com aprovação humana).
 *
 * POR QUE ISTO EXISTE (medido em prod 2026-09-05): uma spec de ~98 mil caracteres num único arquivo
 * não cabe na RESPOSTA de nenhum modelo — cada revisão do CTO reemitia o documento inteiro, batia no
 * teto de 64 mil tokens de saída e voltava truncada (14 → 7 seções). Repartida por tema, cada rodada
 * de melhoria toca UM arquivo e cabe com folga.
 *
 * A estrutura é decidida por AGENTES no servidor (um arquiteto planeja, um redator escreve cada
 * arquivo). Esta tela só dispara, mostra o plano e pede a decisão: **Aplicar** ou **Descartar**.
 * Nada é gravado sem esse clique — e ao aplicar, o servidor guarda snapshot da spec atual.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { ApiError, apiGet, apiPost } from "@/lib/api";

interface PlanFile { name: string; title?: string; purpose?: string; sections?: string[] }
interface CoverageRow { section: string; chars?: number; targets: string[] }
interface Proposal {
  id: string;
  status: "pending" | "running" | "done" | "error" | "interrupted" | "applied" | "discarded";
  active: boolean;
  awaitingDecision: boolean;
  sourceChars: number;
  producedChars: number;
  warnings: string[];
  error: string | null;
  outputTokens: number;
  modelUsed: string | null;
  createdAt: string;
  plan?: { rationale?: string; indexPurpose?: string; files: PlanFile[] };
  coverage?: CoverageRow[];
  files?: Array<{ path: string; chars: number }>;
}
interface SplitState { proposal: Proposal | null; enabled: boolean }

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "na fila",
  running: "os agentes estão planejando e escrevendo os arquivos",
  done: "proposta pronta — aguardando a sua decisão",
  error: "falhou",
  interrupted: "interrompida",
  applied: "aplicada",
  discarded: "descartada",
};

function fmt(n: number) {
  return n.toLocaleString("pt-BR");
}

export default function SpecSplitPanel({ projectId, editable = true, onApplied, embedded = false, onStateChange }: {
  projectId: string;
  /** Espelha a guarda do servidor (status do projeto) — desabilita o botão em vez de dar 409. */
  editable?: boolean;
  /** O pai recarrega a árvore/editor: a spec primária virou índice e nasceram N arquivos. */
  onApplied?: (created: string[]) => void;
  /**
   * UI/UX 2026-09-06 — o painel agora mora num diálogo aberto pelo ícone “dividir” da lista de
   * arquivos (antes era um card no corpo da página). `embedded` remove a moldura/margem que só
   * fazia sentido empilhado com outros cards.
   */
  embedded?: boolean;
  /** Espelha o estado ao pai (o ícone da lista precisa saber se existe proposta aguardando). */
  onStateChange?: (s: { enabled: boolean; awaitingDecision: boolean; active: boolean }) => void;
}) {
  const [state, setState] = useState<SplitState | null>(null);
  const [busy, setBusy] = useState<"start" | "apply" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Callback em ref: se entrasse nas deps de `load`, um pai que passasse função inline
  // recriaria `load` a cada render e o efeito viraria um laço de fetch.
  const stateCbRef = useRef(onStateChange);
  useEffect(() => { stateCbRef.current = onStateChange; }, [onStateChange]);

  const load = useCallback(async (): Promise<SplitState | null> => {
    try {
      const s = await apiGet<SplitState>(`/api/spec-split?projectId=${encodeURIComponent(projectId)}&payload=1`);
      setState(s);
      stateCbRef.current?.({
        enabled: s.enabled === true,
        awaitingDecision: s.proposal?.awaitingDecision === true,
        active: s.proposal?.active === true,
      });
      return s;
    } catch {
      return null; // api antiga / sem permissão: o painel simplesmente não aparece
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Poll enquanto os agentes trabalham (o job vive no servidor: fechar a tela não o mata).
  useEffect(() => {
    const active = state?.proposal?.active === true;
    if (!active) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return;
    }
    if (timer.current) return;
    timer.current = setInterval(() => { void load(); }, 8_000);
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  }, [state?.proposal?.active, load]);

  const describe = (e: unknown): string => {
    if (e instanceof ApiError && e.message) return e.message;
    return e instanceof Error ? e.message : String(e);
  };

  const start = async () => {
    setBusy("start"); setError(null); setApplied(null);
    try {
      await apiPost(`/api/spec-split`, { projectId });
      await load();
    } catch (e) { setError(describe(e)); } finally { setBusy(null); }
  };

  const apply = async () => {
    const id = state?.proposal?.id;
    if (!id) return;
    setBusy("apply"); setError(null);
    try {
      const res = await apiPost<{ created: string[]; indexPath: string }>(`/api/spec-split/${id}/apply`, {});
      setApplied(res.created);
      onApplied?.(res.created);
      await load();
    } catch (e) { setError(describe(e)); } finally { setBusy(null); }
  };

  const discard = async () => {
    const id = state?.proposal?.id;
    if (!id) return;
    setBusy("discard"); setError(null);
    try {
      await apiPost(`/api/spec-split/${id}/discard`, {});
      await load();
    } catch (e) { setError(describe(e)); } finally { setBusy(null); }
  };

  const openPreview = async (path: string) => {
    const id = state?.proposal?.id;
    if (!id) return;
    try {
      const f = await apiGet<{ path: string; content: string }>(
        `/api/spec-split/${id}/file?path=${encodeURIComponent(path)}`,
      );
      setPreview({ path: f.path, content: f.content });
    } catch (e) { setError(describe(e)); }
  };

  const p = state?.proposal ?? null;
  // Desligado e sem histórico → o painel não existe (não polui a Bancada de quem não usa).
  if (!state || (!state.enabled && !p)) return null;

  const showStart = state.enabled && (!p || !p.active) && p?.status !== "done";

  return (
    <Box sx={embedded
      ? { p: 0 }
      : { mb: 1.5, p: 1.5, borderRadius: 1, border: "1px solid", borderColor: p?.awaitingDecision ? "warning.main" : "divider", bgcolor: "background.paper" }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        {/* No diálogo o título já está na barra do modal → aqui sobra só o estado da proposta. */}
        {!embedded && <CallSplitIcon sx={{ fontSize: "1.05rem", color: "primary.main" }} />}
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flexGrow: 1, display: embedded ? "none" : "block" }}>
          Dividir a spec em arquivos
        </Typography>
        {p && <Chip size="small" label={STATUS_LABEL[p.status]} color={p.awaitingDecision ? "warning" : "default"} variant="outlined" />}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Uma spec grande num arquivo só não cabe na resposta do modelo: a revisão volta cortada. Um
        arquiteto de IA decide a estrutura e um redator escreve cada arquivo — você vê o plano e
        decide. A spec atual fica guardada como versão anterior antes de qualquer escrita.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 1, fontSize: "0.75rem", py: 0 }} onClose={() => setError(null)}>{error}</Alert>}
      {applied && (
        <Alert severity="success" sx={{ mb: 1, fontSize: "0.75rem" }} onClose={() => setApplied(null)}>
          Divisão aplicada: {applied.length} arquivo(s) criado(s) e a spec principal virou o índice.
        </Alert>
      )}
      {p?.error && !p.active && (
        <Alert severity={p.status === "error" ? "error" : "warning"} sx={{ mb: 1, fontSize: "0.72rem", py: 0 }}>{p.error}</Alert>
      )}

      {p?.active && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption">
            {STATUS_LABEL[p.status]} · spec de origem: {fmt(p.sourceChars)} caracteres
          </Typography>
        </Stack>
      )}

      {p?.status === "done" && p.plan && (
        <Box sx={{ mb: 1 }}>
          {p.plan.rationale && (
            <Typography variant="caption" sx={{ display: "block", fontStyle: "italic", mb: 0.75 }}>
              “{p.plan.rationale}”
            </Typography>
          )}
          <Stack spacing={0.4} sx={{ mb: 0.75 }}>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <DescriptionOutlinedIcon sx={{ fontSize: "0.9rem", color: "text.secondary" }} />
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                índice (substitui a spec principal)
              </Typography>
              <Button size="small" sx={{ minWidth: 0, py: 0, fontSize: "0.65rem" }} onClick={() => void openPreview("(index)")}>ver</Button>
            </Stack>
            {(p.files ?? []).map((f) => {
              const meta = p.plan?.files.find((x) => x.name === f.path);
              return (
                <Stack key={f.path} direction="row" spacing={0.75} alignItems="center" sx={{ pl: 0.5 }}>
                  <DescriptionOutlinedIcon sx={{ fontSize: "0.9rem", color: "text.disabled" }} />
                  <Tooltip title={meta?.purpose ?? ""}>
                    <Typography variant="caption" sx={{ fontFamily: "monospace" }}>{f.path}</Typography>
                  </Tooltip>
                  <Typography variant="caption" color="text.secondary">({fmt(f.chars)} chars)</Typography>
                  <Button size="small" sx={{ minWidth: 0, py: 0, fontSize: "0.65rem" }} onClick={() => void openPreview(f.path)}>ver</Button>
                </Stack>
              );
            })}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            Origem {fmt(p.sourceChars)} → produzido {fmt(p.producedChars)} caracteres
            {p.coverage?.length ? ` · ${p.coverage.length} seção(ões), todas com destino` : ""}
            {p.modelUsed ? ` · ${p.modelUsed}` : ""}
          </Typography>
          {p.warnings.length > 0 && (
            <Alert severity="warning" sx={{ mt: 0.75, fontSize: "0.7rem", py: 0 }}>
              <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                {p.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
              </Stack>
            </Alert>
          )}
        </Box>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {showStart && (
          <Tooltip title={editable ? "" : "Spec bloqueada para edição no status atual do projeto."}>
            <span>
              <Button size="small" variant="outlined" startIcon={busy === "start" ? <CircularProgress size={12} /> : <CallSplitIcon />}
                disabled={!editable || busy !== null} onClick={() => void start()}>
                {p?.status === "applied" ? "Dividir de novo" : "Propor divisão"}
              </Button>
            </span>
          </Tooltip>
        )}
        {p?.status === "done" && (
          <>
            <Button size="small" variant="contained" color="warning" disabled={!editable || busy !== null}
              startIcon={busy === "apply" ? <CircularProgress size={12} /> : undefined}
              onClick={() => void apply()}>
              Aplicar divisão
            </Button>
            <Button size="small" color="inherit" disabled={busy !== null} onClick={() => void discard()}>
              Descartar
            </Button>
          </>
        )}
      </Stack>

      <Dialog open={preview !== null} onClose={() => setPreview(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontSize: "0.95rem", fontFamily: "monospace" }}>{preview?.path}</DialogTitle>
        <Divider />
        <DialogContent>
          <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.75rem", fontFamily: "monospace" }}>
            {preview?.content}
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
