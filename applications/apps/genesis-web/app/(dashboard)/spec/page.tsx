"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import PreviewIcon from "@mui/icons-material/Preview";
import SendIcon from "@mui/icons-material/Send";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { motion, AnimatePresence } from "framer-motion";
import { apiGet, apiPost, apiPostMultipart } from "@/lib/api";
import { projectsStore } from "@/stores/projectsStore";

// Lazy-load react-markdown (heavy, browser-only)
const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false });

const ACCEPT = ".md,.txt,.doc,.docx,.pdf";
type SubmitResponse = { projectId: string; status: string; message: string };
type SpecJobResponse = { jobId: string; status: "pending" | "running" | "done" | "error"; specMarkdown?: string; summary?: string; error?: string; elapsed?: number };

function formatFileSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Markdown Preview ──────────────────────────────────────────────────────────
function MarkdownPreview({ content }: { content: string }) {
  return (
    <Box
      sx={{
        height: "100%", overflowY: "auto", p: 2.5,
        "& h1": { fontSize: "1.4rem", fontWeight: 700, mb: 1.5, mt: 0, borderBottom: "1px solid", borderColor: "divider", pb: 0.5 },
        "& h2": { fontSize: "1.1rem", fontWeight: 600, mb: 1, mt: 2.5, color: "primary.main" },
        "& h3": { fontSize: "0.95rem", fontWeight: 600, mb: 0.75, mt: 2 },
        "& p":  { fontSize: "0.85rem", lineHeight: 1.7, mb: 1, color: "text.primary" },
        "& ul, & ol": { pl: 2.5, mb: 1 },
        "& li": { fontSize: "0.85rem", lineHeight: 1.6, mb: 0.25 },
        "& code": { bgcolor: "action.hover", px: 0.5, py: 0.15, borderRadius: 0.5, fontFamily: "monospace", fontSize: "0.78rem" },
        "& pre": { bgcolor: "action.hover", p: 1.5, borderRadius: 1, overflowX: "auto", mb: 1.5 },
        "& pre code": { bgcolor: "transparent", p: 0 },
        "& table": { width: "100%", borderCollapse: "collapse", mb: 1.5, fontSize: "0.82rem" },
        "& th": { bgcolor: "action.hover", fontWeight: 600, px: 1, py: 0.5, borderBottom: "2px solid", borderColor: "divider", textAlign: "left" },
        "& td": { px: 1, py: 0.4, borderBottom: "1px solid", borderColor: "divider" },
        "& blockquote": { borderLeft: "3px solid", borderColor: "primary.main", pl: 1.5, ml: 0, color: "text.secondary", fontStyle: "italic" },
        "& hr": { borderColor: "divider", my: 2 },
      }}
    >
      <ReactMarkdown>{content}</ReactMarkdown>
    </Box>
  );
}

// ── Editor + Preview side by side ─────────────────────────────────────────────
function SpecEditor({
  value, onChange, fullscreen, onToggleFullscreen,
  onSave, onSaveAndStart, approving, onRegen, regenDisabled,
}: {
  value: string;
  onChange: (v: string) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSave: () => void;
  onSaveAndStart: () => void;
  approving: "save" | "start" | null;
  onRegen: () => void;
  regenDisabled: boolean;
}) {
  const [editorTab, setEditorTab] = useState<"edit" | "preview" | "split">("split");

  const toolbar = (
    <Stack direction="row" alignItems="center" justifyContent="space-between"
      sx={{ px: 1.5, py: 0.75, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Tabs value={editorTab} onChange={(_e, v) => setEditorTab(v as typeof editorTab)} sx={{ minHeight: 32 }}>
          <Tab value="edit"    icon={<EditIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Editar"    sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="split"   icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Lado a lado" sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="preview" icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Preview"  sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
        </Tabs>
        <Chip label={`${value.split("\n").length} linhas`} size="small" sx={{ fontSize: "0.65rem", height: 18, ml: 1 }} />
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Tooltip title="Regenerar spec com IA">
          <span>
            <Button size="small" variant="outlined" startIcon={<AutoFixHighIcon sx={{ fontSize: "0.8rem !important" }} />}
              disabled={regenDisabled} onClick={onRegen} sx={{ fontSize: "0.7rem", py: 0.3 }}>
              Regenerar
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Guardar a ideia — iniciar quando quiser">
          <span>
            <Button size="small" variant="outlined"
              startIcon={approving === "save" ? <CircularProgress size={12} /> : <span style={{ fontSize: "0.9rem" }}>💾</span>}
              disabled={approving !== null || !value.trim()} onClick={onSave}
              sx={{ fontSize: "0.72rem", py: 0.35 }}>
              {approving === "save" ? "Salvando…" : "Salvar rascunho"}
            </Button>
          </span>
        </Tooltip>
        <Button size="small" variant="contained" color="success"
          startIcon={approving === "start" ? <CircularProgress size={12} /> : <CheckCircleIcon sx={{ fontSize: "0.85rem !important" }} />}
          disabled={approving !== null || !value.trim()} onClick={onSaveAndStart} sx={{ fontSize: "0.75rem", py: 0.4 }}>
          {approving === "start" ? "Iniciando…" : "Salvar e iniciar pipeline"}
        </Button>
        <Tooltip title={fullscreen ? "Sair de tela cheia" : "Tela cheia"}>
          <IconButton size="small" onClick={onToggleFullscreen}>
            {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );

  const editorArea = (h: string) => (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%", height: h, resize: "none", border: "none", outline: "none",
        background: "transparent", color: "inherit", fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: "0.78rem", lineHeight: 1.7, padding: "16px", boxSizing: "border-box",
      }}
      spellCheck={false}
    />
  );

  const content = (areaH: string) => {
    if (editorTab === "edit") return editorArea(areaH);
    if (editorTab === "preview") return <MarkdownPreview content={value} />;
    // split
    return (
      <Box sx={{ display: "flex", height: areaH, overflow: "hidden" }}>
        <Box sx={{ flex: 1, borderRight: "1px solid", borderColor: "divider", overflow: "hidden" }}>
          {editorArea("100%")}
        </Box>
        <Box sx={{ flex: 1, overflow: "hidden" }}>
          <MarkdownPreview content={value} />
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {toolbar}
      <Box sx={{ flexGrow: 1, overflow: "hidden", bgcolor: "background.default" }}>
        {content("100%")}
      </Box>
    </Box>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function SpecPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const inputRef     = useRef<HTMLInputElement>(null);

  // URL params
  const [parentProjectId, setParentProjectId] = useState<string | null>(null);
  const [parentTitle, setParentTitle]         = useState<string | null>(null);

  // Tab: 0=texto livre, 1=upload arquivo
  const [tab, setTab] = useState(0);

  // Texto livre flow
  const [freeText, setFreeText]         = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [generating, setGenerating]     = useState(false);
  const [genError, setGenError]         = useState<string | null>(null);
  const [genElapsed, setGenElapsed]     = useState(0);
  const [genPhase, setGenPhase]         = useState<"idle" | "queued" | "thinking" | "writing">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Spec editor
  const [specMarkdown, setSpecMarkdown] = useState<string | null>(null);
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  const [approving, setApproving]       = useState<"save" | "start" | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Upload flow
  const [files, setFiles]         = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult]       = useState<SubmitResponse | null>(null);

  useEffect(() => {
    const pp = searchParams?.get("parentProjectId");
    const pt = searchParams?.get("parentTitle");
    if (pp) setParentProjectId(pp);
    if (pt) setParentTitle(decodeURIComponent(pt));
  }, [searchParams]);

  // ── Generate spec via CTO — async job with polling ─────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!freeText.trim() || freeText.trim().length < 20) {
      setGenError("Descreva o produto com pelo menos 20 caracteres.");
      return;
    }
    setGenerating(true); setGenError(null); setGenElapsed(0); setGenPhase("queued");
    stopPolling();

    let jobId: string;
    try {
      const res = await apiPost<SpecJobResponse>("/api/spec-preview", {
        freeText: freeText.trim(),
        title: projectTitle.trim() || undefined,
      });
      jobId = res.jobId;
      setGenPhase("thinking");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Erro ao iniciar geração.");
      setGenerating(false); setGenPhase("idle");
      return;
    }

    // Poll every 3s until done or error
    const startTs = Date.now();
    pollRef.current = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTs) / 1000);
      setGenElapsed(elapsed);
      // Heuristic phases based on elapsed time
      if (elapsed > 20) setGenPhase("writing");
      else if (elapsed > 5) setGenPhase("thinking");

      try {
        const poll = await apiGet<SpecJobResponse>(`/api/spec-preview/${jobId}`);
        if (poll.status === "done") {
          stopPolling();
          setSpecMarkdown(poll.specMarkdown ?? "");
          setGenerating(false); setGenPhase("idle");
        } else if (poll.status === "error") {
          stopPolling();
          setGenError(poll.error ?? "O CTO encontrou um erro. Tente novamente.");
          setGenerating(false); setGenPhase("idle");
        }
        // still pending/running → keep polling
      } catch {
        // network error → keep polling silently
      }
    }, 3000);
  }, [freeText, projectTitle, stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Save spec (draft or start) ──────────────────────────────────────────────
  const handleSaveSpec = useCallback(async (startNow: boolean) => {
    if (!specMarkdown) return;
    setApproving(startNow ? "start" : "save"); setApproveError(null);
    try {
      const blob = new Blob([specMarkdown], { type: "text/markdown" });
      const filename = `${(projectTitle || "spec").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const file = new File([blob], filename, { type: "text/markdown" });
      const formData = new FormData();
      formData.append("title", projectTitle.trim() || "Spec sem título");
      if (parentProjectId) formData.append("parentProjectId", parentProjectId);
      formData.append("files", file);
      const data = await apiPostMultipart<SubmitResponse>("/api/specs", formData);
      projectsStore.loadProjects();

      if (startNow) {
        // Fire pipeline immediately then navigate
        try {
          await apiPost(`/api/projects/${data.projectId}/run`, {});
        } catch {
          // If run fails, user can still start manually from the project page
        }
      }
      setTimeout(() => router.push(`/projects/${data.projectId}`), 500);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Erro ao salvar spec.");
    } finally {
      setApproving(null);
    }
  }, [specMarkdown, projectTitle, parentProjectId, router]);

  // ── Upload flow ─────────────────────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) { setFiles((p) => [...p, ...Array.from(e.target.files!)]); setUploadError(null); }
    e.target.value = "";
  };
  const removeFile = (i: number) => setFiles((p) => p.filter((_, idx) => idx !== i));
  const handleUploadSubmit = async (e: React.FormEvent, startNow = false) => {
    e.preventDefault();
    if (!files.length) { setUploadError("Selecione pelo menos um arquivo."); return; }
    setSubmitting(true); setUploadError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("title", projectTitle.trim() || "Spec sem título");
      if (parentProjectId) fd.append("parentProjectId", parentProjectId);
      files.forEach((f) => fd.append("files", f));
      const data = await apiPostMultipart<SubmitResponse>("/api/specs", fd);
      setResult(data);
      projectsStore.loadProjects();
      if (data.projectId && startNow) {
        try { await apiPost(`/api/projects/${data.projectId}/run`, {}); } catch { /* ok */ }
      }
      if (data.projectId) setTimeout(() => router.push(`/projects/${data.projectId}`), 800);
    } catch (err) { setUploadError(err instanceof Error ? err.message : "Falha ao enviar spec."); }
    finally { setSubmitting(false); }
  };

  // ── Editor fullscreen dialog ────────────────────────────────────────────────
  const editorDialog = specMarkdown !== null && (
    <Dialog open={editorFullscreen} onClose={() => setEditorFullscreen(false)} fullScreen
      PaperProps={{ sx: { bgcolor: "background.default", m: 0 } }}>
      <DialogContent sx={{ p: 0, height: "100vh", display: "flex", flexDirection: "column" }}>
        {approveError && <Alert severity="error" sx={{ mx: 2, mt: 1 }} onClose={() => setApproveError(null)}>{approveError}</Alert>}
        <SpecEditor
          value={specMarkdown} onChange={setSpecMarkdown}
          fullscreen={true} onToggleFullscreen={() => setEditorFullscreen(false)}
          onSave={() => handleSaveSpec(false)} onSaveAndStart={() => handleSaveSpec(true)} approving={approving}
          onRegen={() => { setEditorFullscreen(false); setSpecMarkdown(null); }}
          regenDisabled={generating}
        />
      </DialogContent>
    </Dialog>
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <SendIcon sx={{ color: "primary.main" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Enviar spec ao CTO</Typography>
          <Typography variant="body2" color="text.secondary">
            Descreva o produto em texto livre ou faça upload de um arquivo existente.
          </Typography>
        </Box>
      </Stack>

      {parentProjectId && parentTitle && (
        <Alert severity="info" sx={{ mb: 2 }} icon={<span>🔁</span>}>
          <Typography variant="body2" fontWeight={500}>Nova versão de <strong>{parentTitle}</strong></Typography>
          <Typography variant="caption" color="text.secondary">O novo projeto será vinculado como versão seguinte do produto original.</Typography>
        </Alert>
      )}

      {/* Tabs */}
      <Card>
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          sx={{ borderBottom: "1px solid", borderColor: "divider", px: 2 }}>
          <Tab label={<Stack direction="row" spacing={0.75} alignItems="center"><AutoFixHighIcon sx={{ fontSize: "0.9rem" }} /><span>Descrever com texto livre</span></Stack>} sx={{ textTransform: "none", minHeight: 48 }} />
          <Tab label={<Stack direction="row" spacing={0.75} alignItems="center"><UploadFileIcon sx={{ fontSize: "0.9rem" }} /><span>Upload de arquivo</span></Stack>} sx={{ textTransform: "none", minHeight: 48 }} />
        </Tabs>

        <CardContent>
          {/* ── Tab 0: Texto livre ─────────────────────────────────────── */}
          {tab === 0 && (
            <Box>
              {/* Se spec ainda não foi gerada */}
              {specMarkdown === null && (
                <AnimatePresence mode="wait">
                  <motion.div key="input" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <TextField
                      fullWidth label="Título do projeto (opcional)"
                      value={projectTitle} onChange={(e) => setProjectTitle(e.target.value)}
                      size="small" sx={{ mb: 2 }}
                      placeholder="Ex.: E-commerce de calçados"
                    />
                    <TextField
                      fullWidth multiline rows={8}
                      label="Descreva o produto que você quer construir"
                      value={freeText} onChange={(e) => setFreeText(e.target.value)}
                      placeholder={"Exemplo:\n\nQuero um sistema de agendamento para barbearia. Precisa ter:\n- Cadastro de barbeiros e clientes\n- Agendamento online pelo cliente\n- Notificações por WhatsApp\n- Painel admin para os barbeiros\n- Relatório de atendimentos\n\nTecnologia: Node.js, MySQL, sem frontend por enquanto."}
                      sx={{ mb: 2, "& textarea": { fontFamily: "Inter, sans-serif", fontSize: "0.85rem", lineHeight: 1.7 } }}
                    />
                    {genError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setGenError(null)}>{genError}</Alert>}

                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Button
                        variant="contained" size="large"
                        startIcon={generating ? <CircularProgress size={18} color="inherit" /> : <AutoFixHighIcon />}
                        disabled={generating || freeText.trim().length < 20}
                        onClick={handleGenerate}
                        sx={{ px: 3 }}
                      >
                        {generating ? "Gerando spec com IA…" : "Gerar spec com IA"}
                      </Button>
                      {generating && (
                        <Typography variant="caption" color="text.secondary">
                          O CTO está analisando e estruturando o produto… (~30-90s)
                        </Typography>
                      )}
                    </Stack>

                    {generating && (
                      <Box sx={{ mt: 3, p: 2.5, bgcolor: "#6366F108", borderRadius: 1.5, border: "1px solid #6366F130" }}>
                        <Stack direction="row" spacing={2} alignItems="flex-start">
                          <CircularProgress size={22} sx={{ flexShrink: 0, mt: 0.25 }} />
                          <Box sx={{ flexGrow: 1 }}>
                            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.25 }}>
                              {genPhase === "queued"   && "Conectando ao CTO…"}
                              {genPhase === "thinking" && "CTO analisando o produto…"}
                              {genPhase === "writing"  && "CTO escrevendo a spec completa…"}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {genPhase === "queued"   && "Iniciando sessão com o agente CTO."}
                              {genPhase === "thinking" && "Identificando domínio, personas, requisitos funcionais e NFRs."}
                              {genPhase === "writing"  && "Estruturando FRs detalhados, modelo de dados, critérios de aceite e tokens visuais."}
                            </Typography>
                            {/* Phase progress bar */}
                            <Box sx={{ mt: 1.5, display: "flex", gap: 0.5 }}>
                              {(["queued","thinking","writing"] as const).map((p) => (
                                <Box key={p} sx={{
                                  height: 3, flex: 1, borderRadius: 2,
                                  bgcolor: p === genPhase ? "primary.main" :
                                    ["queued","thinking","writing"].indexOf(p) < ["queued","thinking","writing"].indexOf(genPhase) ? "success.main" : "divider",
                                  transition: "background-color 0.4s",
                                }} />
                              ))}
                            </Box>
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: "block" }}>
                              {genElapsed > 0 ? `${genElapsed}s — ` : ""}A spec completa pode levar 1-3 minutos.
                            </Typography>
                          </Box>
                        </Stack>
                      </Box>
                    )}
                  </motion.div>
                </AnimatePresence>
              )}

              {/* Spec gerada → mostrar editor */}
              {specMarkdown !== null && (
                <AnimatePresence mode="wait">
                  <motion.div key="editor" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <CheckCircleIcon sx={{ color: "success.main", fontSize: "1.1rem" }} />
                        <Typography variant="subtitle2" fontWeight={600}>Spec gerada pelo CTO</Typography>
                        <Chip label="Revise e edite antes de aprovar" size="small" color="warning" sx={{ fontSize: "0.65rem" }} />
                      </Stack>
                      <Button size="small" startIcon={<AutoFixHighIcon />} onClick={() => setSpecMarkdown(null)}>
                        Recomeçar
                      </Button>
                    </Stack>

                    {approveError && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setApproveError(null)}>{approveError}</Alert>}

                    {/* Editor inline (600px) */}
                    <Box sx={{ height: 600, border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
                      <SpecEditor
                        value={specMarkdown} onChange={setSpecMarkdown}
                        fullscreen={false} onToggleFullscreen={() => setEditorFullscreen(true)}
                        onSave={() => handleSaveSpec(false)} onSaveAndStart={() => handleSaveSpec(true)} approving={approving}
                        onRegen={() => setSpecMarkdown(null)}
                        regenDisabled={generating}
                      />
                    </Box>
                  </motion.div>
                </AnimatePresence>
              )}
            </Box>
          )}

          {/* ── Tab 1: Upload ────────────────────────────────────────────── */}
          {tab === 1 && (
            <Box>
              {result ? (
                <Alert severity="success">
                  {result.message}{" "}
                  <Box component="span" sx={{ cursor: "pointer", textDecoration: "underline" }}
                    onClick={() => router.push(`/projects/${result.projectId}`)}>
                    Ver projeto
                  </Box>
                </Alert>
              ) : (
                <form onSubmit={handleUploadSubmit}>
                  <TextField
                    fullWidth label="Título do projeto (opcional)"
                    value={projectTitle} onChange={(e) => setProjectTitle(e.target.value)}
                    size="small" sx={{ mb: 2 }} placeholder="Ex.: Auto Parts API"
                  />

                  <Box
                    onClick={() => inputRef.current?.click()}
                    sx={{
                      border: "2px dashed", borderColor: "divider", borderRadius: 1, p: 4,
                      textAlign: "center", cursor: "pointer", mb: 2,
                      "&:hover": { borderColor: "primary.main", bgcolor: "primary.main" + "08" },
                      transition: "all 0.15s",
                    }}
                  >
                    <UploadFileIcon sx={{ fontSize: "2.5rem", color: "text.secondary", mb: 1 }} />
                    <Typography variant="body2" fontWeight={500}>Clique para selecionar arquivos</Typography>
                    <Typography variant="caption" color="text.secondary">.md .txt .doc .docx .pdf — máx 10MB</Typography>
                    <input ref={inputRef} type="file" accept={ACCEPT} multiple hidden onChange={handleFileChange} />
                  </Box>

                  <AnimatePresence>
                    {files.map((f, i) => (
                      <motion.div key={f.name + i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1, p: 1, bgcolor: "action.hover", borderRadius: 1 }}>
                          <InsertDriveFileOutlinedIcon sx={{ color: "primary.main", flexShrink: 0 }} />
                          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                            <Typography variant="body2" noWrap fontWeight={500}>{f.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{formatFileSize(f.size)}</Typography>
                          </Box>
                          <IconButton size="small" onClick={() => removeFile(i)}><CloseIcon fontSize="small" /></IconButton>
                        </Stack>
                      </motion.div>
                    ))}
                  </AnimatePresence>

                  {uploadError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setUploadError(null)}>{uploadError}</Alert>}

                  <Divider sx={{ my: 2 }} />
                  <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Tooltip title="Guardar a ideia — iniciar quando quiser">
                      <span>
                        <Button variant="outlined" size="large"
                          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <span style={{ fontSize: "1rem" }}>💾</span>}
                          disabled={submitting || !files.length}
                          onClick={(e) => handleUploadSubmit(e as unknown as React.FormEvent, false)}>
                          {submitting ? "Salvando…" : "Salvar rascunho"}
                        </Button>
                      </span>
                    </Tooltip>
                    <Button type="submit" variant="contained" size="large"
                      startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <SendIcon />}
                      disabled={submitting || !files.length}
                      onClick={(e) => { e.preventDefault(); handleUploadSubmit(e as unknown as React.FormEvent, true); }}>
                      {submitting ? "Enviando…" : "Salvar e iniciar pipeline"}
                    </Button>
                  </Stack>
                </form>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {editorDialog}
    </Box>
  );
}
