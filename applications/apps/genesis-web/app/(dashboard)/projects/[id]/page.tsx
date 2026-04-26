"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { observer } from "mobx-react-lite";
import { motion } from "framer-motion";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import GitHubIcon from "@mui/icons-material/GitHub";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ReplayIcon from "@mui/icons-material/Replay";
import StopIcon from "@mui/icons-material/Stop";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ForumIcon from "@mui/icons-material/Forum";
import { projectsStore } from "@/stores/projectsStore";
import { LiveDialogue } from "@/components/LiveDialogue";
import { CodeExplorer } from "@/components/CodeExplorer";
import { getAgentProfile } from "@/lib/agentProfiles";
import { apiGet, apiPost } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";
import dynamic from "next/dynamic";

// Lazy-load GraphView (uses browser-only APIs)
const GraphView = dynamic(() => import("@/components/GraphView").then((m) => ({ default: m.GraphView })), {
  ssr: false,
  loading: () => (
    <Box sx={{ height: 480, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, border: "1px solid #30363D" }}>
      <Typography variant="body2" color="text.secondary">Carregando grafo…</Typography>
    </Box>
  ),
});

// ── Constants ─────────────────────────────────────────────────────────────────
const PIPELINE_STEPS = [
  { label: "Spec",     agent: "system" },
  { label: "Engineer", agent: "engineer" },
  { label: "CTO",      agent: "cto" },
  { label: "PM",       agent: "pm" },
  { label: "Dev/QA",   agent: "dev" },
  { label: "DevOps",   agent: "devops" },
  { label: "Pronto",   agent: "" },
];

const ALLOW_RUN_STATUS = new Set([
  "draft", "spec_submitted", "pending_conversion", "cto_charter", "pm_backlog", "stopped", "failed",
]);

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem         = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string; createdAt?: string; updatedAt?: string };
type ArtifactsResp    = { docs: Array<{ filename: string; creator?: string; title?: string; created_at?: string }>; projectDocsRoot: string | null };
type CodeFilesResp    = { files: Array<{ path: string; sizeBytes: number; ext: string }>; appsRoot: string | null; totalFiles: number };
type RunInfoResp      = { runCommand: string | null; appUrl: string | null; startShPath: string | null; projectType?: string; dockerComposeExists?: boolean; setupSteps?: string[] | null };
type GithubRepoResp   = { repo: { name: string; fullName: string; url: string; cloneUrl: string; branchUrls: { dev: string; staging: string; main: string }; pushedAt: string | null; shaDev: string | null } | null };
type EphemeralDeplResp = { deployment: { id: string; provider: string; appUrl: string; status: string; expiresAt: string; ttlMinutes: number } | null };
type EphemeralResult   = { deploymentId: string; provider: string; appUrl: string; expiresAt: string; ttlMinutes: number };
type MetricsResp      = { by_agent: Array<{ agent: string; calls: number; input_tokens: number; output_tokens: number }>; totals: { calls: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number } };

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function elapsedLabel(start?: string, end?: string): string {
  if (!start) return "";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const m  = Math.floor(ms / 60000);
  if (m < 60) return `${m}min`;
  const h  = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? ` ${m % 60}min` : ""}`;
}

function agentToStepIndex(from: string): number {
  const a = from.toLowerCase();
  if (a.includes("engineer"))         return 1;
  if (a === "cto")                    return 2;
  if (a === "pm" || a.startsWith("pm_")) return 3;
  if (a === "dev" || a.startsWith("dev_") || a === "qa" || a.startsWith("qa_") || a === "monitor") return 4;
  if (a === "devops" || a.startsWith("devops_")) return 5;
  return -1;
}

const TASK_STATUS_COLOR: Record<string, "success" | "info" | "error" | "warning" | "default"> = {
  DONE: "success", QA_PASS: "success", IN_PROGRESS: "info", WAITING_REVIEW: "info",
  QA_FAIL: "error", BLOCKED: "error", NEW: "default", ASSIGNED: "warning",
};

// ── Status chip helper ────────────────────────────────────────────────────────
function StatusChip({ status }: { status: string }) {
  const labels: Record<string, string> = {
    running: "Em execução", accepted: "Aceito", completed: "Concluído",
    failed: "Falhou", stopped: "Parado", draft: "Rascunho",
    spec_submitted: "Spec enviada", cto_charter: "Charter", pm_backlog: "Backlog",
  };
  const colors: Record<string, "default"|"success"|"error"|"info"|"warning"> = {
    completed: "success", accepted: "success", failed: "error", stopped: "error",
    running: "info", cto_charter: "warning", pm_backlog: "warning",
  };
  return (
    <Chip
      label={labels[status] ?? status}
      size="small"
      color={colors[status] ?? "default"}
      sx={{
        fontWeight: 600,
        ...(status === "running" && {
          "& .MuiChip-label": { pr: 2.5 },
          "&::after": {
            content: '""', position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            width: 6, height: 6, borderRadius: "50%", bgcolor: "info.main",
            animation: "pulse 1.4s infinite",
          },
          position: "relative",
          "@keyframes pulse": { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.3 } },
        }),
      }}
    />
  );
}

// ── Mini stat ─────────────────────────────────────────────────────────────────
function MiniStat({ label, value, color = "text.primary" }: { label: string; value: string | number; color?: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: "0.6rem" }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} color={color}>{value}</Typography>
    </Box>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
function ProjectDetailPageInner() {
  const params = useParams();
  const router = useRouter();
  const id     = params.id as string;

  // UI state
  const [triedLoad, setTriedLoad] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError]     = useState<string | null>(null);
  const [acceptLoading, setAcceptLoading] = useState(false);
  const [copiedCmd, setCopiedCmd]   = useState(false);
  const [rightTab, setRightTab]     = useState(0); // 0=Diálogo, 1=Grafo
  const [bottomTab, setBottomTab]   = useState(0); // 0=Tasks, 1=Artefatos, 2=Código

  // Working agent state (from dialogue)
  const [workingStepIndex, setWorkingStepIndex] = useState<number | null>(null);
  const [workingMessage, setWorkingMessage]       = useState<string | null>(null);

  // Data state
  const [tasks, setTasks]         = useState<TaskItem[] | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactsResp | null>(null);
  const [codeFiles, setCodeFiles] = useState<CodeFilesResp | null>(null);
  const [runInfo, setRunInfo]     = useState<RunInfoResp | null>(null);
  const [metrics, setMetrics]     = useState<MetricsResp | null>(null);
  const [githubRepo, setGithubRepo] = useState<GithubRepoResp["repo"] | null | undefined>(undefined);
  const [ephemeral, setEphemeral]   = useState<EphemeralResult | null>(null);
  const [deployLoading, setDeployLoading] = useState(false);
  const [deployError, setDeployError]     = useState<string | null>(null);
  const [countdown, setCountdown]   = useState<string>("");

  const project = projectsStore.getById(id);

  // ── Callbacks ──────────────────────────────────────────────────────────────
  const handleDialogueLoaded = useCallback((entries: DialogueEntry[]) => {
    const status = projectsStore.getById(id)?.status ?? "";
    const finished = status === "completed" || status === "accepted" || status === "failed" || status === "stopped";
    if (finished) { setWorkingStepIndex(null); setWorkingMessage(null); return; }
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    if (last?.eventType === "agent_working") {
      const step = agentToStepIndex(last.fromAgent);
      setWorkingStepIndex(step >= 0 ? step : null);
      setWorkingMessage(last.summaryHuman ?? null);
    } else {
      setWorkingStepIndex(null);
      setWorkingMessage(null);
    }
  }, [id]);

  // ── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    if (project) setTriedLoad(true);
    else projectsStore.loadProject(id).then(() => setTriedLoad(true));
  }, [id, project]);

  useEffect(() => {
    if (!id || project?.status !== "running") return;
    const t = setInterval(() => projectsStore.loadProject(id), 10000);
    return () => clearInterval(t);
  }, [id, project?.status]);

  useEffect(() => {
    if (!id || !project) return;
    const isActive = ["running", "completed", "accepted"].includes(project.status);
    if (!isActive) return;
    const load = () =>
      apiGet<TaskItem[]>(`/api/projects/${id}/tasks`)
        .then((d) => setTasks(Array.isArray(d) ? d : []))
        .catch(() => {});
    load();
    if (project.status !== "running") return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]);

  useEffect(() => {
    if (!id) return;
    apiGet<ArtifactsResp>(`/api/projects/${id}/artifacts`).then(setArtifacts).catch(() => null);
    apiGet<CodeFilesResp>(`/api/projects/${id}/code-files`).then(setCodeFiles).catch(() => null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]); // project intentionally excluded — status change is the trigger

  useEffect(() => {
    if (!id || !project) return;
    if (project.status === "completed" || project.status === "accepted") {
      apiGet<RunInfoResp>(`/api/projects/${id}/run-info`).then(setRunInfo).catch(() => null);
      apiGet<MetricsResp>(`/api/projects/${id}/metrics`).then(setMetrics).catch(() => null);
      apiGet<GithubRepoResp>(`/api/projects/${id}/github-repo`)
        .then((d) => setGithubRepo(d.repo))
        .catch(() => setGithubRepo(null));
      // Load active ephemeral deployment
      apiGet<EphemeralDeplResp>(`/api/projects/${id}/deploy/ephemeral/active`)
        .then((d) => {
          if (d.deployment && d.deployment.status === "running") {
            setEphemeral({
              deploymentId: d.deployment.id,
              provider: d.deployment.provider,
              appUrl: d.deployment.appUrl,
              expiresAt: d.deployment.expiresAt,
              ttlMinutes: d.deployment.ttlMinutes,
            });
          }
        })
        .catch(() => null);
    }
  }, [id, project?.status]);

  // Countdown timer for ephemeral deployment
  useEffect(() => {
    if (!ephemeral) return;
    const tick = () => {
      const remaining = new Date(ephemeral.expiresAt).getTime() - Date.now();
      if (remaining <= 0) { setCountdown("Expirado"); setEphemeral(null); return; }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${m}m ${String(s).padStart(2, "0")}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [ephemeral]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleRun = async () => {
    setRunError(null); setRunLoading(true);
    try {
      const d = await apiPost<{ ok: boolean; status?: string }>(`/api/projects/${id}/run`, {});
      if (d?.status === "running") projectsStore.setProjectStatus(id, "running");
      await projectsStore.loadProject(id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao iniciar");
    } finally {
      setRunLoading(false);
    }
  };

  const handleStop = async () => {
    setRunLoading(true);
    try {
      await apiPost(`/api/projects/${id}/stop`, {});
      await projectsStore.loadProject(id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao parar");
    } finally {
      setRunLoading(false);
    }
  };

  const handleAccept = async () => {
    setAcceptLoading(true);
    try {
      await apiPost(`/api/projects/${id}/accept`, {});
      await projectsStore.loadProject(id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao aceitar");
    } finally {
      setAcceptLoading(false);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  if (!project) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300 }}>
        {!triedLoad
          ? <CircularProgress size={24} />
          : (
            <Box textAlign="center">
              <Typography gutterBottom>Projeto não encontrado.</Typography>
              <Button startIcon={<ArrowBackIcon />} onClick={() => router.push("/projects")}>Voltar</Button>
            </Box>
          )}
      </Box>
    );
  }

  const isRunning   = project.status === "running";
  const isDone      = project.status === "completed" || project.status === "accepted";
  const canRun      = ALLOW_RUN_STATUS.has(project.status);
  const canAccept   = isRunning || project.status === "completed";
  const elapsed     = elapsedLabel(project.startedAt, project.completedAt);

  const stepFromStatus =
    project.status === "spec_submitted"  ? 1 :
    project.status === "cto_charter"     ? 2 :
    project.status === "pm_backlog"      ? 3 :
    project.status === "dev_qa"          ? 4 :
    project.status === "devops"          ? 5 :
    isDone                               ? 6 : 0;

  // Clear workingStep when done — prevents last agent_working event from keeping stepper spinning
  const activeStep = (isRunning && workingStepIndex != null) ? workingStepIndex : stepFromStatus;

  const tasksDone  = tasks ? tasks.filter((t) => t.status === "DONE" || t.status === "QA_PASS").length : 0;
  const tasksPct   = tasks && tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0;

  return (
    <Box sx={{ minHeight: "100%" }}>
      {/* ── Top header bar ── */}
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <IconButton size="small" onClick={() => router.push("/projects")}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h5" fontWeight={700} noWrap sx={{ flexGrow: 1 }}>
          {project.title ?? "Spec sem título"}
        </Typography>
        <StatusChip status={project.status} />

        {/* Action buttons */}
        {isRunning && (
          <Button variant="outlined" color="error" size="small" startIcon={<StopIcon />}
            disabled={runLoading} onClick={handleStop}>
            {runLoading ? "Parando…" : "Parar"}
          </Button>
        )}
        {canRun && !isRunning && (
          <Button variant="contained" size="small"
            startIcon={project.status === "stopped" || project.status === "failed" ? <ReplayIcon /> : <PlayArrowIcon />}
            disabled={runLoading} onClick={handleRun}>
            {runLoading ? "Iniciando…" : project.status === "stopped" || project.status === "failed" ? "Reiniciar" : "Iniciar"}
          </Button>
        )}
        {canAccept && (
          <Button variant="contained" color="success" size="small" startIcon={<CheckCircleIcon />}
            disabled={acceptLoading} onClick={handleAccept}>
            {acceptLoading ? "Aceitando…" : "Aceitar"}
          </Button>
        )}
      </Stack>

      {/* Error alert */}
      {runError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunError(null)}>{runError}</Alert>
      )}

      {/* Post-accept run banner */}
      {isDone && runInfo?.runCommand && (
        <Alert
          severity="success" sx={{ mb: 2 }} icon={<CheckCircleIcon />}
          action={runInfo.appUrl ? (
            <Button size="small" color="success" endIcon={<OpenInNewIcon />}
              href={runInfo.appUrl} target="_blank" rel="noopener noreferrer" component="a">
              {runInfo.projectType === "backend" ? "Swagger /docs" : "Abrir app"}
            </Button>
          ) : undefined}
        >
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>
            {runInfo.projectType === "backend" ? "API Backend — executar via Docker:" : "Pronto para executar:"}
          </Typography>
          {runInfo.setupSteps ? (
            <Box component="pre" sx={{ m: 0, p: 0.5, bgcolor: "action.hover", borderRadius: 0.5, fontSize: "0.72rem", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
              {runInfo.setupSteps.join("\n")}
            </Box>
          ) : (
            <Stack direction="row" spacing={1} alignItems="center">
              <Box component="code" sx={{ bgcolor: "action.hover", px: 1, py: 0.3, borderRadius: 0.5, fontSize: "0.78rem", flexGrow: 1 }}>
                {runInfo.runCommand}
              </Box>
              <Tooltip title="Copiar">
                <IconButton size="small" onClick={() => navigator.clipboard.writeText(runInfo.runCommand!).then(() => setCopiedCmd(true))}>
                  <ContentCopyIcon sx={{ fontSize: "0.9rem" }} />
                </IconButton>
              </Tooltip>
            </Stack>
          )}
        </Alert>
      )}
      <Snackbar open={copiedCmd} autoHideDuration={2000} onClose={() => setCopiedCmd(false)}
        message="Comando copiado!" anchorOrigin={{ vertical: "bottom", horizontal: "center" }} />

      {/* GitHub repo banner — shown once repo is created (after accept) */}
      {isDone && githubRepo && (
        <Alert
          severity="info" sx={{ mb: 2 }}
          icon={<GitHubIcon />}
          action={
            <Button size="small" endIcon={<OpenInNewIcon />}
              href={githubRepo.url} target="_blank" rel="noopener noreferrer" component="a">
              Ver no GitHub
            </Button>
          }
        >
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>
            🐙 Código publicado em <Box component="code" sx={{ bgcolor: "action.hover", px: 0.75, borderRadius: 0.5, fontSize: "0.78rem" }}>{githubRepo.fullName}</Box>
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {(["dev","staging","main"] as const).map((b) => (
              <Button key={b} size="small" variant="outlined" startIcon={<CallSplitIcon sx={{ fontSize: "0.8rem !important" }} />}
                href={githubRepo.branchUrls[b]} target="_blank" rel="noopener noreferrer" component="a"
                sx={{ fontSize: "0.7rem", py: 0.3, px: 0.75 }}>
                {b}
              </Button>
            ))}
          </Stack>
        </Alert>
      )}
      {/* Repo still being created (githubRepo===undefined means not loaded yet, null means no repo) */}
      {isDone && githubRepo === null && (
        <Alert severity="info" sx={{ mb: 2 }} icon={<GitHubIcon />}>
          <Typography variant="body2" color="text.secondary">
            Repositório GitHub será criado automaticamente se o tenant tiver o GitHub App instalado.
          </Typography>
        </Alert>
      )}

      {/* Cloud deploy — active deployment banner */}
      {isDone && ephemeral && (
        <Alert
          severity="warning" sx={{ mb: 2 }}
          icon={<Box sx={{ fontSize: "1.1rem" }}>☁️</Box>}
          action={
            <Stack direction="row" spacing={1} alignItems="center">
              <Button size="small" color="warning" endIcon={<OpenInNewIcon />}
                href={ephemeral.appUrl} target="_blank" rel="noopener noreferrer" component="a">
                Abrir app
              </Button>
              <Button size="small" color="error" variant="outlined"
                onClick={async () => {
                  await apiPost(`/api/projects/${id}/deploy/ephemeral/${ephemeral.deploymentId}/destroy`, {}).catch(() => null);
                  setEphemeral(null);
                }}>
                Destruir
              </Button>
            </Stack>
          }
        >
          <Typography variant="body2" fontWeight={500}>
            ☁️ Ambiente efêmero ativo · expira em{" "}
            <Box component="span" sx={{ fontFamily: "monospace", color: "warning.main", fontWeight: 700 }}>{countdown}</Box>
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {ephemeral.provider === "fly" ? "Fly.io" : "AWS ECS"} · {ephemeral.appUrl}
          </Typography>
        </Alert>
      )}

      {/* Cloud deploy — launch button */}
      {isDone && !ephemeral && (
        <Box sx={{ mb: 2 }}>
          {deployError && (
            <Alert severity="error" sx={{ mb: 1 }} onClose={() => setDeployError(null)}>{deployError}</Alert>
          )}
          <Button
            variant="outlined" size="small"
            disabled={deployLoading}
            startIcon={deployLoading ? <CircularProgress size={14} /> : <Box sx={{ fontSize: "0.9rem" }}>☁️</Box>}
            onClick={async () => {
              setDeployLoading(true); setDeployError(null);
              try {
                const result = await apiPost<EphemeralResult>(`/api/projects/${id}/deploy/ephemeral`, { ttlMinutes: 30 });
                setEphemeral(result);
              } catch (e) {
                setDeployError(e instanceof Error ? e.message : "Falha ao provisionar ambiente cloud");
              } finally {
                setDeployLoading(false);
              }
            }}
            sx={{ borderStyle: "dashed" }}
          >
            {deployLoading ? "Provisionando ambiente cloud…" : "🚀 Testar em Cloud (30 min)"}
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, fontSize: "0.65rem" }}>
            Ambiente efêmero — dados destruídos automaticamente. Requer FLY_API_TOKEN configurado.
          </Typography>
        </Box>
      )}

      {/* ── Main cockpit layout ── */}
      <Grid container spacing={2}>
        {/* ── LEFT COLUMN: Pipeline status + metrics + tasks ── */}
        <Grid size={{ xs: 12, md: 3.5 }}>
          <Stack spacing={2}>
            {/* Pipeline stepper vertical */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Typography variant="caption" color="text.secondary"
                  sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5 }}>
                  Pipeline
                </Typography>

                {/* Progress bar */}
                {tasks && tasks.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <LinearProgress
                      variant="determinate" value={tasksPct}
                      color={isDone ? "success" : "primary"}
                      sx={{ height: 5, borderRadius: 3, bgcolor: "divider", mb: 0.5 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {tasksDone}/{tasks.length} tasks · {tasksPct}%
                    </Typography>
                  </Box>
                )}

                {/* Steps */}
                <Stack spacing={0}>
                  {PIPELINE_STEPS.map((step, i) => {
                    const isDoneStep    = i < activeStep;
                    const isActiveStep  = i === activeStep;
                    const isFutureStep  = i > activeStep;
                    return (
                      <Box key={step.label} sx={{ display: "flex", alignItems: "flex-start", gap: 1, pb: i < PIPELINE_STEPS.length - 1 ? 0.5 : 0 }}>
                        {/* Dot + line */}
                        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16, pt: 0.25 }}>
                          <Box sx={{
                            width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                            bgcolor: isDoneStep ? "success.main" : isActiveStep ? "primary.main" : "divider",
                            border: isActiveStep ? "2px solid" : "1px solid",
                            borderColor: isActiveStep ? "primary.main" : isDoneStep ? "success.main" : "divider",
                            ...(isActiveStep && {
                              boxShadow: "0 0 0 3px #6366F130",
                              animation: "dot-pulse 1.4s infinite",
                              "@keyframes dot-pulse": { "0%,100%": { boxShadow: "0 0 0 3px #6366F130" }, "50%": { boxShadow: "0 0 0 6px #6366F115" } },
                            }),
                          }} />
                          {i < PIPELINE_STEPS.length - 1 && (
                            <Box sx={{ width: 1, flexGrow: 1, minHeight: 12, bgcolor: isDoneStep ? "success.main" : "divider", opacity: 0.4 }} />
                          )}
                        </Box>
                        {/* Label */}
                        <Box sx={{ pb: 0.75, minWidth: 0 }}>
                          <Typography
                            variant="body2"
                            fontWeight={isActiveStep ? 600 : 400}
                            color={isDoneStep ? "success.main" : isActiveStep ? "primary.main" : isFutureStep ? "text.disabled" : "text.primary"}
                            sx={{ lineHeight: 1.5 }}
                          >
                            {step.label}
                            {isActiveStep && isRunning && (
                              <CircularProgress size={10} color="primary" sx={{ ml: 0.75, verticalAlign: "middle" }} />
                            )}
                          </Typography>
                          {isActiveStep && workingMessage && (
                            <Typography variant="caption" color="text.secondary"
                              sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                              {workingMessage.slice(0, 60)}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    );
                  })}
                </Stack>
              </CardContent>
            </Card>

            {/* Quick metrics */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Typography variant="caption" color="text.secondary"
                  sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5 }}>
                  Métricas
                </Typography>
                <Stack spacing={1.25}>
                  {elapsed && <MiniStat label="Tempo" value={elapsed} />}
                  {project.startedAt && <MiniStat label="Início" value={fmtTime(project.startedAt)} />}
                  {tasks && tasks.length > 0 && <MiniStat label="Tasks" value={`${tasksDone}/${tasks.length}`} />}
                  {codeFiles && codeFiles.totalFiles > 0 && <MiniStat label="Arquivos gerados" value={codeFiles.totalFiles} />}
                  {metrics && metrics.totals.calls > 0 && (
                    <>
                      <MiniStat label="Tokens" value={(metrics.totals.input_tokens + metrics.totals.output_tokens).toLocaleString("pt-BR")} />
                      <MiniStat label="Custo est." value={`~$${metrics.totals.estimated_cost_usd.toFixed(2)}`} color="success.main" />
                    </>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* Charter summary */}
            {project.charterSummary && (
              <Card>
                <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 0.75 }}>
                    Charter (CTO)
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
                    {project.charterSummary.slice(0, 200)}{project.charterSummary.length > 200 ? "…" : ""}
                  </Typography>
                </CardContent>
              </Card>
            )}
          </Stack>
        </Grid>

        {/* ── RIGHT COLUMN: Dialogue + Graph ── */}
        <Grid size={{ xs: 12, md: 8.5 }}>
          <Card sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Tabs: Diálogo | Grafo */}
            <Tabs
              value={rightTab}
              onChange={(_e, v) => setRightTab(v as number)}
              sx={{ px: 2, borderBottom: "1px solid", borderColor: "divider", minHeight: 44 }}
            >
              <Tab
                icon={<ForumIcon sx={{ fontSize: "0.9rem" }} />}
                iconPosition="start"
                label="Diálogo ao vivo"
                sx={{ minHeight: 44, textTransform: "none", fontWeight: 500, fontSize: "0.82rem", gap: 0.75 }}
              />
              <Tab
                icon={<AccountTreeIcon sx={{ fontSize: "0.9rem" }} />}
                iconPosition="start"
                label="Grafo Obsidian"
                sx={{ minHeight: 44, textTransform: "none", fontWeight: 500, fontSize: "0.82rem", gap: 0.75 }}
              />
            </Tabs>

            {/* Tab 0 — Diálogo */}
            {rightTab === 0 && (
              <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
                {isRunning && workingMessage && (
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider", bgcolor: "primary.main" + "12" }}>
                    <CircularProgress size={12} color="primary" />
                    <Typography variant="caption" color="primary.main" fontWeight={500} noWrap>
                      {workingMessage.slice(0, 80)}
                    </Typography>
                  </Stack>
                )}
                <LiveDialogue
                  projectId={id}
                  pollIntervalMs={isRunning ? 4000 : 15000}
                  onEntriesLoaded={handleDialogueLoaded}
                  maxHeight={500}
                />
              </Box>
            )}

            {/* Tab 1 — Grafo */}
            {rightTab === 1 && (
              <Box sx={{ p: 1.5, flexGrow: 1 }}>
                <GraphView
                  projectId={id}
                  pollIntervalMs={isRunning ? 6000 : 0}
                  height={500}
                />
              </Box>
            )}
          </Card>
        </Grid>
      </Grid>

      {/* ── Bottom section: Tasks + Artifacts + Code ── */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}
      >
        <Card sx={{ mt: 2 }}>
          <Tabs
            value={bottomTab}
            onChange={(_e, v) => setBottomTab(v as number)}
            sx={{ px: 2, borderBottom: "1px solid", borderColor: "divider", minHeight: 44 }}
          >
            <Tab label={tasks && tasks.length > 0 ? `Tasks (${tasksDone}/${tasks.length})` : "Tasks"}
              sx={{ minHeight: 44, textTransform: "none", fontSize: "0.82rem" }} />
            <Tab label={artifacts?.docs && artifacts.docs.length > 0 ? `Documentos (${artifacts.docs.length})` : "Documentos"}
              sx={{ minHeight: 44, textTransform: "none", fontSize: "0.82rem" }} />
            <Tab label={codeFiles && codeFiles.totalFiles > 0 ? `Código (${codeFiles.totalFiles})` : "Código"}
              sx={{ minHeight: 44, textTransform: "none", fontSize: "0.82rem" }} />
          </Tabs>

          {/* Tasks */}
          {bottomTab === 0 && (
            <Box sx={{ p: 0 }}>
              {isRunning && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 2, pt: 1 }}>
                  Atualização automática a cada 8s
                </Typography>
              )}
              {!tasks || tasks.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3 }}>
                  {isRunning ? "Aguardando CTO → Engineer → PM para gerar tasks…" : "Nenhuma task registrada."}
                </Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Task</TableCell>
                      <TableCell sx={{ minWidth: 200 }}>Descrição</TableCell>
                      <TableCell sx={{ width: 120 }}>Status</TableCell>
                      <TableCell sx={{ width: 90 }}>Módulo</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tasks.map((t) => {
                      const isDoneT  = t.status === "DONE" || t.status === "QA_PASS";
                      const isActiveT = t.status === "IN_PROGRESS" || t.status === "WAITING_REVIEW";
                      return (
                        <TableRow key={t.id}
                          sx={{ bgcolor: isActiveT ? "primary.main" + "08" : isDoneT ? "success.main" + "06" : "transparent" }}>
                          <TableCell>
                            <Typography variant="caption" fontFamily="monospace">{t.taskId}</Typography>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.75} alignItems="center">
                              {isActiveT && <CircularProgress size={10} color="primary" />}
                              <Typography variant="body2" sx={{ fontSize: "0.78rem" }}>{t.requirements ?? "—"}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell>
                            <Chip size="small" label={t.status ?? "—"}
                              color={TASK_STATUS_COLOR[t.status ?? ""] ?? "default"}
                              sx={{ fontFamily: "monospace", fontSize: "0.62rem" }} />
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary">{t.module ?? t.ownerRole ?? "—"}</Typography>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Box>
          )}

          {/* Documents */}
          {bottomTab === 1 && (
            <Box sx={{ p: 2 }}>
              {(!artifacts || !artifacts.docs?.length) ? (
                <Typography variant="body2" color="text.secondary">Documentos gerados pelos agentes aparecerão aqui.</Typography>
              ) : (
                <>
                  {artifacts.projectDocsRoot && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
                      <Box component="code" sx={{ bgcolor: "action.hover", px: 0.5, borderRadius: 0.5 }}>{artifacts.projectDocsRoot}</Box>
                    </Typography>
                  )}
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Arquivo</TableCell>
                        <TableCell sx={{ width: 110 }}>Agente</TableCell>
                        <TableCell sx={{ width: 140 }}>Data</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {artifacts.docs.map((d, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <Typography variant="body2">{d.title ?? d.filename}</Typography>
                            {d.title && d.filename !== d.title && (
                              <Typography variant="caption" color="text.secondary" fontFamily="monospace">{d.filename}</Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            {(() => {
                              const profile = d.creator ? getAgentProfile(d.creator) : null;
                              return (
                                <Chip
                                  size="small"
                                  label={profile?.name ?? d.creator ?? "—"}
                                  sx={{
                                    fontSize: "0.62rem",
                                    bgcolor: profile ? `${profile.color}22` : undefined,
                                    color: profile?.color,
                                    border: `1px solid ${profile?.color ?? "#30363D"}44`,
                                  }}
                                />
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary">
                              {d.created_at ? new Date(d.created_at).toLocaleString("pt-BR") : "—"}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </Box>
          )}

          {/* Code files — VS Code style explorer */}
          {bottomTab === 2 && (
            <Box sx={{ p: 0 }}>
              {(!codeFiles || codeFiles.totalFiles === 0) ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  Arquivos de código gerados pelo Dev aparecerão aqui.
                </Typography>
              ) : (
                <CodeExplorer
                  projectId={id}
                  files={codeFiles.files}
                  appsRoot={codeFiles.appsRoot}
                  height={540}
                />
              )}
            </Box>
          )}
        </Card>
      </motion.div>
    </Box>
  );
}

export default observer(ProjectDetailPageInner);
