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
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { cardsApi } from "@/lib/cards/cardsApi";
import { cardErrorCode, cardErrorMessage } from "@/lib/cards/cardErrors";
import type { BaseSpec, CardDetail } from "@/lib/cards/types";
import SpecCodeEditor from "@/components/SpecCodeEditor";
import SpecValidationPanel from "@/components/SpecValidationPanel";

interface DraftFile { id: string; filename: string; filePath: string; relDir: string | null; isPrimary: boolean }
const relPath = (f: DraftFile) => (f.relDir ? `${f.relDir}/${f.filename}` : f.filename);
type ChatMsg = { role: "user" | "assistant"; content: string };
type ChatJob = { jobId: string; status: "pending" | "running" | "done" | "error"; specMarkdown?: string | null; reply?: string; error?: string; filePath?: string | null; baseSha?: string | null; truncated?: boolean };

/** Rótulo visual: a spec inicial (do produto, só leitura) e a spec deste card (rascunho) NUNCA parecem a mesma coisa. */
function ScopeBadge({ kind }: { kind: "initial" | "card" }) {
  return kind === "initial"
    ? <Chip size="small" icon={<LockOutlinedIcon />} label="Spec inicial · somente leitura" sx={{ bgcolor: "grey.200", color: "grey.900", "& .MuiChip-icon": { color: "grey.900" } }} />
    : <Chip size="small" color="primary" icon={<EditNoteIcon />} label="Spec deste card" />;
}

function BasePanel({ card, onStale }: { card: CardDetail; onStale: (v: boolean) => void }) {
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
      sx={{ border: "2px dashed", borderColor: "grey.500", borderRadius: 1, p: 1.5, bgcolor: "action.hover", minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Typography id="base-spec-title" variant="subtitle2" component="h3">Spec atual do produto</Typography>
        <ScopeBadge kind="initial" />
        {base && <Typography variant="caption" color="text.secondary">v{base.headVersion} · {base.title}</Typography>}
      </Stack>
      {base?.stale && <Alert severity="warning" sx={{ mb: 1 }}>O produto avançou de versão depois da base deste card. Revalide o card antes de promover.</Alert>}
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
            sx={{ m: 0, p: 1, maxHeight: 360, overflow: "auto", bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1, whiteSpace: "pre-wrap", fontSize: "0.78rem" }}>
            {file?.content}
          </Box>
        </>
      )}
    </Box>
  );
}

export function CardSpecTab({ card, locked, onChanged, onStale }: {
  card: CardDetail; locked: boolean; onChanged: () => void | Promise<void>; onStale: (v: boolean) => void;
}) {
  const draftId = card.draftProjectId;
  const editableState = card.state === "draft" || card.state === "refining";
  const readOnly = locked || !editableState;
  const [files, setFiles] = useState<DraftFile[] | null>(null);
  const [path, setPath] = useState<string>("");
  const [content, setContent] = useState("");
  const [baseSha, setBaseSha] = useState("");
  const [orig, setOrig] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [versionsSignal, setVersionsSignal] = useState(0);
  const [reopening, setReopening] = useState(false);

  const loadFiles = useCallback(async () => {
    if (!draftId) return;
    try {
      const list = await apiGet<DraftFile[]>(`/api/projects/${draftId}/spec-files`);
      // Os arquivos do pedido (tickets/TK-NNNN/…) são do cartão, não da spec editável.
      const spec = list.filter((f) => !/^tickets\//.test(f.relDir ?? ""));
      setFiles(spec);
      setPath((cur) => (cur && spec.some((f) => relPath(f) === cur) ? cur : spec[0] ? relPath(spec[0]) : ""));
    } catch (e) { setError(cardErrorMessage(e)); setFiles([]); }
  }, [draftId]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);

  const loadFile = useCallback(async (p: string) => {
    if (!draftId || !p) { setContent(""); setOrig(""); return; }
    try {
      const f = await apiGet<{ path: string; content: string; contentSha256: string }>(`/api/projects/${draftId}/spec-file?path=${encodeURIComponent(p)}`);
      setContent(f.content); setOrig(f.content); setBaseSha(f.contentSha256); setError(null);
    } catch (e) { setError(cardErrorMessage(e)); }
  }, [draftId]);
  useEffect(() => { void loadFile(path); }, [path, loadFile, card.updatedAt]);

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await apiPut<{ ok: boolean; contentSha256: string }>(`/api/projects/${draftId}/spec-file?path=${encodeURIComponent(path)}`, { content, baseSha });
      setBaseSha(r.contentSha256); setOrig(content); setSaved(true); setVersionsSignal((n) => n + 1);
      await onChanged();
    } catch (e) {
      setError(cardErrorMessage(e));
      if (cardErrorCode(e) === "CARD_SPEC_LOCKED") await onChanged();
    } finally { setBusy(false); }
  };
  const createFile = async () => {
    const p = newPath.trim();
    if (!p) return;
    setBusy(true); setError(null);
    try { await apiPost(`/api/projects/${draftId}/spec-file`, { path: p, content: `# ${p}\n\n` }); setNewPath(""); await loadFiles(); setPath(p); }
    catch (e) { setError(cardErrorMessage(e)); } finally { setBusy(false); }
  };
  const reopen = async () => {
    setReopening(true); setError(null);
    try { await cardsApi.refine(card.id); await onChanged(); } catch (e) { setError(cardErrorMessage(e)); } finally { setReopening(false); }
  };

  // ── Chat IA sobre o rascunho (reaproveita /api/spec-chat da Bancada) ─────────────────────────────
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ content: string; truncated: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const send = async () => {
    const text = draft.trim();
    if (!text || sending || readOnly || !path) return;
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next); setDraft(""); setSending(true); setError(null);
    try {
      const job = await apiPost<ChatJob>("/api/spec-chat", { specMarkdown: content, messages: next, projectId: draftId, filePath: path, baseSha });
      const poll = async (jobId: string, tries: number): Promise<void> => {
        const j = await apiGet<ChatJob>(`/api/spec-chat/${jobId}`);
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

  return (
    <Stack spacing={2}>
      {locked && (
        <Alert severity="warning" data-testid="spec-locked"
          action={<Button color="inherit" size="small" disabled={reopening} onClick={() => void reopen()}>{reopening ? "Reabrindo…" : "Reabrir para edição"}</Button>}>
          A especificação está travada porque o card está pronto para promover. Para alterá-la, reabra o card: ele volta a “Refinando” e precisa ser validado de novo.
        </Alert>
      )}
      {!locked && !editableState && <Alert severity="info">Card em “{card.state}”: a especificação é apenas histórica e não pode mais ser editada.</Alert>}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, alignItems: "start" }}>
        <BasePanel card={card} onStale={onStale} />
        <Box component="section" aria-labelledby="card-spec-title" sx={{ border: "2px solid", borderColor: "primary.main", borderRadius: 1, p: 1.5, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Typography id="card-spec-title" variant="subtitle2" component="h3">Especificação do card</Typography>
            <ScopeBadge kind="card" />
            <Typography variant="caption" color="text.secondary">{card.code}{readOnly ? " · somente leitura" : " · editável"}</Typography>
          </Stack>
          {files === null && <CircularProgress size={20} aria-label="Carregando arquivos" />}
          {files && files.length === 0 && <Typography variant="body2" sx={{ mb: 1 }}>O rascunho ainda não tem arquivos de especificação.</Typography>}
          {files && files.length > 0 && (
            <TextField select size="small" label="Arquivo da spec do card" value={path} onChange={(e) => setPath(e.target.value)} fullWidth sx={{ mb: 1 }}>
              {files.map((f) => <MenuItem key={f.id} value={relPath(f)}>{relPath(f)}</MenuItem>)}
            </TextField>
          )}
          {path && (
            <Box sx={{ border: "1px solid", borderColor: "divider" }}>
              <SpecCodeEditor value={content} onChange={readOnly ? undefined : setContent} readOnly={readOnly} height="320px" ext={path.split(".").pop() ?? "md"} />
            </Box>
          )}
          {!readOnly && (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
              <Button size="small" variant="contained" disabled={busy || !path || content === orig} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar"}</Button>
              <TextField size="small" label="Novo arquivo (ex.: rfc/RFC-001.md)" value={newPath} onChange={(e) => setNewPath(e.target.value)} sx={{ minWidth: 220 }} />
              <Button size="small" variant="outlined" disabled={busy || !newPath.trim()} onClick={() => void createFile()}>Criar arquivo</Button>
            </Stack>
          )}
          {saved && <Alert severity="success" role="status" sx={{ mt: 1 }}>Salvo. Valide o card quando terminar o refinamento.</Alert>}
          {error && <Alert severity="error" role="alert" sx={{ mt: 1 }}>{error}</Alert>}
        </Box>
      </Box>

      <Accordion disableGutters variant="outlined">
        <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="card-chat-body" id="card-chat-head">Chat IA sobre o rascunho do card</AccordionSummary>
        <AccordionDetails id="card-chat-body">
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
            O assistente revisa o arquivo aberto da spec deste card, lendo a spec atual do produto só como referência. Nada é salvo sem você aplicar e salvar.
          </Typography>
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
            <TextField size="small" fullWidth label="Mensagem para o assistente" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={readOnly || sending}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <Button variant="contained" size="small" onClick={() => void send()} disabled={readOnly || sending || !draft.trim() || !path}>Enviar</Button>
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
