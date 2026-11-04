"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import EditNoteIcon from "@mui/icons-material/EditNote";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorCode, cardErrorMessage } from "@/lib/cards/cardErrors";
import { cardWritableMasks, isRequestFile, newFilePathProblem, specApi, suggestRfcPath, visibleDraftFiles } from "@/lib/cards/specApi";
import type { PlanJob } from "@/lib/cards/schemas";
import { STATE_LABEL, type BaseSpec, type CardDetail } from "@/lib/cards/types";
import type { CardRunner } from "./useCardRunner";
import { accentColor } from "./CardsA11yTheme";
import SpecCodeEditor from "@/components/SpecCodeEditor";
import SpecValidationPanel from "@/components/SpecValidationPanel";

type ChatMsg = { role: "user" | "assistant"; content: string };
type PlanPhase = { state: "idle" } | { state: "running" } | { state: "done"; result: NonNullable<PlanJob["result"]> } | { state: "error"; message: string };
const PLAN_POLL_MS = 2000;
const PLAN_MAX_POLLS = 150;   // ~5 min: o servidor interrompe o planejamento antes disso

/** Rótulo visual: a spec inicial (do produto, só leitura) e a spec deste card (rascunho) NUNCA parecem a mesma coisa. */
function ScopeBadge({ kind }: { kind: "initial" | "card" }) {
  return kind === "initial"
    ? <Chip size="small" icon={<LockOutlinedIcon />} label="Spec inicial · somente leitura" sx={{ bgcolor: "grey.200", color: "grey.900", "& .MuiChip-icon": { color: "grey.900" } }} />
    : <Chip size="small" color="primary" icon={<EditNoteIcon />} label="Spec deste card" />;
}

function BasePanel({ card, onStale, stale }: { card: CardDetail; onStale: (v: boolean) => void; stale?: boolean | null }) {
  const [base, setBase] = useState<BaseSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    let alive = true;
    cardsApi.baseSpec(card.id).then((b) => { if (!alive) return; setBase(b); setSel(Math.max(0, b.files.findIndex((f) => f.isPrimary))); onStale(b.stale); })
      .catch((e) => { if (alive) setError(cardErrorMessage(e)); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, card.updatedAt]);
  const file = base?.files[sel];
  return (
    <Box component="section" aria-labelledby="base-spec-title"
      sx={{ border: "2px dashed", borderColor: "grey.500", borderRadius: 1, p: 1.5, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography id="base-spec-title" variant="subtitle2" component="h2">Spec atual do produto</Typography>
        <ScopeBadge kind="initial" />
        {base && <Typography variant="caption" color="text.secondary">v{base.headVersion} · {base.title}</Typography>}
      </Stack>
      {(stale ?? base?.stale) && <Alert severity="warning" sx={{ mb: 1 }}>O produto avançou de versão depois da base deste card. Revalide o card antes de promover.</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      {!base && !error && <CircularProgress size={20} aria-label="Carregando spec do produto" />}
      {base && base.files.length === 0 && <Typography variant="body2">A versão atual não tem arquivos de especificação legíveis.</Typography>}
      {base && base.files.length > 0 && (
        <>
          <TextField select size="small" label="Arquivo da spec do produto" value={sel} onChange={(e) => setSel(Number(e.target.value))} fullWidth sx={{ mb: 1 }}>
            {base.files.map((f, i) => <MenuItem key={f.path} value={i}>{f.path}</MenuItem>)}
          </TextField>
          {file?.truncated && <Alert severity="info" sx={{ mb: 1 }}>Arquivo exibido parcialmente (teto de leitura).</Alert>}
          <Box component="pre" tabIndex={0} aria-label={`Conteúdo somente leitura de ${file?.path ?? ""}`}
            sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: accentColor, outlineOffset: 2 }, m: 0, p: 1, maxHeight: 360, overflow: "auto", bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1, whiteSpace: "pre-wrap", fontSize: "0.78rem" }}>
            {file?.truncated || file?.content == null ? "(conteúdo acima do teto de leitura: abra a spec da versão pelo projeto)" : file.content}
          </Box>
        </>
      )}
    </Box>
  );
}

export function CardSpecTab({ card, locked, canReopen, runner, onChanged, onStale, baseStale, planRequested = false, onPlanStarted }: {
  card: CardDetail; locked: boolean; canReopen: boolean; runner: CardRunner; onChanged: () => void | Promise<void>; onStale: (v: boolean) => void; baseStale?: boolean | null;
  /** A ação sugerida “Gerar o RFC com a IA” (situação do card) pediu o planner: a aba o dispara UMA vez e avisa por `onPlanStarted`. */
  planRequested?: boolean; onPlanStarted?: () => void;
}) {
  const draftId = card.draftProjectId;
  const editableState = card.state === "draft" || card.state === "refining";
  const readOnly = locked || !editableState;
  const [files, setFiles] = useState<string[] | null>(null);   // arquivos do card: pedido, RFCs e ADRs
  const [path, setPath] = useState<string>("");
  const [content, setContent] = useState("");
  const [baseSha, setBaseSha] = useState("");
  const [orig, setOrig] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newPathTouched, setNewPathTouched] = useState(false);
  const [versionsSignal, setVersionsSignal] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadFiles = useCallback(async (prefer?: string) => {
    if (!draftId) return;
    try {
      const tree = await specApi.tree(draftId);
      const list = visibleDraftFiles(card.code, tree.files.map((f) => f.path));
      if (!alive.current) return;
      setFiles(list);
      // Abre o RFC/ADR do card quando houver; senão o pedido (somente leitura).
      setPath((cur) => (prefer && list.includes(prefer) ? prefer : cur && list.includes(cur) ? cur : list[0] ?? ""));
    } catch (e) { if (alive.current) { setError(cardErrorMessage(e)); setFiles([]); } }
  }, [draftId, card.code]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);
  useEffect(() => { if (files && !newPathTouched) setNewPath(suggestRfcPath(files, card.title)); }, [files, card.title, newPathTouched]);

  const loadFile = useCallback(async (p: string) => {
    if (!draftId || !p) { setContent(""); setOrig(""); return; }
    try {
      const f = await specApi.read(draftId, p);
      setContent(f.content); setOrig(f.content); setBaseSha(f.contentSha256); setError(null); setConflict(false);
    } catch (e) { setError(cardErrorMessage(e)); }
  }, [draftId]);
  useEffect(() => { void loadFile(path); }, [path, loadFile, card.updatedAt]);

  const requestSelected = isRequestFile(path);
  const fileReadOnly = readOnly || requestSelected;   // o pedido original é imutável

  const save = async () => {
    setBusy(true); setError(null); setSaved(false); setConflict(false);
    try {
      const r = await specApi.write(draftId!, path, content, baseSha);
      setBaseSha(r.contentSha256); setOrig(content); setSaved(true); setVersionsSignal((n) => n + 1);
      await onChanged();
    } catch (e) {
      setError(cardErrorMessage(e));
      const code = cardErrorCode(e);
      if (code === "CONFLICT") setConflict(true);
      if (code === "CARD_SPEC_LOCKED") await onChanged();
    } finally { setBusy(false); }
  };
  const newPathProblem = newPath.trim() ? newFilePathProblem(card.code, newPath) : null;
  const createFile = async () => {
    const p = newPath.trim();
    const problem = newFilePathProblem(card.code, p);
    if (problem) { setNewPathTouched(true); setError(problem); return; }
    setBusy(true); setError(null);
    try {
      await specApi.create(draftId!, p, `# ${p.split("/").pop()?.replace(/\.md$/i, "") ?? p}\n\n`);
      setNewPathTouched(false);
      await loadFiles(p); await onChanged();
    } catch (e) { setError(cardErrorMessage(e)); } finally { setBusy(false); }
  };
  const fromTemplate = async () => {
    setBusy(true); setError(null);
    try {
      const r = await specApi.rfcFromTemplate(draftId!, card.title);
      await loadFiles(r.path); await onChanged();
    } catch (e) { setError(cardErrorMessage(e)); } finally { setBusy(false); }
  };

  // ── Planner de RFC (evolution-plan): gera RFC/ADR do card a partir do pedido, pelo orçamento compartilhado do produto ──
  const [planText, setPlanText] = useState("");
  const [plan, setPlan] = useState<PlanPhase>({ state: "idle" });
  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (planTimer.current) clearTimeout(planTimer.current); }, []);
  const planBusy = useRef(false);
  const generateRfc = useCallback(async () => {
    if (!draftId || readOnly || planBusy.current) return;
    planBusy.current = true;
    setPlan({ state: "running" }); setError(null);
    try {
      const start = await specApi.planStart(draftId, planText.trim() || undefined);
      const poll = async (n: number): Promise<void> => {
        const j = await specApi.planPoll(draftId, start.jobId);
        if (!alive.current) return;
        if (j.status === "done" && j.result) {
          const first = j.result.written.find((w) => w.path.startsWith("docs/rfc/") && w.action !== "skipped")?.path ?? j.result.written[0]?.path;
          planBusy.current = false; setPlan({ state: "done", result: j.result });
          await loadFiles(first); await onChanged(); setVersionsSignal((v) => v + 1);
        } else if (j.status === "error" || j.status === "interrupted" || n <= 0) {
          planBusy.current = false; setPlan({ state: "error", message: j.error ?? "O arquiteto não respondeu a tempo. Tente de novo." });
        } else planTimer.current = setTimeout(() => { void poll(n - 1).catch((e) => { planBusy.current = false; if (alive.current) setPlan({ state: "error", message: cardErrorMessage(e) }); }); }, PLAN_POLL_MS);
      };
      await poll(PLAN_MAX_POLLS);
    } catch (e) { planBusy.current = false; if (alive.current) setPlan({ state: "error", message: cardErrorMessage(e) }); }
  }, [draftId, readOnly, planText, loadFiles, onChanged]);
  useEffect(() => {
    if (!planRequested) return;
    onPlanStarted?.();
    void generateRfc();
  }, [planRequested, onPlanStarted, generateRfc]);

  // ── Chat IA sobre o arquivo aberto (RFC/ADR do card; reaproveita /api/spec-chat da Bancada) ──────────────────────
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ content: string; truncated: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { setPending(null); }, [path]);
  const chatDisabled = fileReadOnly || !path;
  const send = async () => {
    const text = draft.trim();
    if (!text || sending || chatDisabled) return;
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next); setDraft(""); setSending(true); setError(null);
    try {
      const job = await specApi.chatStart({ specMarkdown: content, messages: next, projectId: draftId!, filePath: path, baseSha });
      const poll = async (jobId: string, tries: number): Promise<void> => {
        const j = await specApi.chatPoll(jobId);
        if (!alive.current) return;
        if (j.status === "done") {
          setMsgs((m) => [...m, { role: "assistant", content: j.reply || "Revisão pronta. Confira e aplique no editor." }]);
          if (j.specMarkdown) setPending({ content: j.specMarkdown, truncated: j.truncated === true });
          setSending(false);
        } else if (j.status === "error" || tries <= 0) {
          setError(j.error ?? "O assistente não respondeu a tempo. Tente de novo."); setSending(false);
        } else { timer.current = setTimeout(() => { void poll(jobId, tries - 1).catch((e) => { setError(cardErrorMessage(e)); setSending(false); }); }, 2000); }
      };
      await poll(job.jobId, 300);
    } catch (e) { setError(cardErrorMessage(e)); setSending(false); }
  };

  if (!draftId) return <Alert severity="info">Este card não tem rascunho de especificação (ele é anterior ao modelo de cards ou foi promovido sem rascunho).</Alert>;

  const hasRfc = !!files?.some((f) => f.startsWith("docs/rfc/"));
  return (
    <Stack spacing={2}>
      {locked && canReopen && (
        <Alert severity="warning" data-testid="spec-locked"
          action={<Button color="inherit" size="small" disabled={!!runner.busy} onClick={() => void runner.run("reopen")} sx={{ minHeight: 32 }}>{runner.busy === "reopen" ? "Reabrindo…" : "Reabrir para edição"}</Button>}>
          A especificação está travada porque o card está pronto para promover. Para alterá-la, reabra o card: ele volta a “Refinando” e precisa ser validado de novo.
        </Alert>
      )}
      {locked && !canReopen && (
        <Alert severity="info" data-testid="spec-locked">
          A especificação está travada: com o card em “{STATE_LABEL[card.state]}” ela é apenas histórica e não pode mais ser editada nem reaberta.
        </Alert>
      )}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, alignItems: "start" }}>
        <BasePanel card={card} onStale={onStale} stale={baseStale} />
        <Box component="section" aria-labelledby="card-spec-title" sx={{ border: "2px solid", borderColor: "primary.main", borderRadius: 1, p: 1.5, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Typography id="card-spec-title" variant="subtitle2" component="h2">Especificação do card</Typography>
            <ScopeBadge kind="card" />
            <Typography variant="caption" color="text.secondary">{card.code}{readOnly ? " · somente leitura" : " · editável"}</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }} data-testid="writable-scope">
            O card escreve só em {cardWritableMasks(card.code).join(", ")}. O pedido original ({card.code}) é imutável.
          </Typography>
          {!readOnly && (
            <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1, mb: 1.5 }} data-testid="rfc-generator">
              <Typography variant="body2" fontWeight={600} component="p">RFC do card</Typography>
              {!hasRfc && files !== null && <Typography variant="body2" color="text.secondary">O card ainda não tem RFC. Para validar, ele precisa de um RFC com critérios de aceite em Gherkin.</Typography>}
              <TextField size="small" fullWidth multiline minRows={2} label="Instruções para o arquiteto (opcional)" value={planText} onChange={(e) => setPlanText(e.target.value)}
                disabled={plan.state === "running" || busy} sx={{ mt: 1 }} helperText="Sem instruções, o arquiteto usa o pedido do card. A geração usa o orçamento de IA do produto." />
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
                <Button size="small" variant="contained" disabled={plan.state === "running" || busy} onClick={() => void generateRfc()}>{plan.state === "running" ? "Gerando o RFC…" : "Gerar RFC com a IA"}</Button>
                <Button size="small" variant="outlined" disabled={plan.state === "running" || busy} onClick={() => void fromTemplate()}>Novo RFC a partir do modelo</Button>
                {plan.state === "running" && <CircularProgress size={18} aria-label="O arquiteto está escrevendo o RFC" />}
              </Stack>
              {plan.state === "running" && <Typography variant="caption" component="p" role="status" sx={{ mt: 0.5 }}>O arquiteto está escrevendo o RFC. Isso pode levar alguns minutos; você pode continuar nesta tela.</Typography>}
              {plan.state === "error" && <Alert severity="error" role="alert" sx={{ mt: 1 }} data-testid="plan-error">{plan.message}</Alert>}
              {plan.state === "done" && (
                <Alert severity={plan.result.rfcProblems.length ? "warning" : "success"} role="status" sx={{ mt: 1 }} data-testid="plan-done">
                  <b>{plan.result.summary || "RFC gerado."}</b> Gravado: {plan.result.written.filter((w) => w.action !== "skipped").map((w) => w.path).join(", ") || "nada novo"}. Confira no editor e ajuste antes de validar.
                  {plan.result.rfcProblems.length > 0 && <Box component="ul" aria-label="Problemas do RFC" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>{plan.result.rfcProblems.map((p) => <li key={p.path}>{p.path}: {p.problems.join("; ")}</li>)}</Box>}
                  {plan.result.questions.length > 0 && <Box component="ul" aria-label="Perguntas do arquiteto" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>{plan.result.questions.map((q, i) => <li key={i}>{q}</li>)}</Box>}
                  {plan.result.warnings.length > 0 && <Box component="ul" aria-label="Avisos do arquiteto" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>{plan.result.warnings.map((w, i) => <li key={i}>{w}</li>)}</Box>}
                </Alert>
              )}
            </Box>
          )}
          {files === null && <CircularProgress size={20} aria-label="Carregando arquivos" />}
          {files && files.length === 0 && <Typography variant="body2" sx={{ mb: 1 }}>O rascunho ainda não tem arquivos.</Typography>}
          {files && files.length > 0 && (
            <TextField select size="small" label="Arquivo do card" value={path} onChange={(e) => setPath(e.target.value)} fullWidth sx={{ mb: 1 }}>
              {files.map((f) => <MenuItem key={f} value={f}>{f}{isRequestFile(f) ? " (pedido, somente leitura)" : ""}</MenuItem>)}
            </TextField>
          )}
          {path && (
            <Box sx={{ border: "1px solid", borderColor: "divider" }}>
              <SpecCodeEditor value={content} onChange={fileReadOnly ? undefined : setContent} readOnly={fileReadOnly} height="320px" ext={path.split(".").pop() ?? "md"} ariaLabel={`${fileReadOnly ? "Conteúdo somente leitura de" : "Editor de"} ${path}`} />
            </Box>
          )}
          {path && !fileReadOnly && <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>No editor, a tecla Tab insere recuo; para continuar pelo teclado, pressione Esc e depois Tab.</Typography>}
          {!readOnly && (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="flex-start">
              <Button size="small" variant="contained" disabled={busy || !path || fileReadOnly || content === orig} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar"}</Button>
              <TextField size="small" label="Novo arquivo (RFC ou ADR)" value={newPath} onChange={(e) => { setNewPathTouched(true); setNewPath(e.target.value); }}
                error={!!newPathProblem} helperText={newPathProblem ?? "Ex.: docs/rfc/RFC-0001-nome.md ou docs/adr/ADR-001-nome.md"} sx={{ minWidth: 280, flex: "1 1 280px" }} />
              <Button size="small" variant="outlined" disabled={busy || !newPath.trim() || !!newPathProblem} onClick={() => void createFile()} sx={{ mt: "3px" }}>Criar arquivo</Button>
            </Stack>
          )}
          {saved && <Alert severity="success" role="status" sx={{ mt: 1 }}>Salvo. Valide o card quando terminar o refinamento.</Alert>}
          {error && (
            <Alert severity="error" role="alert" sx={{ mt: 1 }} action={conflict ? <Button color="inherit" size="small" onClick={() => void loadFile(path)}>Recarregar</Button> : undefined}>{error}</Alert>
          )}
        </Box>
      </Box>

      <Accordion disableGutters variant="outlined">
        <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="card-chat-body" id="card-chat-head">Chat IA sobre o arquivo do card</AccordionSummary>
        <AccordionDetails id="card-chat-body">
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
            O assistente revisa o arquivo aberto (RFC ou ADR do card), lendo a spec atual do produto só como referência. Nada é salvo sem você aplicar e salvar.
          </Typography>
          {requestSelected && !readOnly && <Alert severity="info" sx={{ mb: 1 }}>O pedido original é imutável. Selecione ou crie um RFC/ADR do card para conversar sobre ele.</Alert>}
          <Box role="log" aria-live="polite" aria-label="Conversa" sx={{ maxHeight: 240, overflow: "auto", mb: 1 }}>
            {msgs.map((m, i) => <Typography key={i} variant="body2" sx={{ mb: 0.75, fontWeight: m.role === "user" ? 600 : 400 }}>{m.role === "user" ? "Você: " : "Assistente: "}{m.content}</Typography>)}
            {sending && <Typography variant="caption" color="text.secondary">O assistente está trabalhando…</Typography>}
          </Box>
          {pending && (
            <Alert severity={pending.truncated ? "warning" : "info"} sx={{ mb: 1 }}
              action={<Button color="inherit" size="small" disabled={pending.truncated} onClick={() => { setContent(pending.content); setPending(null); }}>Aplicar no editor</Button>}>
              {pending.truncated ? "A resposta veio cortada e não pode ser aplicada." : "Revisão pronta: aplicar substitui o texto do editor (ainda sem salvar)."}
            </Alert>
          )}
          <Stack direction="row" spacing={1}>
            <TextField size="small" fullWidth label="Mensagem para o assistente" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={chatDisabled || sending}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <Button variant="contained" size="small" onClick={() => void send()} disabled={chatDisabled || sending || !draft.trim()}>Enviar</Button>
          </Stack>
        </AccordionDetails>
      </Accordion>

      <Accordion disableGutters variant="outlined">
        <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="card-gaps-body" id="card-gaps-head">GAPs e validação da spec do card</AccordionSummary>
        <AccordionDetails id="card-gaps-body"><SpecValidationPanel projectId={draftId} activeFilePath={path || null} reloadSignal={versionsSignal} /></AccordionDetails>
      </Accordion>
    </Stack>
  );
}
