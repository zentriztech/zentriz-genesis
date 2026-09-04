"use client";

// DecomposeDialog — RFC-0003 F1: o "Splitter" deixa de ser um MENU e vira uma AÇÃO VIVA
// dentro da Bancada. Dois modos, mesmo fluxo:
//   • spec  → decompõe uma SPEC já salva (POST /api/projects/:id/decompose) — carrega o
//             vínculo de origem (originProjectId) para o produto não nascer órfão (U#4).
//   • idea  → decompõe uma IDEIA colada (POST /api/products/propose {document}).
// Ambos fazem poll do job e, ao aprovar, chamam /ingest-proposal com **dispatch:false**
// (D1: aprovar = SALVAR rascunhos na Bancada, NUNCA disparar a fábrica). A promoção à
// fábrica é um passo humano separado (Promover à fábrica / Promover produto inteiro).
//
// Onda 4 (épico Spec/Bancada, plano SPEC-BANCADA-ONDAS-4-5 §3/§6 PR-4):
//   • resumeJobId → REABRE uma proposta já existente (pronta para revisão ou ainda em análise)
//     a partir da seção "Propostas de produto" da Bancada, sem disparar nada novo.
//   • source ('idea'|'upload'|'spec') é ecoado à API para telemetria/custo por feature.
//   • Fases textuais + tempo decorrido/estimado (etaSeconds da listagem) + botão Cancelar
//     (POST /propose/:jobId/cancel) — NN/g: progresso > 10 s precisa de texto, tempo e saída.
//   • Bloco "Custo desta proposta" (usage/costUsd/modelo reais do job) na revisão e
//     estimativa LOCAL (≈ tokens/US$) antes de iniciar — heurística, nunca fatura.
//   • onSaved({ productId }) devolve o produto criado (o /spec navega para ele).

import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import PaidOutlinedIcon from "@mui/icons-material/PaidOutlined";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import { ApiError, apiGet, apiPost } from "@/lib/api";

// contratos com a API (espelham products.ts / splitter)
type ProposeProject = {
  id: string; type: string; wave: number; dependsOn: string[];
  // R4 PR3 (Connect 1.3.0): racional do corte + arquivos gerados + connect.yaml
  rationale?: string | null; files?: string[]; connectDeclaration?: string | null;
};
type ProductManifest = {
  schemaVersion?: string;
  product?: { name?: string; systemId?: string; specApproved?: boolean; deliveryDefault?: string };
  projects?: Array<{ id: string; spec: string; type: string; dependsOn?: string[] }>;
};
/** Origem da proposta (Onda 4): ideia colada, upload no /spec ou spec já salva na Bancada. */
export type ProposalSource = "idea" | "upload" | "spec";
/** Usage real do job (Onda 4 / PR-2) — `null` enquanto a API não ecoa (ou antes do PR-2). */
export type ProposalUsage = { inputTokens: number; outputTokens: number; model: string | null };
/** Normaliza o usage vindo da API (snake_case real ou camelCase) — `null` se ausente/inválido. */
export function normalizeUsage(u: unknown): ProposalUsage | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const inTok = Number(o.inputTokens ?? o.input_tokens);
  const outTok = Number(o.outputTokens ?? o.output_tokens);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const model = (o.model ?? o.model_used ?? null) as string | null;
  return { inputTokens: inTok, outputTokens: outTok, model: typeof model === "string" ? model : null };
}
type ProposePoll = {
  jobId: string;
  // 'interrupted' chega como status:"error" + interrupted:true (compat do contrato antigo),
  // mas aceitamos também o literal caso a API passe a ecoá-lo.
  status: "pending" | "running" | "done" | "error" | "interrupted";
  interrupted?: boolean;
  needsHuman?: boolean;
  manifest?: ProductManifest;
  specs?: Record<string, string>;
  waves?: string[][];
  projects?: ProposeProject[];
  warnings?: string[];
  error?: string;
  elapsed?: number;
  originProjectId?: string | null;
  // Onda 4 (PR-2/PR-3): usage/custo/origem — opcionais (degradação limpa se ausentes).
  usage?: unknown;
  costUsd?: number | null;
  source?: ProposalSource;
};
/** Resposta do ingest — só precisamos do produto criado (o resto é detalhe do executor). */
type IngestResult = { productId: string; idempotentReuse?: boolean };

const POLL_MS = 8000;
// Teto do acompanhamento no diálogo. O job persiste na API (deadline 22 min); passado o teto
// o diálogo PARA de acompanhar e aponta para "Propostas de produto" na Bancada — o job não morre.
const TIMEOUT_MS = 20 * 60_000;
const MIN_DOC_CHARS = 40;
// Teto de tamanho do documento (espelha PROPOSAL_MAX_CHARS da API → 413 PROPOSAL_TOO_LARGE).
export const MAX_DOC_CHARS = 200_000;

// ── Estimativa LOCAL de tokens/custo (antes de gastar) ─────────────────────────
// Heurística determinística e sem chamada extra (Anthropic token counting ≈ 3,5 chars/token em
// PT-BR/markdown; o tokenizador Fable é ~30 % maior — por isso a FAIXA ±30 %). O splitter
// gera N specs → a saída costuma ser da ordem do documento de entrada (nunca menor que um
// piso), então estimamos saída ≈ max(piso, entrada). Preços USD/MTok espelham
// api-node/src/lib/modelPricing.ts (fonte única no servidor; aqui só para a PRÉVIA — o custo
// REAL vem do usage do job ao fim). Manter as duas tabelas alinhadas ao mudar preço.
const CHARS_PER_TOKEN = 3.5;
const ESTIMATE_SPREAD = 0.3;
const OUTPUT_FLOOR_TOKENS = 4_000;
const PROPOSAL_PRICE_TABLE: Array<{ match: string; inputPerMTok: number; outputPerMTok: number }> = [
  { match: "haiku", inputPerMTok: 1, outputPerMTok: 5 },
  { match: "opus", inputPerMTok: 5, outputPerMTok: 25 },
  { match: "sonnet-5", inputPerMTok: 2, outputPerMTok: 10 },
  { match: "sonnet", inputPerMTok: 3, outputPerMTok: 15 },
  { match: "fable", inputPerMTok: 10, outputPerMTok: 50 },
];
// Modelo padrão do stack (runtime.py: CLAUDE_MODEL default "claude-sonnet-4-6") → Sonnet 4.x 3/15.
const DEFAULT_PRICE = { inputPerMTok: 3, outputPerMTok: 15 };

export interface ProposalEstimate {
  inputTokens: number;
  outputTokens: number;
  /** Faixa de custo em US$ (mín/máx, ±30 %). */
  usdMin: number;
  usdMax: number;
}

/** Estima tokens e custo de uma proposta a partir do nº de caracteres do documento. */
export function estimateProposal(chars: number, modelId?: string | null): ProposalEstimate {
  const m = (modelId ?? "").toLowerCase();
  const price = PROPOSAL_PRICE_TABLE.find((p) => m.includes(p.match)) ?? DEFAULT_PRICE;
  const inputTokens = Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
  const outputTokens = Math.max(OUTPUT_FLOOR_TOKENS, inputTokens);
  const mid = (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
  return {
    inputTokens,
    outputTokens,
    usdMin: mid * (1 - ESTIMATE_SPREAD),
    usdMax: mid * (1 + ESTIMATE_SPREAD),
  };
}

const usdFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtUsd(v: number): string { return usdFmt.format(v); }
function fmtTokensK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: n >= 10_000 ? 0 : 1 })} mil` : String(n);
}
/** "≈ 12 mil tokens · ≈ US$ 0,08–0,15" — texto único da prévia, reusado pelo /spec. */
export function describeEstimate(est: ProposalEstimate): string {
  return `≈ ${fmtTokensK(est.inputTokens + est.outputTokens)} tokens · ≈ ${fmtUsd(est.usdMin)}–${fmtUsd(est.usdMax)}`;
}
function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m > 0 ? `${m}min${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Fase textual (NN/g): a API não expõe o passo interno do splitter, então a fase é derivada do
// status + tempo decorrido — rotulada como "aproximada" na UI. Nunca inventa contagem de specs.
function phaseLabel(status: ProposePoll["status"] | null, elapsedSec: number): string {
  if (status === null || status === "pending") return "Na fila do Product Architect…";
  if (elapsedSec < 25) return "Lendo o documento…";
  if (elapsedSec < 120) return "Desenhando o produto e o grafo de dependências…";
  return "Gerando a spec de cada projeto…";
}

// Mapa PT-BR de erros das rotas de proposta (400/404/409/413/422/429/503). Mensagem do servidor
// vence quando existe; aqui só damos contexto acionável por código/status.
function describeProposalError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const msg = e.message?.trim();
    switch (e.code) {
      case "PROPOSAL_TOO_LARGE":
      case "DOCUMENT_TOO_LARGE":
        return `Documento grande demais para decompor (máx. ${MAX_DOC_CHARS.toLocaleString("pt-BR")} caracteres). Resuma ou divida em partes.`;
      case "RATE_LIMITED":
        return msg || "Muitas decomposições em pouco tempo. Aguarde alguns minutos e tente de novo.";
      case "BUDGET_EXCEEDED":
        return msg || "Orçamento mensal de IA do tenant atingido — a decomposição foi bloqueada.";
      case "ALREADY_IN_PRODUCT":
        return "Esta spec já pertence a um produto — só specs no INBOX (Rascunhos) podem ser decompostas.";
      case "NOT_A_SPEC":
        return msg || "Só specs na Bancada podem ser decompostas.";
      case "NO_SPEC_FILES":
      case "SPEC_TOO_SHORT":
        return msg || "A spec não tem texto legível suficiente (PDF sem texto selecionável? envie .md/.docx ou cole o texto).";
      case "SERVICE_UNAVAILABLE":
        return "O Product Architect está indisponível no momento. Tente novamente em instantes.";
      default:
        break;
    }
    switch (e.status) {
      case 400: return msg || "Pedido inválido — confira o documento/spec enviado.";
      case 403: return msg || "Sem permissão para decompor (contas de gestão não decompõem).";
      case 404: return "Proposta não encontrada ou expirada — refaça a decomposição.";
      case 409: return msg || "Conflito: a spec mudou de estado. Recarregue a Bancada.";
      case 413: return `Documento grande demais (máx. ${MAX_DOC_CHARS.toLocaleString("pt-BR")} caracteres).`;
      case 422: return msg || "Conteúdo insuficiente para decompor.";
      case 429: return msg || "Limite de uso atingido. Tente mais tarde.";
      case 503: return "O Product Architect está indisponível no momento. Tente novamente em instantes.";
      default: return msg || fallback;
    }
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

type Phase = "input" | "proposing" | "polling" | "review" | "saving" | "cancelled";

export interface DecomposeSpecRef {
  id: string;
  title: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @param spec  Quando presente, decompõe a SPEC salva (modo "spec"). Quando null/omisso,
 *              abre em modo "idea" (colar texto).
 * @param resumeJobId Onda 4: reabre uma proposta existente (não dispara nada) — a Bancada usa
 *              para "Revisar proposta" (done) ou "Acompanhar" (running). Tem precedência.
 * @param source Origem ecoada à API ('idea' | 'upload' | 'spec'); default deriva do modo.
 * @param etaSeconds Estimativa histórica (mediana das propostas done do tenant) vinda de
 *              GET /api/products/proposals; se omitida o diálogo tenta buscar sozinho.
 * @param onSaved Chamado após salvar os rascunhos na Bancada com o produto criado.
 */
export function DecomposeDialog({
  open,
  spec,
  resumeJobId,
  source,
  etaSeconds: etaProp,
  onClose,
  onSaved,
}: {
  open: boolean;
  spec?: DecomposeSpecRef | null;
  resumeJobId?: string | null;
  source?: ProposalSource;
  etaSeconds?: number | null;
  onClose: () => void;
  onSaved: (result: { productId: string }) => void;
}) {
  const isResume = !!resumeJobId;
  const isSpecMode = !!spec && !isResume;
  const effectiveSource: ProposalSource = source ?? (isSpecMode ? "spec" : "idea");
  // Fase inicial por modo: retomada e spec entram trabalhando; ideia começa na entrada.
  const initialPhase: Phase = isResume ? "polling" : isSpecMode ? "proposing" : "input";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [doc, setDoc] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState<ProposePoll | null>(null);
  // Último status visto no poll (rótulo de fase) e id do job em voo (Cancelar).
  const [liveStatus, setLiveStatus] = useState<ProposePoll["status"] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [eta, setEta] = useState<number | null>(etaProp ?? null);
  // originProjectId autoritativo vem do próprio job (poll.originProjectId); o spec.id é
  // apenas o gatilho. Guardamos o do poll para devolver no ingest.
  const originRef = useRef<string | null>(null);
  // Cancela qualquer polling em voo quando o diálogo fecha/desmonta (evita setState órfão
  // e poll fantasma sobre um job de uma abertura anterior).
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    setPhase(initialPhase);
    setDoc("");
    setElapsed(0);
    setError(null);
    setPoll(null);
    setLiveStatus(null);
    setJobId(null);
    setCancelling(false);
    setEta(etaProp ?? null);
    originRef.current = null;
  }, [initialPhase, etaProp]);

  // Após falha/cancelamento, para onde volta o diálogo: ideia → entrada (o texto fica);
  // spec/retomada → tela de trabalho parada (só Fechar/Refazer).
  const restPhase: Phase = isSpecMode || isResume ? "proposing" : "input";

  // Loop de poll compartilhado pelos modos. `immediate` (retomada) consulta antes de dormir.
  const pollUntilDone = useCallback(async (job: string, myRun: number, immediate = false) => {
    setPhase("polling");
    setJobId(job);
    const startedAt = Date.now();
    let first = immediate;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      if (runIdRef.current !== myRun) return; // diálogo fechou/reabriu → aborta
      if (!first) await sleep(POLL_MS);
      first = false;
      if (runIdRef.current !== myRun) return;
      let res: ProposePoll;
      try {
        res = await apiGet<ProposePoll>(`/api/products/propose/${job}`);
      } catch (e) {
        if (runIdRef.current !== myRun) return;
        // 404 = job sumiu/expirou (ou é de outro tenant) → encerra o poll (nunca loop infinito).
        setError(describeProposalError(e, "Falha ao consultar a decomposição"));
        setPhase(restPhase);
        return;
      }
      if (runIdRef.current !== myRun) return;
      if (res.status === "done") {
        originRef.current = res.originProjectId ?? spec?.id ?? null;
        setPoll(res);
        setPhase("review");
        return;
      }
      if (res.status === "error" || res.status === "interrupted") {
        setError(
          res.interrupted || res.status === "interrupted"
            ? (res.error || "A decomposição foi interrompida.") + " Você pode refazer quando quiser."
            : (res.error || "A decomposição falhou."),
        );
        setPhase(restPhase);
        return;
      }
      setLiveStatus(res.status);
      // Decorrido: prefere o do servidor (desde created_at — correto na retomada); senão local.
      setElapsed(typeof res.elapsed === "number" ? res.elapsed : Math.round((Date.now() - startedAt) / 1000));
    }
    if (runIdRef.current === myRun) {
      setError("O diálogo parou de acompanhar após 20 min, mas a proposta continua em processamento — acompanhe em “Propostas de produto”, na Bancada.");
      setPhase(restPhase);
    }
  }, [restPhase, spec?.id]);

  // Dispara a proposta (spec-origin ou ideia crua) e entra no poll.
  const startFlow = useCallback(async () => {
    const myRun = runIdRef.current;
    setError(null);
    setPhase("proposing");
    try {
      let job: string;
      if (isSpecMode && spec) {
        const res = await apiPost<{ jobId: string; originProjectId?: string }>(
          `/api/projects/${spec.id}/decompose`, { source: effectiveSource },
        );
        job = res.jobId;
        originRef.current = res.originProjectId ?? spec.id;
      } else {
        const document = doc.trim();
        if (document.length < MIN_DOC_CHARS) {
          setError(`Descreva a ideia com pelo menos ${MIN_DOC_CHARS} caracteres.`);
          setPhase("input");
          return;
        }
        if (document.length > MAX_DOC_CHARS) {
          setError(`A ideia excede ${MAX_DOC_CHARS.toLocaleString("pt-BR")} caracteres. Resuma antes de decompor.`);
          setPhase("input");
          return;
        }
        const res = await apiPost<{ jobId: string }>("/api/products/propose", { document, source: effectiveSource });
        job = res.jobId;
        originRef.current = null;
      }
      if (runIdRef.current !== myRun) return;
      await pollUntilDone(job, myRun);
    } catch (e) {
      if (runIdRef.current !== myRun) return;
      setError(describeProposalError(e, "Falha ao iniciar a decomposição"));
      setPhase(restPhase);
    }
  }, [isSpecMode, spec, doc, effectiveSource, pollUntilDone, restPhase]);

  // Ao abrir: reseta e, no modo spec, dispara automaticamente; na retomada, entra direto no
  // poll do job existente. runIdRef++ invalida polls de uma abertura anterior. Ao fechar,
  // também incrementa (cancela polls em voo).
  useEffect(() => {
    runIdRef.current += 1;
    if (open) {
      reset();
      const myRun = runIdRef.current;
      if (isResume && resumeJobId) {
        void pollUntilDone(resumeJobId, myRun, true);
      } else if (isSpecMode) {
        // pequeno defer para o reset assentar antes de disparar
        void (async () => {
          if (runIdRef.current !== myRun) return;
          await startFlow();
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ETA histórica: se o chamador não passou, busca da listagem (tenant-scoped). Falha = sem ETA
  // (rota pode não existir ainda → silencioso). Só quando há algo para acompanhar.
  useEffect(() => {
    if (!open || etaProp != null || phase !== "polling") return;
    let alive = true;
    apiGet<{ etaSeconds?: number | null }>("/api/products/proposals")
      .then((r) => { if (alive && typeof r?.etaSeconds === "number" && r.etaSeconds > 0) setEta(r.etaSeconds); })
      .catch(() => { /* sem ETA */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase === "polling"]);

  // Cancelar = interromper o JOB na API (não só fechar). 409 = já terminal → o próximo poll
  // resolve (done/error); 404 = sumiu → encerra. Sucesso → invalida o poll em voo (um "done"
  // que chegasse depois seria de um job já marcado interrupted no servidor).
  const cancelJob = useCallback(async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    try {
      await apiPost(`/api/products/propose/${jobId}/cancel`, {});
      runIdRef.current += 1; // aborta o loop de poll desta abertura
      setPhase("cancelled");
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Já terminou (race): não é erro — o poll em curso vai mostrar o resultado.
        setError("A proposta acabou de terminar — aguarde o resultado.");
      } else if (e instanceof ApiError && e.status === 404) {
        runIdRef.current += 1;
        setError("Proposta não encontrada — ela pode ter expirado.");
        setPhase(restPhase);
      } else {
        setError(describeProposalError(e, "Não foi possível cancelar agora. Tente novamente."));
      }
    } finally {
      setCancelling(false);
    }
  }, [jobId, cancelling, restPhase]);

  const save = useCallback(async () => {
    if (!poll?.manifest || !poll?.specs) return;
    const myRun = runIdRef.current;
    setPhase("saving");
    setError(null);
    try {
      const result = await apiPost<IngestResult>("/api/products/ingest-proposal", {
        // T1.6b: proposalId (= jobId da linha persistida) faz o servidor usar o manifest/specs
        // AUTORITATIVOS que ele gravou — o body abaixo vira apenas fallback (compat).
        proposalId: poll.jobId,
        manifest: poll.manifest,
        specs: poll.specs,
        specApproved: true,
        dispatch: false, // D1: só SALVA na Bancada — nunca dispara a fábrica
        originProjectId: originRef.current ?? undefined,
      });
      if (runIdRef.current !== myRun) return;
      onSaved({ productId: result?.productId ?? "" });
      onClose();
    } catch (e) {
      if (runIdRef.current !== myRun) return;
      setError(describeProposalError(e, "Falha ao salvar na Bancada"));
      setPhase("review");
    }
  }, [poll, onSaved, onClose]);

  const projects = poll?.projects ?? [];
  const productName = poll?.manifest?.product?.name;
  const wavesCount = poll?.waves?.length ?? 0;
  const specsCount = poll?.specs ? Object.keys(poll.specs).length : 0;
  // Pode refazer? Spec (gatilho conhecido) ou ideia (texto ainda no campo). Retomada não
  // sabe o documento → a Bancada oferece "Refazer" com a origem.
  const canRetry = isSpecMode || (!isResume && doc.trim().length >= MIN_DOC_CHARS);
  // Prévia local (modo ideia): recalcula a cada tecla — barato e determinístico.
  const ideaEstimate = !isSpecMode && !isResume && doc.trim().length >= MIN_DOC_CHARS ? estimateProposal(doc.trim().length) : null;
  // Progresso determinado só com ETA; trava em 95 % (nunca "100 %" sem resultado).
  const progressPct = eta && eta > 0 ? Math.min(95, Math.round((elapsed / eta) * 100)) : null;
  // A API ecoa `usage` em snake_case ({input_tokens, output_tokens, model_used}); aceitamos
  // também camelCase para não quebrar se o contrato evoluir. Sem números válidos → sem bloco.
  const usage = normalizeUsage(poll?.usage);
  const costUsd = typeof poll?.costUsd === "number" ? poll.costUsd : null;

  // Backdrop/Esc fecham em qualquer fase exceto envio/salvamento (evita fechar no meio de um
  // POST). Fechar durante o poll é permitido: o job segue na API e fica visível na Bancada.
  const closeLocked = phase === "saving" || phase === "proposing";

  return (
    <Dialog open={open} onClose={closeLocked ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "1.05rem", flexWrap: "wrap" }}>
        <CallSplitIcon sx={{ color: "#6366F1" }} />
        {isResume ? (
          <>Proposta de produto{spec?.title ? <> — <b>{spec.title}</b></> : null}</>
        ) : isSpecMode ? (
          <>Decompor SPEC <b>{spec?.title}</b></>
        ) : (
          <>Decompor uma ideia em vários projetos</>
        )}
        {effectiveSource === "upload" && (
          <Chip size="small" label="a partir do upload" variant="outlined" sx={{ height: 20, fontSize: "0.62rem" }} />
        )}
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {/* Entrada (só modo ideia) */}
        {phase === "input" && !isSpecMode && !isResume && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Descreva o produto em prosa. O Product Architect vai propor a divisão em
              projetos com o grafo de dependências. Nada é executado — os rascunhos ficam
              na Bancada para você revisar e promover quando quiser.
            </Typography>
            <TextField
              autoFocus fullWidth multiline minRows={8}
              placeholder="Ex.: Uma plataforma de agendamento com portal do cliente, painel do profissional, cobrança recorrente e notificações por e-mail/WhatsApp…"
              value={doc}
              onChange={(e) => setDoc(e.target.value)}
              error={doc.length > MAX_DOC_CHARS}
            />
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              <Typography variant="caption" color={doc.trim().length < MIN_DOC_CHARS || doc.length > MAX_DOC_CHARS ? "error" : "text.secondary"}>
                {doc.trim().length.toLocaleString("pt-BR")}/{MIN_DOC_CHARS} caracteres mínimos
                {doc.length > MAX_DOC_CHARS ? ` · acima do máximo (${MAX_DOC_CHARS.toLocaleString("pt-BR")})` : ""}
              </Typography>
              {ideaEstimate && (
                <Chip size="small" variant="outlined" icon={<PaidOutlinedIcon sx={{ fontSize: "0.9rem !important" }} />}
                  label={`${describeEstimate(ideaEstimate)} (modelo padrão)`}
                  sx={{ height: 20, fontSize: "0.62rem" }} />
              )}
            </Stack>
            {ideaEstimate && (
              <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 0.25 }}>
                Estimativa local (±30 %); o custo real aparece ao fim da decomposição.
              </Typography>
            )}
          </Box>
        )}

        {/* Parado após erro (spec/retomada): sem entrada de texto — só a orientação. */}
        {phase === "proposing" && (isSpecMode || isResume) && error && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
            {canRetry ? "Você pode refazer a decomposição ou fechar." : "Feche e use “Refazer” na Bancada para tentar de novo."}
          </Typography>
        )}

        {/* Trabalhando */}
        {((phase === "proposing" && !error) || phase === "polling") && (
          <Box sx={{ py: 3, textAlign: "center" }}>
            <CircularProgress size={30} sx={{ mb: 2 }} />
            <Typography variant="body2" color="text.secondary">
              {phase === "proposing" ? "Enviando ao Product Architect…" : phaseLabel(liveStatus, elapsed)}
            </Typography>
            {phase === "polling" && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                Decorrido {fmtDuration(elapsed)}
                {eta ? ` · estimado ≈ ${fmtDuration(eta)} (mediana das suas propostas anteriores)` : " · isto pode levar alguns minutos"}
              </Typography>
            )}
            <LinearProgress
              variant={phase === "polling" && progressPct !== null ? "determinate" : "indeterminate"}
              value={progressPct ?? undefined}
              sx={{ mt: 2, borderRadius: 1 }}
              aria-label="Progresso da decomposição"
            />
            {phase === "polling" && (
              <Typography variant="caption" color="text.disabled" sx={{ display: "block", mt: 1 }}>
                Fase aproximada. Cancelar interrompe a proposta: o processamento em curso é descartado e o custo já consumido é registrado.
              </Typography>
            )}
          </Box>
        )}

        {/* Cancelada pelo usuário */}
        {phase === "cancelled" && (
          <Alert severity="warning" icon={<StopCircleOutlinedIcon fontSize="inherit" />}>
            Decomposição cancelada. {isSpecMode || isResume
              ? "A spec de origem volta ao INBOX da Bancada; nada foi criado."
              : "Nada foi criado."}{canRetry ? " Você pode refazer quando quiser." : ""}
          </Alert>
        )}

        {/* Revisão da proposta */}
        {phase === "review" && poll && (
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, flexWrap: "wrap", gap: 1 }}>
              <CheckCircleIcon sx={{ color: "#10B981" }} fontSize="small" />
              <Typography variant="subtitle1" fontWeight={700}>
                {productName ?? "Produto proposto"}
              </Typography>
              <Chip size="small" label={`${projects.length} projeto(s)`} color="primary" variant="outlined" />
              <Chip size="small" label={`${wavesCount} onda(s)`} variant="outlined" />
              <Chip size="small" label={`${specsCount} spec(s)`} variant="outlined" />
            </Stack>

            {poll.warnings && poll.warnings.length > 0 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <Typography variant="caption" component="div" fontWeight={600}>Avisos da decomposição:</Typography>
                <ul style={{ margin: "4px 0 0 0", paddingLeft: 18 }}>
                  {poll.warnings.map((w, i) => <li key={i}><Typography variant="caption">{w}</Typography></li>)}
                </ul>
              </Alert>
            )}

            {/* Onda 4 — custo REAL desta proposta (usage do job). Sem usage/costUsd (API antiga
                ou proposta de ideia antes do PR-2) degrada para "não informado". */}
            <Box sx={{ mb: 2, p: 1.25, border: "1px solid", borderColor: "divider", borderRadius: 1, bgcolor: "action.hover" }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <PaidOutlinedIcon sx={{ fontSize: "1rem", color: "text.secondary" }} />
                <Typography variant="caption" fontWeight={700}>Custo desta proposta</Typography>
                {costUsd !== null ? (
                  <Chip size="small" color="primary" variant="outlined" label={fmtUsd(costUsd)} sx={{ height: 20, fontSize: "0.68rem", fontWeight: 700 }} />
                ) : (
                  <Typography variant="caption" color="text.disabled">não informado pela API</Typography>
                )}
                {usage && (
                  <Typography variant="caption" color="text.secondary">
                    {usage.inputTokens.toLocaleString("pt-BR")} tokens de entrada · {usage.outputTokens.toLocaleString("pt-BR")} de saída
                  </Typography>
                )}
                {usage?.model && (
                  <Chip size="small" variant="outlined" label={usage.model} sx={{ height: 20, fontSize: "0.62rem", maxWidth: 260 }} />
                )}
                {poll.source && (
                  <Typography variant="caption" color="text.disabled">
                    origem: {poll.source === "upload" ? "upload" : poll.source === "spec" ? "spec da Bancada" : "ideia"}
                  </Typography>
                )}
              </Stack>
            </Box>

            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
              Projetos por onda de execução (dependências resolvidas topologicamente):
            </Typography>
            <Stack spacing={0.75} sx={{ mb: 2 }}>
              {projects
                .slice()
                .sort((a, b) => a.wave - b.wave)
                .map((p) => (
                  <Box key={p.id} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Chip size="small" label={`onda ${p.wave}`} sx={{ height: 18, fontSize: "0.6rem" }} />
                    <Typography variant="body2" fontWeight={600}>{p.id}</Typography>
                    <Typography variant="caption" color="text.secondary">{p.type}</Typography>
                    {p.dependsOn.length > 0 && (
                      <Typography variant="caption" color="text.disabled">
                        ← depende de {p.dependsOn.join(", ")}
                      </Typography>
                    )}
                    {(p.files?.length ?? 0) > 0 && (
                      <Chip size="small" variant="outlined" label={`${p.files!.length} arquivo(s)${p.connectDeclaration ? " · connect.yaml" : ""}`} sx={{ height: 18, fontSize: "0.6rem" }} />
                    )}
                    {p.rationale && (
                      <Typography variant="caption" color="text.secondary" sx={{ flexBasis: "100%", pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
                        {p.rationale}
                      </Typography>
                    )}
                  </Box>
                ))}
            </Stack>

            {poll.specs && Object.keys(poll.specs).length > 0 && (
              <Accordion disableGutters sx={{ bgcolor: "transparent" }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="caption" fontWeight={600}>Ver specs geradas ({specsCount})</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1}>
                    {Object.entries(poll.specs).map(([path, content]) => (
                      <Box key={path}>
                        <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>{path}</Typography>
                        <Box component="pre" sx={{
                          m: 0, p: 1, bgcolor: "action.hover", borderRadius: 1, fontSize: "0.7rem",
                          whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto",
                        }}>
                          {content.slice(0, 1200)}{content.length > 1200 ? "\n…" : ""}
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            )}

            <Alert severity="info" sx={{ mt: 1 }}>
              Ao salvar, os projetos entram na Bancada como <b>rascunhos</b> — nada é executado.
              Você promove à fábrica quando quiser.
            </Alert>
          </Box>
        )}

        {phase === "saving" && (
          <Box sx={{ py: 4, textAlign: "center" }}>
            <CircularProgress size={30} sx={{ mb: 2 }} />
            <Typography variant="body2" color="text.secondary">Salvando rascunhos na Bancada…</Typography>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: "wrap", gap: 0.5 }}>
        {/* Fechar o diálogo NUNCA mata o job: ele segue na API e aparece em "Propostas de produto".
            Enquanto trabalha, o botão vira "Fechar e acompanhar depois"; o Cancelar (ao lado)
            é o que interrompe o job de fato. */}
        <Button onClick={onClose} disabled={phase === "saving"}>
          {phase === "review" ? "Descartar" : phase === "polling" ? "Fechar e acompanhar depois" : "Fechar"}
        </Button>
        {(phase === "polling" || phase === "proposing") && (
          <Button color="warning" variant="outlined" onClick={cancelJob}
            startIcon={cancelling ? <CircularProgress size={14} color="inherit" /> : <StopCircleOutlinedIcon />}
            disabled={phase !== "polling" || !jobId || cancelling}>
            {cancelling ? "Cancelando…" : "Cancelar decomposição"}
          </Button>
        )}
        {(phase === "cancelled" || ((isSpecMode || isResume) && phase === "proposing" && !!error)) && canRetry && (
          <Button variant="contained" onClick={startFlow}>
            Refazer
          </Button>
        )}
        {phase === "input" && !isSpecMode && !isResume && (
          <Button variant="contained" onClick={startFlow} disabled={doc.trim().length < MIN_DOC_CHARS || doc.length > MAX_DOC_CHARS}>
            Decompor
          </Button>
        )}
        {phase === "review" && (
          <Button variant="contained" color="success" onClick={save}>
            Salvar rascunhos na Bancada
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
