"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { observer } from "mobx-react-lite";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
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
import Collapse from "@mui/material/Collapse";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CancelIcon from "@mui/icons-material/Cancel";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GitHubIcon from "@mui/icons-material/GitHub";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ReplayIcon from "@mui/icons-material/Replay";
import StopIcon from "@mui/icons-material/Stop";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import AddLinkIcon from "@mui/icons-material/AddLink";
import BoltIcon from "@mui/icons-material/Bolt";
import ForumIcon from "@mui/icons-material/Forum";
import { projectsStore } from "@/stores/projectsStore";
import { LiveDialogue } from "@/components/LiveDialogue";
import { CodeExplorer } from "@/components/CodeExplorer";
import { DocViewerModal } from "@/components/DocViewerModal";
import { getAgentProfile } from "@/lib/agentProfiles";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";
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

// ── Pipeline phases (ordem real de execução) ──────────────────────────────────
// Fase 0: Spec recebida
// Fase 1: CTO analisa e itera com Engineer (1-3 rounds) → gera Charter
// Fase 2: PM quebra charter em tasks (backlog)
// Fase 3: Monitor Loop — Dev implementa task por task, QA valida cada uma
// Fase 4: DevOps — Dockerfile, docker-compose, CI/CD
// Fase 5: Cyborg — validação autônoma E2E
// Fase 6: Aceito
const PIPELINE_STEPS = [
  { label: "Spec",          agent: "system",   desc: "Especificação recebida e preparada" },
  { label: "CTO + Engineer", agent: "cto",     desc: "Charter técnico e arquitetura" },
  { label: "PM",             agent: "pm",      desc: "Backlog de tasks" },
  { label: "Dev + QA",       agent: "dev",     desc: "Implementação task a task" },
  { label: "DevOps",         agent: "devops",  desc: "Docker, CI/CD e deploy" },
  { label: "Cyborg",         agent: "monitor", desc: "Validação autônoma E2E" },
  { label: "Aceito",         agent: "",        desc: "Produto entregue" },
];

const ALLOW_RUN_STATUS = new Set([
  "draft", "spec_submitted", "pending_conversion", "cto_charter", "pm_backlog", "stopped", "failed",
]);

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem         = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string; createdAt?: string; updatedAt?: string };
type TaskMetricItem   = { taskId: string; calls: number; inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number; agents: string[]; models: string[]; estimatedCostUsd: number; lastCallAt?: string };
type TaskLogRow       = { id: string; agent: string; taskId: string; round: number; inputTokens: number; outputTokens: number; totalTokens: number; model: string | null; isOpus: boolean; durationMs: number; durationSec: number; status: string | null; estimatedCostUsd: number; createdAt: string };
type TaskLogResp      = { rows: TaskLogRow[]; totals: { calls: number; tokens: number; costUsd: number; durationSec: number } };
type ArtifactsResp    = { docs: Array<{ filename: string; creator?: string; title?: string; created_at?: string }>; projectDocsRoot: string | null };
type CodeFilesResp    = { files: Array<{ path: string; sizeBytes: number; ext: string }>; appsRoot: string | null; totalFiles: number };
type RunInfoResp      = { runCommand: string | null; appUrl: string | null; startShPath: string | null; projectType?: string; dockerComposeExists?: boolean; setupSteps?: string[] | null };
type GithubRepoResp   = { repo: { name: string; fullName: string; url: string; cloneUrl: string; branchUrls: { dev: string; staging: string; main: string }; pushedAt: string | null; shaDev: string | null } | null };
type VersionEntry     = { id: string; title: string; status: string; versionNumber: number; createdAt: string; completedAt: string | null; isCurrent: boolean };
type VersionsResp     = { versions: VersionEntry[]; rootId: string; currentId: string };
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
  // Fase 1: CTO e Engineer fazem rounds juntos
  if (a === "cto" || a.includes("engineer")) return 1;
  // Fase 2: PM gera backlog
  if (a === "pm" || a.startsWith("pm_"))     return 2;
  // Fase 3: Dev, QA e Monitor orquestram as tasks
  if (a === "dev" || a.startsWith("dev_") || a === "qa" || a.startsWith("qa_") || a === "monitor" || a.startsWith("monitor_")) return 3;
  // Fase 4: DevOps
  if (a === "devops" || a.startsWith("devops_")) return 4;
  // Fase 5: Cyborg/Cyborg-like
  if (a.includes("cyborg")) return 5;
  return -1;
}

const PROJECT_TYPE_LABELS: Record<string, string> = {
  backend_api:"🔌 API REST", backend_graphql:"🔗 GraphQL", backend_grpc:"⚡ gRPC",
  backend_websocket:"🌐 WebSocket / Realtime", backend_serverless:"☁️ Serverless",
  backend_microservice:"🔧 Microsserviço", backend_worker:"🤖 Worker / Job",
  backend_data_pipeline:"🔄 Pipeline de Dados", backend_event_driven:"📨 Event-Driven",
  backend_auth_service:"🔐 Auth / IAM", backend_notification:"🔔 Notificações",
  backend_file_storage:"📂 Armazenamento", backend_search:"🔍 Busca / Indexação",
  backend_payment:"💳 Pagamentos", backend_cms_api:"📝 CMS Headless",
  backend_analytics_api:"📊 Analytics API", backend_ai_ml:"🧠 IA / ML / LLM",
  frontend_webapp:"🎨 Web App (SPA)", frontend_pwa:"📱 PWA",
  frontend_landing:"🏠 Landing Page", frontend_institutional:"🏢 Site Institucional",
  frontend_blog:"📰 Blog / Portal", frontend_ecommerce:"🛒 E-commerce Frontend",
  frontend_dashboard:"📊 Dashboard / Admin", frontend_design_system:"🎨 Design System",
  fullstack_webapp:"🖥️ Fullstack Web App", fullstack_saas:"☁️ SaaS",
  fullstack_ecommerce:"🛒 E-commerce Completo", fullstack_erp:"🏢 ERP",
  fullstack_marketplace:"🏪 Marketplace", fullstack_crm:"👥 CRM",
  fullstack_lms:"🎓 EAD / LMS", fullstack_fintech:"💰 Fintech",
  fullstack_healthtech:"🏥 Healthtech", fullstack_proptech:"🏠 Proptech",
  mobile_crossplatform:"📱 Mobile Multiplataforma", mobile_ios:"🍎 iOS Nativo",
  mobile_android:"🤖 Android Nativo",
  infra_iac:"🏗️ IaC / Infra", infra_cicd:"🔄 CI/CD",
  infra_monitoring:"📡 Observabilidade", infra_data_lake:"🗄️ Data Lake",
  bot_chat:"🤖 Chatbot", bot_scraper:"🕷️ Scraper / Crawler",
  bot_automation:"⚙️ Automação / RPA", integration:"🔌 Integração de APIs",
  lib_sdk:"📦 SDK / Biblioteca", lib_cli:"⌨️ CLI", lib_plugin:"🔧 Plugin",
  other:"📦 Outro",
};

const TASK_STATUS_COLOR: Record<string, "success" | "info" | "error" | "warning" | "default"> = {
  DONE: "success", QA_PASS: "success", IN_PROGRESS: "info", WAITING_REVIEW: "info",
  QA_FAIL: "error", BLOCKED: "error", NEW: "default", ASSIGNED: "warning",
};

// ── LLM model badge ───────────────────────────────────────────────────────────
function ModelBadge({ model }: { model: string | null | undefined }) {
  if (!model) return null;
  const name = model.toLowerCase();
  const label = name.includes("opus")    ? "Opus"
              : name.includes("sonnet")  ? "Sonnet"
              : name.includes("haiku")   ? "Haiku"
              : name.includes("gpt-4.1") ? "GPT-4.1"
              : name.includes("gpt-4o")  ? "GPT-4o"
              : name.includes("gpt-4")   ? "GPT-4"
              : name.includes("o3")      ? "o3"
              : name.includes("o1")      ? "o1"
              : model.split(/[-/]/)[0].toUpperCase(); // fallback: primeiro segmento
  const color = name.includes("opus")               ? "#f59e0b"
              : name.includes("sonnet")              ? "#6366f1"
              : name.includes("gpt") || name.includes("o3") || name.includes("o1") ? "#10b981"
              : "#8B949E";
  return (
    <Chip
      label={label}
      size="small"
      sx={{
        fontSize: "0.6rem", height: 20, fontWeight: 700,
        bgcolor: `${color}18`, color, border: `1px solid ${color}40`,
      }}
    />
  );
}

// ── Cyborg Log Card ───────────────────────────────────────────────────────────
function CyborgLogCard({ projectId, cyborgAttempts }: { projectId: string; cyborgAttempts: number }) {
  const [logs, setLogs] = useState<{ id: string; attempt: number; message: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const fetchLogs = async () => {
      try {
        const data = await apiGet<{ logs: { id: string; attempt: number; message: string; created_at: string }[] }>(
          `/api/projects/${projectId}/cyborg-logs`
        );
        if (active) setLogs(data.logs ?? []);
      } catch { /* silencioso */ } finally {
        if (active) setLoading(false);
      }
    };
    fetchLogs();
    // Poll a cada 15s enquanto pending_cyborg
    const interval = setInterval(fetchLogs, 15000);
    return () => { active = false; clearInterval(interval); };
  }, [projectId]);

  const attempt = cyborgAttempts + 1;

  return (
    <Card variant="outlined" sx={{ mb: 2, borderColor: "warning.main", borderWidth: 2 }}>
      <CardContent sx={{ pb: "12px !important" }}>
        <Stack direction="row" alignItems="center" spacing={1} mb={1}>
          <span style={{ fontSize: "1.2rem" }}>🤖</span>
          <Typography variant="subtitle2" fontWeight={700}>Cyborg — Validação em andamento</Typography>
          <Chip label={`Tentativa ${attempt}/5`} size="small" color="warning" sx={{ ml: "auto" }} />
          <CircularProgress size={16} thickness={5} color="warning" />
        </Stack>
        <Typography variant="caption" color="text.secondary" display="block" mb={1}>
          O Cyborg está testando, corrigindo e validando o projeto no host. Aguarde o resultado.
        </Typography>
        {loading && <LinearProgress color="warning" sx={{ borderRadius: 1 }} />}
        {logs.length > 0 && (
          <Box sx={{
            maxHeight: 200, overflowY: "auto", mt: 1,
            bgcolor: "grey.900", borderRadius: 1, p: 1,
          }}>
            {logs.map(l => (
              <Typography key={l.id} variant="caption" display="block" sx={{ color: "grey.300", fontFamily: "monospace", lineHeight: 1.6 }}>
                <span style={{ color: "#888", marginRight: 8 }}>
                  {new Date(l.created_at).toLocaleTimeString("pt-BR")}
                </span>
                {l.message}
              </Typography>
            ))}
          </Box>
        )}
        {!loading && logs.length === 0 && (
          <Typography variant="caption" color="text.secondary">Aguardando primeiros logs do Cyborg...</Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Status chip helper ────────────────────────────────────────────────────────
function StatusChip({ status, model }: { status: string; model?: string | null }) {
  const labels: Record<string, string> = {
    running: "Em execução", accepted: "Aceito", completed: "Concluído",
    failed: "Falhou", stopped: "Parado", draft: "Rascunho",
    spec_submitted: "Spec enviada", cto_charter: "Charter", pm_backlog: "Backlog",
    pending_cyborg: "Validando (Cyborg)", blocked_cyborg: "Bloqueado (Cyborg)",
  };
  const colors: Record<string, "default"|"success"|"error"|"info"|"warning"> = {
    completed: "success", accepted: "success", failed: "error", stopped: "error",
    running: "info", cto_charter: "warning", pm_backlog: "warning",
    pending_cyborg: "warning", blocked_cyborg: "error",
  };
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
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
      {status === "running" && <ModelBadge model={model} />}
    </Stack>
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
  const [evolveOpen, setEvolveOpen]       = useState(false);
  const [evolveRequest, setEvolveRequest] = useState("");
  const [evolveWorkMode, setEvolveWorkMode] = useState<"copy" | "branch">("copy");
  const [evolveLoading, setEvolveLoading] = useState(false);
  const [copiedCmd, setCopiedCmd]   = useState(false);
  const [tasksOpen, setTasksOpen]   = useState(true);
  // Tab routing: centerTabs = tabs shown in center panel; rightTabs = tabs shown in right panel (alongside Tasks)
  // All 4 tabs: 0=Diálogo, 1=Grafo, 2=Documentos, 3=Código
  const [centerTabs, setCenterTabs] = useState<number[]>([0, 1, 2, 3]);
  const [rightTabs, setRightTabs]   = useState<number[]>([]);
  const [centerTab, setCenterTab]   = useState(0);   // active tab index within centerTabs
  // rightActiveTab: -1 = Tasks, 0..N = rightTabs index
  const [rightActiveTab, setRightActiveTab] = useState<number>(-1);
  // Column widths (percentages) — draggable
  const [colWidths, setColWidths]   = useState({ left: 25, center: 42, right: 33 });
  const dragRef = useRef<{ col: "lc" | "cr"; startX: number; startLeft: number; startCenter: number; startRight: number } | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  // Doc viewer modal
  const [docModal, setDocModal]     = useState<{ filename: string; title: string } | null>(null);

  const TAB_LABELS = [
    "Diálogo ao vivo", "Grafo", "Documentos", "Código",
  ] as const;
  const TAB_ICONS = [
    <ForumIcon key={0} sx={{ fontSize: "0.9rem" }} />,
    <AccountTreeIcon key={1} sx={{ fontSize: "0.9rem" }} />,
    null, null,
  ];

  const moveTabToRight = (tabId: number) => {
    setCenterTabs(prev => {
      const next = prev.filter(t => t !== tabId);
      setCenterTab(i => Math.min(i, Math.max(next.length - 1, 0)));
      return next;
    });
    setRightTabs(prev => {
      if (prev.includes(tabId)) return prev;
      const next = [...prev, tabId];
      setRightActiveTab(next.length - 1); // activate newly added tab
      return next;
    });
    setTasksOpen(true);
  };

  const moveTabToCenter = (tabId: number) => {
    setRightTabs(prev => {
      const next = prev.filter(t => t !== tabId);
      setRightActiveTab(next.length === 0 ? -1 : Math.max(0, Math.min(next.length - 1, 0)));
      return next;
    });
    setCenterTabs(prev => {
      const all = [0, 1, 2, 3];
      return all.filter(t => prev.includes(t) || t === tabId);
    });
  };

  // Working agent state (from dialogue)
  const [workingStepIndex, setWorkingStepIndex] = useState<number | null>(null);
  const [workingMessage, setWorkingMessage]       = useState<string | null>(null);

  // FT-06: estado de collapse dos cards — persistido no localStorage por projeto
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(`cardCollapse_${id}`) ?? "{}"); } catch { return {}; }
  });
  const toggleCollapse = (key: string) => setCollapsed(prev => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(`cardCollapse_${id}`, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // Data state
  const [tasks, setTasks]         = useState<TaskItem[] | null>(null);
  const [taskMetrics, setTaskMetrics] = useState<Record<string, TaskMetricItem>>({});
  const [taskLogs, setTaskLogs]       = useState<TaskLogResp | null>(null);
  const [logsExpanded, setLogsExpanded] = useState<string | null>(null); // taskId expandida
  // Ticker para tempo real nas métricas (atualiza a cada 30s)
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [artifacts, setArtifacts] = useState<ArtifactsResp | null>(null);
  const [codeFiles, setCodeFiles] = useState<CodeFilesResp | null>(null);
  const [runInfo, setRunInfo]     = useState<RunInfoResp | null>(null);
  const [metrics, setMetrics]     = useState<MetricsResp | null>(null);
  const [githubRepo, setGithubRepo] = useState<GithubRepoResp["repo"] | null | undefined>(undefined);
  const [ephemeral, setEphemeral]   = useState<EphemeralResult | null>(null);
  const [versions, setVersions]     = useState<VersionEntry[]>([]);
  const [links, setLinks]           = useState<import("@/types").ProjectLink[]>([]);
  const [product, setProduct]       = useState<{ id: string; name: string; projects?: Array<{ id: string; title: string; status: string; project_type?: string; complexity_hint?: string }> } | null>(null);
  const [triggers, setTriggers]     = useState<Array<{ id: string; trigger_project_id: string; trigger_project_title: string; trigger_project_status: string; trigger_status: string }>>([]);
  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false);
  const [triggerProjectId, setTriggerProjectId]   = useState("");
  const [triggerStatus, setTriggerStatus]         = useState("accepted");
  const [triggerSaving, setTriggerSaving]         = useState(false);
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [allProducts, setAllProducts]             = useState<Array<{ id: string; name: string }>>([]);
  const [linkProductId, setLinkProductId]         = useState("");
  const [linkProductSaving, setLinkProductSaving] = useState(false);
  const [deployLoading, setDeployLoading] = useState(false);
  const [deployError, setDeployError]     = useState<string | null>(null);
  const [countdown, setCountdown]   = useState<string>("");
  const [linkDialogOpen, setLinkDialogOpen]     = useState(false);
  const [linkableProjects, setLinkableProjects] = useState<Array<{ id: string; title: string; status: string; project_type?: string }>>([]);
  const [linkTargetId, setLinkTargetId]         = useState("");
  const [linkRelationType, setLinkRelationType] = useState("uses_backend");
  const [linkSaving, setLinkSaving]             = useState(false);
  const [linkError, setLinkError]               = useState<string | null>(null);

  const project = projectsStore.getById(id);

  // ── Callbacks ──────────────────────────────────────────────────────────────
  const handleDialogueLoaded = useCallback((entries: DialogueEntry[]) => {
    const status = projectsStore.getById(id)?.status ?? "";
    const finished = status === "completed" || status === "accepted" || status === "failed" || status === "stopped" || status === "pending_cyborg" || status === "blocked_cyborg";
    if (finished) { setWorkingStepIndex(null); setWorkingMessage(null); return; }
    // Se há product_ready no diálogo, o pipeline terminou — stepper vai para "Pronto" (step 6)
    // independente de qualquer agent_working posterior (ex.: FULL-TEST que roda dev/qa após DevOps)
    const hasProductReady = entries.some(e => e.eventType === "product_ready");
    if (hasProductReady) {
      setWorkingStepIndex(6);  // índice de "Pronto"
      setWorkingMessage("Aguardando aceite");
      return;
    }
    // Procurar o último agent_working em vez de apenas o último evento.
    // Sem isso, eventos como task.completed ou step (que vêm depois) zeram workingStepIndex
    // e o portal recai no stepFromStatus=0 ("Spec") para status="running".
    const lastWorking = [...entries].reverse().find(e => e.eventType === "agent_working");
    if (lastWorking) {
      const step = agentToStepIndex(lastWorking.fromAgent);
      setWorkingStepIndex(step >= 0 ? step : null);
      setWorkingMessage(lastWorking.summaryHuman ?? null);
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
    const t = setInterval(() => {
      projectsStore.loadProject(id);
      setNowTick(Date.now()); // atualiza ticker para tempo real em Métricas
    }, 10000);
    return () => clearInterval(t);
  }, [id, project?.status]);

  useEffect(() => {
    if (!id || !project) return;
    const isActive = ["running", "completed", "accepted", "stopped", "failed", "pending_cyborg", "blocked_cyborg"].includes(project.status);
    if (!isActive) return;
    const loadMetrics = () =>
      apiGet<TaskMetricItem[]>(`/api/projects/${id}/task-metrics`)
        .then((d) => {
          const map: Record<string, TaskMetricItem> = {};
          d.forEach((m) => { map[m.taskId] = m; });
          setTaskMetrics(map);
        })
        .catch(() => {});
    const loadLogs = () =>
      apiGet<TaskLogResp>(`/api/projects/${id}/task-metrics/detail`)
        .then(setTaskLogs).catch(() => {});
    const load = () => {
      apiGet<TaskItem[]>(`/api/projects/${id}/tasks`)
        .then((d) => setTasks(Array.isArray(d) ? d : []))
        .catch(() => {});
      loadMetrics();
      loadLogs();
    };
    load();
    if (project.status !== "running") return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]);

  useEffect(() => {
    if (!id) return;
    const loadArtifacts = () => {
      apiGet<ArtifactsResp>(`/api/projects/${id}/artifacts`).then(setArtifacts).catch(() => null);
      apiGet<CodeFilesResp>(`/api/projects/${id}/code-files`).then(setCodeFiles).catch(() => null);
    };
    loadArtifacts(); // immediate load
    // Poll while running so graph and document list refresh automatically as agents produce files
    if (project?.status === "running") {
      const t = setInterval(loadArtifacts, 12000); // every 12s — artifacts change less frequently than tasks
      return () => clearInterval(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.status]);

  // Produto e triggers carregam para qualquer status — não dependem do pipeline estar ativo
  useEffect(() => {
    if (!id || !project) return;
    const pid = projectsStore.getById(id)?.productId;
    if (pid) {
      apiGet<{ id: string; name: string; projects?: Array<{ id: string; title: string; status: string; project_type?: string; complexity_hint?: string }> }>(
        `/api/products/${pid}`
      ).then(setProduct).catch(() => {});
    } else {
      setProduct(null);
    }
    apiGet<Array<{ id: string; trigger_project_id: string; trigger_project_title: string; trigger_project_status: string; trigger_status: string }>>(
      `/api/projects/${id}/triggers`
    ).then(setTriggers).catch(() => setTriggers([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.productId]);

  useEffect(() => {
    if (!id || !project) return;
    if (project.status === "completed" || project.status === "accepted") {
      apiGet<RunInfoResp>(`/api/projects/${id}/run-info`).then(setRunInfo).catch(() => null);
      apiGet<MetricsResp>(`/api/projects/${id}/metrics`).then(setMetrics).catch(() => null);
      apiGet<GithubRepoResp>(`/api/projects/${id}/github-repo`)
        .then((d) => setGithubRepo(d.repo))
        .catch(() => setGithubRepo(null));
      apiGet<VersionsResp>(`/api/projects/${id}/versions`)
        .then((d) => setVersions(d.versions ?? []))
        .catch(() => setVersions([]));
      apiGet<import("@/types").ProjectLink[]>(`/api/projects/${id}/links`)
        .then(setLinks).catch(() => setLinks([]));
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
  // Modal de seleção de task para reinício
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartFromTask, setRestartFromTask]     = useState<string>("");

  const handleRun = async (fromTaskId?: string) => {
    setRunError(null); setRunLoading(true);
    try {
      // Se fromTaskId especificado, resetar tasks a partir daquela para ASSIGNED
      if (fromTaskId && tasks && tasks.length > 0) {
        const idx = tasks.findIndex(t => (t.taskId || t.id) === fromTaskId);
        if (idx >= 0) {
          const toReset = tasks.slice(idx).filter(t => t.status !== "DONE" && t.status !== "QA_PASS");
          for (const t of toReset) {
            const tid = t.taskId || t.id;
            try { await apiPatch(`/api/projects/${id}/tasks/${tid}`, { status: "ASSIGNED" }); } catch { /* non-critical */ }
          }
        }
      }
      const d = await apiPost<{ ok: boolean; status?: string }>(`/api/projects/${id}/run`, {});
      if (d?.status === "running") projectsStore.setProjectStatus(id, "running");
      await projectsStore.loadProject(id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao iniciar");
    } finally {
      setRunLoading(false);
    }
  };

  const handleRestartClick = () => {
    // Só mostra o modal se há tasks (projeto com histórico)
    if (tasks && tasks.length > 0) {
      // Pré-selecionar: primeira task não DONE, ou BLOCKED
      const firstPending = tasks.find(t => !["DONE","QA_PASS","CANCELLED"].includes(t.status ?? ""));
      setRestartFromTask(firstPending?.taskId ?? firstPending?.id ?? tasks[0].taskId ?? tasks[0].id ?? "");
      setRestartDialogOpen(true);
    } else {
      handleRun();
    }
  };

  // FT-05: handlers do menu Ações
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean; title: string; message: string; critical?: boolean; action: () => Promise<void>;
  }>({ open: false, title: "", message: "", action: async () => {} });

  const openConfirm = (title: string, message: string, action: () => Promise<void>, critical = false) => {
    setActionsAnchor(null);
    setConfirmDialog({ open: true, title, message, critical, action });
  };

  const execConfirm = async () => {
    setConfirmDialog(d => ({ ...d, open: false }));
    setRunLoading(true);
    try { await confirmDialog.action(); }
    catch (e) { setRunError(e instanceof Error ? e.message : "Erro"); }
    finally { setRunLoading(false); }
  };

  const handleReject = () => openConfirm(
    "Rejeitar projeto",
    "O projeto será marcado como parado e poderá ser reiniciado depois.",
    async () => { await apiPost(`/api/projects/${id}/reject`, {}); await projectsStore.loadProject(id); }
  );

  const handleStopSafe = () => openConfirm(
    "Interromper Com Segurança",
    "⏳ O pipeline aguardará a task atual finalizar antes de parar. Isso pode levar alguns minutos.",
    async () => { await apiPost(`/api/projects/${id}/stop`, {}); await projectsStore.loadProject(id); }
  );

  const handleStopNow = () => openConfirm(
    "Interromper Imediatamente",
    "⚠️ ATENÇÃO: O pipeline será interrompido agora. A task em execução ficará incompleta e poderá gerar artefatos corrompidos.",
    async () => { await apiPost(`/api/projects/${id}/stop`, {}); await projectsStore.loadProject(id); },
    true,
  );

  const handleDeleteKeepFiles = () => openConfirm(
    "Excluir e Manter Arquivos",
    "O projeto será removido do banco de dados mas os arquivos gerados em disco serão mantidos em /zentriz-files.",
    async () => {
      // Garantir que está parado antes de excluir
      if (isRunning) await apiPost(`/api/projects/${id}/stop`, {}).catch(() => {});
      await apiDelete(`/api/projects/${id}?keepFiles=true`);
      router.push("/projects");
    },
    true,
  );

  const handleDeleteAll = () => openConfirm(
    "Excluir Completamente",
    "🔴 AÇÃO IRREVERSÍVEL: O projeto e TODOS os arquivos gerados serão apagados permanentemente do banco e do disco.",
    async () => {
      if (isRunning) await apiPost(`/api/projects/${id}/stop`, {}).catch(() => {});
      await apiDelete(`/api/projects/${id}?keepFiles=false`);
      router.push("/projects");
    },
    true,
  );

  const handleOpenLinkDialog = async () => {
    try {
      const data = await apiGet<Array<{ id: string; title: string; status: string; project_type?: string }>>("/api/projects");
      setLinkableProjects((data ?? []).filter(p => p.id !== id));
    } catch { setLinkableProjects([]); }
    setLinkTargetId("");
    setLinkRelationType("uses_backend");
    setLinkError(null);
    setLinkDialogOpen(true);
  };

  const handleCreateLink = async () => {
    if (!linkTargetId) { setLinkError("Selecione um projeto"); return; }
    setLinkSaving(true);
    setLinkError(null);
    try {
      await apiPost(`/api/projects/${id}/links`, { to_project_id: linkTargetId, relation_type: linkRelationType });
      const updated = await apiGet<import("@/types").ProjectLink[]>(`/api/projects/${id}/links`);
      setLinks(updated ?? []);
      setLinkDialogOpen(false);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "Falha ao criar vínculo");
    } finally {
      setLinkSaving(false);
    }
  };

  const handleAccept = async () => {
    setAcceptLoading(true);
    setWorkingStepIndex(6);
    setWorkingMessage("Aceito");
    try {
      await apiPost(`/api/projects/${id}/accept`, {});
      await projectsStore.loadProject(id);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao aceitar");
    } finally {
      setAcceptLoading(false);
    }
  };

  const handleEvolve = async () => {
    if (!evolveRequest.trim()) return;
    setEvolveLoading(true);
    try {
      const result = await apiPost(`/api/projects/${id}/evolve`, {
        request: evolveRequest.trim(),
        workMode: evolveWorkMode,
      });
      setEvolveOpen(false);
      setEvolveRequest("");
      // Navegar para o projeto filho
      const childId = (result as Record<string, unknown>)?.childProjectId;
      if (childId && typeof childId === "string") {
        window.location.href = `/projects/${childId}`;
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Falha ao criar evolução");
    } finally {
      setEvolveLoading(false);
    }
  };

  // ── Column resize drag handlers (must be before early returns — hooks rule) ──
  const startDrag = useCallback((col: "lc" | "cr", e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { col, startX: e.clientX, startLeft: colWidths.left, startCenter: colWidths.center, startRight: colWidths.right };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !layoutRef.current) return;
      const totalW = layoutRef.current.offsetWidth;
      const deltaPct = ((ev.clientX - dragRef.current.startX) / totalW) * 100;
      const MIN = 15;
      setColWidths(prev => {
        if (dragRef.current!.col === "lc") {
          const newLeft   = Math.max(MIN, Math.min(dragRef.current!.startLeft + deltaPct, 100 - MIN * 2));
          const newCenter = Math.max(MIN, dragRef.current!.startCenter - (newLeft - dragRef.current!.startLeft));
          return { ...prev, left: newLeft, center: newCenter };
        } else {
          const newCenter = Math.max(MIN, Math.min(dragRef.current!.startCenter + deltaPct, 100 - MIN * 2));
          const newRight  = Math.max(MIN, dragRef.current!.startRight - (newCenter - dragRef.current!.startCenter));
          return { ...prev, center: newCenter, right: newRight };
        }
      });
    };
    const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [colWidths]);

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
  const isDone      = project.status === "completed" || project.status === "accepted" || project.status === "pending_cyborg" || project.status === "blocked_cyborg";
  const canRun      = ALLOW_RUN_STATUS.has(project.status);
  const canAccept   = project.status === "completed" || project.status === "pending_cyborg" || project.status === "blocked_cyborg";
  const elapsedEnd  = project.completedAt ?? (isRunning ? new Date(nowTick).toISOString() : undefined);
  const elapsed     = elapsedLabel(project.startedAt, elapsedEnd);

  const stepFromStatus =
    project.status === "spec_submitted"  ? 1 :  // CTO+Engineer começa
    project.status === "cto_charter"     ? 2 :  // Charter pronto → PM
    project.status === "pm_backlog"      ? 3 :  // Backlog pronto → Dev+QA
    project.status === "dev_qa"          ? 3 :  // Dev+QA em andamento
    project.status === "devops"          ? 4 :  // DevOps
    project.status === "pending_cyborg"  ? 5 :  // Cyborg validando
    project.status === "blocked_cyborg"  ? 5 :
    isDone                               ? 6 :
    // running/stopped/failed: usar workingStepIndex se disponível, senão fase Dev+QA
    (workingStepIndex != null ? workingStepIndex : 3);

  // accepted: sempre mostrar "Pronto" (step 6)
  // Se todas as tasks estão DONE e projeto ainda running (aguardando aceite): também Pronto
  const allTasksDone = (tasks ?? []).length > 0 && (tasks ?? []).every(t => t.status === "DONE" || t.status === "CANCELLED");
  const effectiveStep = (project.status === "accepted" || project.status === "pending_cyborg" || project.status === "blocked_cyborg" || allTasksDone) ? 6 : stepFromStatus;

  // Clear workingStep when done — prevents last agent_working event from keeping stepper spinning
  const activeStep = (isRunning && !allTasksDone && workingStepIndex != null) ? workingStepIndex : effectiveStep;

  const tasksDone  = tasks ? tasks.filter((t) => t.status === "DONE" || t.status === "QA_PASS").length : 0;
  const tasksPct   = tasks && tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0;
  // Modelo LLM atual — último log com model não-nulo
  const currentModel = taskLogs?.rows.slice().reverse().find(r => r.model)?.model ?? null;

  // Shared tab content renderer — used by both center and right panels
  const renderTabContent = (tabId: number) => {
    if (tabId === 0) return (
      <Box key="dial" sx={{ flexGrow: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {isRunning && workingMessage && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider", bgcolor: "primary.main" + "12", flexShrink: 0 }}>
            <CircularProgress size={12} color="primary" />
            <Typography variant="caption" color="primary.main" fontWeight={500} noWrap>{workingMessage.slice(0, 80)}</Typography>
          </Stack>
        )}
        <LiveDialogue projectId={id} pollIntervalMs={isRunning ? 4000 : 15000} onEntriesLoaded={handleDialogueLoaded} />
      </Box>
    );
    if (tabId === 1) return (
      <Box key="graf" sx={{ flexGrow: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", p: 1.5 }}>
        <GraphView projectId={id} pollIntervalMs={isRunning ? 6000 : 0} height="100%" planningDocs={artifacts?.docs ?? []} />
      </Box>
    );
    if (tabId === 2) return (
      <Box key="docs" sx={{ p: 2, flexGrow: 1, overflow: "auto" }}>
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
              <TableHead><TableRow>
                <TableCell>Arquivo</TableCell>
                <TableCell sx={{ width: 110 }}>Agente</TableCell>
                <TableCell sx={{ width: 140 }}>Data</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {artifacts.docs.map((d, i) => (
                  <TableRow key={i} onClick={() => setDocModal({ filename: d.filename, title: d.title ?? d.filename })}
                    sx={{ cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }}>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" sx={{ fontSize: "0.65rem", color: "#484F58", fontFamily: "monospace", flexShrink: 0 }}>
                          {(d.filename.split(".").pop() ?? "").toUpperCase()}
                        </Typography>
                        <Box>
                          <Typography variant="body2">{d.title ?? d.filename}</Typography>
                          {d.title && d.filename !== d.title && (
                            <Typography variant="caption" color="text.secondary" fontFamily="monospace" sx={{ fontSize: "0.6rem" }}>{d.filename}</Typography>
                          )}
                        </Box>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {(() => { const p = d.creator ? getAgentProfile(d.creator) : null; return (
                        <Chip size="small" label={p?.name ?? d.creator ?? "—"}
                          sx={{ fontSize: "0.62rem", bgcolor: p ? `${p.color}22` : undefined, color: p?.color, border: `1px solid ${p?.color ?? "#30363D"}44` }} />
                      ); })()}
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
    );
    // tabId === 3
    return (
      <Box key="code" sx={{ flexGrow: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {(!codeFiles || codeFiles.totalFiles === 0) ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>Arquivos de código gerados pelo Dev aparecerão aqui.</Typography>
        ) : (
          <CodeExplorer projectId={id} files={codeFiles.files} appsRoot={codeFiles.appsRoot} height="100%" />
        )}
      </Box>
    );
  };

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
        <StatusChip status={project.status} model={currentModel} />

        {/* FT-05: Botões de ação + menu Ações */}
        {canRun && !isRunning && (
          <Button variant="contained" size="small"
            startIcon={project.status === "stopped" || project.status === "failed" ? <ReplayIcon /> : <PlayArrowIcon />}
            disabled={runLoading}
            onClick={project.status === "stopped" || project.status === "failed" ? handleRestartClick : () => handleRun()}>
            {runLoading ? "Iniciando…" : project.status === "stopped" || project.status === "failed" ? "Reiniciar" : "Iniciar"}
          </Button>
        )}
        {canAccept && (
          <Button variant="contained" color="primary" size="small" startIcon={<CheckCircleIcon />}
            disabled={acceptLoading} onClick={handleAccept}>
            {acceptLoading ? "Aceitando…" : "Aceitar"}
          </Button>
        )}
        {/* FT-10: Botão Evoluir — só aparece em projetos aceitos */}
        {project.status === "accepted" && (
          <Button variant="outlined" color="secondary" size="small"
            startIcon={<span style={{ fontSize: "1rem" }}>🔄</span>}
            onClick={() => setEvolveOpen(true)}>
            Evoluir
          </Button>
        )}
        {/* Menu Ações */}
        <Tooltip title="Ações">
          <IconButton size="small" disabled={runLoading} onClick={e => setActionsAnchor(e.currentTarget)}>
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={actionsAnchor} open={!!actionsAnchor} onClose={() => setActionsAnchor(null)}>
          {isRunning && <MenuItem onClick={handleStopSafe}><StopIcon sx={{ mr: 1, fontSize: "1rem" }} />Interromper Com Segurança</MenuItem>}
          {isRunning && <MenuItem onClick={handleStopNow} sx={{ color: "warning.main" }}><StopIcon sx={{ mr: 1, fontSize: "1rem" }} />Interromper Imediatamente</MenuItem>}
          {(isRunning || isDone) && <MenuItem onClick={handleReject}><CancelIcon sx={{ mr: 1, fontSize: "1rem" }} />Rejeitar</MenuItem>}
          <Divider />
          <MenuItem onClick={handleDeleteKeepFiles} sx={{ color: "warning.main" }}><DeleteOutlineIcon sx={{ mr: 1, fontSize: "1rem" }} />Excluir e Manter Arquivos</MenuItem>
          <MenuItem onClick={handleDeleteAll} sx={{ color: "error.main" }}><DeleteForeverIcon sx={{ mr: 1, fontSize: "1rem" }} />Excluir Completamente</MenuItem>
        </Menu>
        {/* Diálogo de confirmação */}
        <Dialog open={confirmDialog.open} onClose={() => setConfirmDialog(d => ({ ...d, open: false }))} maxWidth="xs" fullWidth>
          <DialogTitle>{confirmDialog.title}</DialogTitle>
          <DialogContent>
            <Alert severity={confirmDialog.critical ? "error" : "warning"} sx={{ mt: 1 }}>
              {confirmDialog.message}
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmDialog(d => ({ ...d, open: false }))}>Cancelar</Button>
            <Button onClick={execConfirm} variant="contained" color={confirmDialog.critical ? "error" : "warning"} autoFocus>
              Confirmar
            </Button>
          </DialogActions>
        </Dialog>
      </Stack>

      {/* Modal: Reiniciar a partir de qual task? */}
      <Dialog open={restartDialogOpen} onClose={() => setRestartDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Stack direction="row" alignItems="center" spacing={1}>
            <ReplayIcon color="warning" />
            <Typography variant="h6">Reiniciar pipeline</Typography>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Escolha a partir de qual task o pipeline deve continuar. Tasks anteriores à selecionada permanecem com o status atual.
          </Typography>
          {tasks && tasks.length > 0 ? (
            <FormControl fullWidth size="small">
              <InputLabel>Retomar a partir de</InputLabel>
              <Select
                label="Retomar a partir de"
                value={restartFromTask}
                onChange={(e) => setRestartFromTask(e.target.value as string)}
              >
                {tasks.map((t) => {
                  const tid = t.taskId ?? t.id ?? "";
                  const statusColors: Record<string, string> = {
                    DONE: "#10B981", QA_PASS: "#10B981", BLOCKED: "#EF4444",
                    QA_FAIL: "#EF4444", IN_PROGRESS: "#6366F1", ASSIGNED: "#F59E0B",
                  };
                  const color = statusColors[t.status ?? ""] ?? "#6B7280";
                  return (
                    <MenuItem key={tid} value={tid}>
                      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: "100%" }}>
                        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: color, flexShrink: 0 }} />
                        <Typography variant="body2" fontFamily="monospace" sx={{ minWidth: 120, flexShrink: 0, fontSize: "0.78rem" }}>
                          {tid}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ flexGrow: 1 }}>
                          {t.requirements?.slice(0, 50) ?? ""}
                        </Typography>
                        <Chip size="small" label={t.status ?? "—"}
                          sx={{ fontSize: "0.6rem", height: 18, bgcolor: color + "22", color }} />
                      </Stack>
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
          ) : (
            <Typography variant="body2" color="text.secondary">Nenhuma task registrada — o pipeline iniciará do começo.</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestartDialogOpen(false)}>Cancelar</Button>
          <Button
            variant="contained" color="warning" startIcon={<ReplayIcon />}
            disabled={runLoading}
            onClick={() => {
              setRestartDialogOpen(false);
              handleRun(restartFromTask || undefined);
            }}>
            {runLoading ? "Reiniciando…" : "Reiniciar"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Error alert */}
      {runError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRunError(null)}>{runError}</Alert>
      )}

      {/* FT-02: Banner para projetos em spec_submitted — revisar spec antes de iniciar */}
      {project.status === "spec_submitted" && !isRunning && (
        <Alert severity="info" sx={{ mb: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" color="info" startIcon={<EditIcon />}
                onClick={() => router.push(`/spec?editProjectId=${id}`)}>
                Editar Spec
              </Button>
              <Button size="small" variant="contained" color="info" startIcon={<PlayArrowIcon />}
                disabled={runLoading} onClick={() => handleRun()}>
                Iniciar Agora
              </Button>
            </Stack>
          }>
          <Typography variant="body2" fontWeight={500}>Spec enviada — aguardando início</Typography>
          <Typography variant="caption" color="text.secondary">
            Revise a spec antes de iniciar ou clique em Iniciar Agora.
          </Typography>
        </Alert>
      )}

      {/* Badge: projeto aceito pelo Cyborg */}
      {project.status === "accepted" && (project.extra as Record<string,unknown>)?.accepted_by === "zentriz-cyborg" && (
        <Alert severity="info" icon={<span style={{ fontSize: "1.1rem" }}>🤖</span>} sx={{ mb: 2 }}>
          <Typography variant="body2" fontWeight={600}>Validado pelo Zentriz Cyborg</Typography>
          <Typography variant="caption" color="text.secondary">
            Este projeto foi testado e aceito automaticamente pelo Cyborg. Nenhuma intervenção humana necessária.
          </Typography>
        </Alert>
      )}

      {/* Card: Cyborg em validação (pending_cyborg) */}
      {project.status === "pending_cyborg" && (
        <CyborgLogCard projectId={id} cyborgAttempts={project.cyborg_attempts ?? 0} />
      )}

      {/* Banner: Cyborg bloqueado — intervenção humana necessária */}
      {project.status === "blocked_cyborg" && (
        <Alert
          severity="error"
          icon={<span style={{ fontSize: "1.1rem" }}>🚫</span>}
          sx={{ mb: 2 }}
          action={
            <Button size="small" color="inherit" variant="outlined" onClick={() => handleAccept()}>
              Aceitar manualmente
            </Button>
          }
        >
          <Typography variant="body2" fontWeight={600}>Cyborg esgotou 5 tentativas sem validar o projeto</Typography>
          <Typography variant="caption" color="text.secondary">
            Verifique os logs do Cyborg abaixo, corrija os problemas identificados e aceite manualmente ou reinicie o pipeline.
          </Typography>
        </Alert>
      )}

      {/* FT-10: Modal de Evolução */}
      <Dialog open={evolveOpen} onClose={() => setEvolveOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>🔄 Evoluir projeto</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            Uma evolução cria um projeto filho a partir deste. O CTO analisa o pedido, identifica o delta e gera apenas as tasks necessárias. Nada é removido sem instrução explícita.
          </Alert>
          <Typography variant="subtitle2" gutterBottom>O que você quer evoluir?</Typography>
          <textarea
            value={evolveRequest}
            onChange={e => setEvolveRequest(e.target.value)}
            placeholder="Ex: Adicionar módulo de relatórios em PDF, exportação CSV, ou tela de comparativo mensal..."
            rows={4}
            style={{
              width: "100%", padding: "10px", borderRadius: "6px", resize: "vertical",
              fontFamily: "inherit", fontSize: "0.875rem",
              border: "1px solid #ccc", outline: "none", boxSizing: "border-box",
            }}
          />
          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>Modo de trabalho</Typography>
          <div style={{ display: "flex", gap: "8px" }}>
            {(["copy", "branch"] as const).map(m => (
              <Button
                key={m} size="small"
                variant={evolveWorkMode === m ? "contained" : "outlined"}
                onClick={() => setEvolveWorkMode(m)}
              >
                {m === "copy" ? "📋 Cópia isolada" : "🌿 Branch git"}
              </Button>
            ))}
          </div>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            {evolveWorkMode === "copy"
              ? "Cria uma cópia dos arquivos do projeto atual. Mais simples, sem dependência de git."
              : "Cria branches main/staging/dev (se necessário) e um branch evolution/vN. Requer git disponível no projeto."}
          </Typography>
        </DialogContent>
        <DialogContent sx={{ pt: 0, display: "flex", justifyContent: "flex-end", gap: 1 }}>
          <Button onClick={() => setEvolveOpen(false)} disabled={evolveLoading}>Cancelar</Button>
          <Button
            variant="contained" color="secondary"
            disabled={!evolveRequest.trim() || evolveLoading}
            onClick={handleEvolve}
          >
            {evolveLoading ? "Criando…" : "Criar evolução"}
          </Button>
        </DialogContent>
      </Dialog>

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

      {/* ── Main cockpit layout — 3 resizable columns ── */}
      <Box ref={layoutRef} sx={{ display: "flex", gap: 0, alignItems: "flex-start", userSelect: dragRef.current ? "none" : "auto" }}>
        {/* LEFT COLUMN */}
        <Box sx={{ width: `${colWidths.left}%`, flexShrink: 0, pr: 1 }}>
          <Stack spacing={2}>
            {/* Pipeline stepper vertical */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Pipeline
                  </Typography>
                  <IconButton size="small" onClick={() => toggleCollapse("pipeline")} sx={{ p: 0.25, ml: 0.5 }}>
                    {collapsed.pipeline ? <ExpandMoreIcon sx={{ fontSize: "0.9rem" }} /> : <ExpandLessIcon sx={{ fontSize: "0.9rem" }} />}
                  </IconButton>
                </Stack>
                <Collapse in={!collapsed.pipeline}>

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
                    const isDoneStep   = i < activeStep;
                    const isActiveStep = i === activeStep;
                    const isFutureStep = i > activeStep;
                    const profile      = step.agent ? getAgentProfile(step.agent) : null;
                    const dotColor     = isDoneStep ? "#22c55e" : isActiveStep ? (profile?.color ?? "#6366F1") : "#30363D";

                    // Contexto extra por fase ativa
                    const phaseDetail = (() => {
                      if (!isActiveStep) return null;
                      // Fase 1 — CTO+Engineer: mostrar rounds se disponível no charter_summary
                      if (i === 1 && isRunning) {
                        return workingMessage ? workingMessage.slice(0, 70) : "Analisando spec e definindo arquitetura…";
                      }
                      // Fase 2 — PM
                      if (i === 2 && isRunning) return workingMessage ? workingMessage.slice(0, 70) : "Quebrando charter em tasks executáveis…";
                      // Fase 3 — Dev+QA: mostrar progresso real de tasks
                      if (i === 3) {
                        if (tasks && tasks.length > 0) {
                          const blocked = tasks.filter(t => t.status === "BLOCKED").length;
                          const inProg  = tasks.filter(t => t.status === "IN_PROGRESS").length;
                          const detail  = blocked > 0 ? `${blocked} BLOCKED` : inProg > 0 ? "Implementando…" : "Aguardando Dev…";
                          return `${tasksDone}/${tasks.length} tasks · ${detail}`;
                        }
                        return workingMessage ? workingMessage.slice(0, 70) : null;
                      }
                      // Fase 4 — DevOps
                      if (i === 4 && isRunning) return workingMessage ? workingMessage.slice(0, 70) : "Gerando Dockerfile e docker-compose…";
                      // Fase 5 — Cyborg
                      if (i === 5) return workingMessage ? workingMessage.slice(0, 70) : "Validando E2E…";
                      return null;
                    })();

                    return (
                      <Box key={step.label} sx={{ display: "flex", alignItems: "flex-start", gap: 1.25, pb: i < PIPELINE_STEPS.length - 1 ? 0 : 0 }}>
                        {/* Linha vertical + dot */}
                        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", width: 18, flexShrink: 0 }}>
                          {/* Dot */}
                          <Box sx={{
                            width: isDoneStep ? 12 : isActiveStep ? 13 : 10,
                            height: isDoneStep ? 12 : isActiveStep ? 13 : 10,
                            borderRadius: isDoneStep ? "50%" : isActiveStep ? "3px" : "50%",
                            bgcolor: isDoneStep ? dotColor : isActiveStep ? dotColor : "transparent",
                            border: `2px solid ${dotColor}`,
                            flexShrink: 0,
                            mt: 0.4,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: "0.55rem", color: "#fff", fontWeight: 700,
                            ...(isActiveStep && isRunning && {
                              boxShadow: `0 0 0 4px ${dotColor}25`,
                              animation: "dot-pulse 1.6s ease-in-out infinite",
                              "@keyframes dot-pulse": {
                                "0%,100%": { boxShadow: `0 0 0 4px ${dotColor}25` },
                                "50%":     { boxShadow: `0 0 0 8px ${dotColor}10` },
                              },
                            }),
                          }}>
                            {isDoneStep && <Box component="span" sx={{ lineHeight: 1, fontSize: "0.6rem" }}>✓</Box>}
                          </Box>
                          {/* Linha de conexão */}
                          {i < PIPELINE_STEPS.length - 1 && (
                            <Box sx={{
                              width: "2px", flexGrow: 1, minHeight: isActiveStep ? 28 : 20,
                              bgcolor: isDoneStep ? "#22c55e" : "divider",
                              opacity: isDoneStep ? 0.6 : 0.25,
                              borderRadius: 1,
                              my: 0.25,
                            }} />
                          )}
                        </Box>

                        {/* Conteúdo da fase */}
                        <Box sx={{ pb: 0.5, minWidth: 0, flexGrow: 1, pt: 0.25 }}>
                          <Stack direction="row" alignItems="center" spacing={0.75} flexWrap="wrap">
                            {/* Avatar do agente */}
                            {profile && (
                              <Box sx={{
                                width: 18, height: 18, borderRadius: "4px", flexShrink: 0,
                                bgcolor: isDoneStep ? "#22c55e18" : `${profile.color}20`,
                                border: `1px solid ${isDoneStep ? "#22c55e40" : isActiveStep ? profile.color : profile.color + "40"}`,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: "0.6rem",
                              }}>
                                {profile.avatar}
                              </Box>
                            )}
                            <Typography
                              variant="body2"
                              fontWeight={isActiveStep ? 700 : isDoneStep ? 500 : 400}
                              sx={{
                                lineHeight: 1.4,
                                color: isDoneStep ? "#22c55e" : isActiveStep ? (profile?.color ?? "primary.main") : isFutureStep ? "text.disabled" : "text.primary",
                                fontSize: "0.78rem",
                              }}
                            >
                              {step.label}
                            </Typography>
                            {/* Spinner apenas quando esta fase está ativa e rodando */}
                            {isActiveStep && isRunning && (
                              <CircularProgress size={9} sx={{ color: profile?.color ?? "primary.main", flexShrink: 0 }} />
                            )}
                            {/* Badge de tasks na fase Dev+QA */}
                            {i === 3 && tasks && tasks.length > 0 && (
                              <Typography variant="caption" sx={{ color: isDoneStep ? "#22c55e" : isActiveStep ? "text.secondary" : "text.disabled", fontSize: "0.65rem" }}>
                                {tasksDone}/{tasks.length}
                              </Typography>
                            )}
                          </Stack>

                          {/* Descrição da fase — só quando ativa ou completa com contexto */}
                          {isActiveStep && phaseDetail && (
                            <Typography variant="caption" color="text.secondary"
                              sx={{ display: "block", mt: 0.25, ml: profile ? 3.25 : 0, fontSize: "0.67rem", lineHeight: 1.4, maxWidth: 190, wordBreak: "break-word" }}>
                              {phaseDetail}
                            </Typography>
                          )}
                          {/* Fase futura: mostrar descrição discreta */}
                          {isFutureStep && (
                            <Typography variant="caption" sx={{ display: "block", ml: profile ? 3.25 : 0, fontSize: "0.63rem", color: "text.disabled", lineHeight: 1.3 }}>
                              {step.desc}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    );
                  })}
                </Stack>
                </Collapse>
              </CardContent>
            </Card>

            {/* Quick metrics */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    Métricas
                  </Typography>
                  <IconButton size="small" onClick={() => toggleCollapse("metrics")} sx={{ p: 0.25, ml: 0.5 }}>
                    {collapsed.metrics ? <ExpandMoreIcon sx={{ fontSize: "0.9rem" }} /> : <ExpandLessIcon sx={{ fontSize: "0.9rem" }} />}
                  </IconButton>
                </Stack>
                <Collapse in={!collapsed.metrics}>
                  <Stack spacing={1.25}>
                    {elapsed && <MiniStat label={isRunning ? "⏱ Esta execução" : "Tempo total"} value={elapsed} />}
                    {project.createdAt && <MiniStat label="Criado em" value={fmtTime(project.createdAt)} />}
                    {project.startedAt && project.startedAt !== project.createdAt && (
                      <MiniStat label="Última execução" value={fmtTime(project.startedAt)} />
                    )}
                    {tasks && tasks.length > 0 && <MiniStat label="Tasks" value={`${tasksDone}/${tasks.length}`} />}
                    {codeFiles && codeFiles.totalFiles > 0 && <MiniStat label="Arquivos gerados" value={codeFiles.totalFiles} />}
                    {metrics && metrics.totals.calls > 0 && (
                      <>
                        <MiniStat label="Tokens" value={(metrics.totals.input_tokens + metrics.totals.output_tokens).toLocaleString("pt-BR")} />
                        <MiniStat label="Custo est." value={`~$${metrics.totals.estimated_cost_usd.toFixed(2)}`} color="success.main" />
                      </>
                    )}
                  </Stack>
                </Collapse>
              </CardContent>
            </Card>

            {/* Version history */}
            {versions.length > 1 && (
              <Card>
                <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary"
                      sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem" }}>
                      Versões do produto
                    </Typography>
                    {isDone && (
                      <Tooltip title="Nova versão — enviar nova spec">
                        <Button size="small" startIcon={<PlayArrowIcon sx={{ fontSize: "0.8rem !important" }} />}
                          onClick={() => router.push(`/spec?parentProjectId=${id}&parentTitle=${encodeURIComponent(project.title ?? "")}`)}
                          sx={{ fontSize: "0.65rem", py: 0.2, px: 0.75, minWidth: "auto" }}>
                          v{versions.length + 1}
                        </Button>
                      </Tooltip>
                    )}
                  </Stack>
                  <Stack spacing={0.5}>
                    {versions.map((v) => (
                      <Box
                        key={v.id}
                        onClick={() => v.id !== id && router.push(`/projects/${v.id}`)}
                        sx={{
                          display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.5,
                          borderRadius: 0.75, cursor: v.id !== id ? "pointer" : "default",
                          bgcolor: v.isCurrent ? "primary.main" + "14" : "transparent",
                          border: v.isCurrent ? "1px solid" : "1px solid transparent",
                          borderColor: v.isCurrent ? "primary.main" + "40" : "transparent",
                          "&:hover": { bgcolor: v.id !== id ? "action.hover" : undefined },
                        }}
                      >
                        <Typography variant="caption" fontWeight={700}
                          sx={{ color: v.isCurrent ? "primary.main" : "text.secondary", minWidth: 20, fontSize: "0.65rem" }}>
                          v{v.versionNumber}
                        </Typography>
                        <Typography variant="caption" noWrap sx={{ flexGrow: 1, fontSize: "0.7rem",
                          color: v.isCurrent ? "text.primary" : "text.secondary" }}>
                          {v.isCurrent ? "atual" : new Date(v.createdAt).toLocaleDateString("pt-BR", { day:"2-digit", month:"short" })}
                        </Typography>
                        <Chip size="small" label={v.status}
                          color={v.status === "accepted" || v.status === "completed" ? "success" : v.status === "running" ? "info" : "default"}
                          sx={{ fontSize: "0.55rem", height: 14 }} />
                      </Box>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            )}

            {/* Original idea (free description saved at submission) */}
            {project.projectType && (
              <Card>
                <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 0.75, fontSize: "0.6rem" }}>
                    Tipo do projeto
                  </Typography>
                  <Chip size="small"
                    label={PROJECT_TYPE_LABELS[project.projectType] ?? project.projectType}
                    sx={{ fontSize: "0.72rem" }}
                  />
                </CardContent>
              </Card>
            )}

            {/* ── Produto + Projetos do Produto + Gatilhos ── */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem" }}>
                    🧩 Produto
                  </Typography>
                  {!product && (
                    <Tooltip title="Associar a um produto">
                      <IconButton size="small" sx={{ p: 0.25 }} onClick={() => {
                        apiGet<Array<{ id: string; name: string }>>("/api/products").then(setAllProducts).catch(() => {});
                        setProductDialogOpen(true);
                      }}>
                        <AddLinkIcon sx={{ fontSize: "0.85rem" }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>

                {product ? (
                  <>
                    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1 }}>
                      <Chip size="small" label={product.name}
                        sx={{ fontSize: "0.72rem", fontWeight: 600, bgcolor: "primary.main" + "22", color: "primary.main" }} />
                      <Tooltip title="Desvincular do produto">
                        <IconButton size="small" sx={{ p: 0.1 }} onClick={async () => {
                          await apiPatch(`/api/projects/${id}/product`, { productId: null });
                          setProduct(null);
                          projectsStore.loadProject(id);
                        }}>
                          <DeleteOutlineIcon sx={{ fontSize: "0.75rem", color: "text.disabled" }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>

                    {/* Projetos do produto */}
                    {product.projects && product.projects.length > 0 && (
                      <Stack spacing={0.5} sx={{ mb: 1 }}>
                        {product.projects.map((p) => {
                          const isCurrent = p.id === id;
                          const stColors: Record<string, string> = {
                            accepted: "#22c55e", completed: "#22c55e", running: "#3b82f6",
                            failed: "#ef4444", stopped: "#ef4444",
                          };
                          const stColor = stColors[p.status] ?? "#6b7280";
                          return (
                            <Box key={p.id}
                              onClick={() => !isCurrent && router.push(`/projects/${p.id}`)}
                              sx={{
                                display: "flex", alignItems: "center", gap: 0.75, px: 1, py: 0.5,
                                borderRadius: 0.75, cursor: isCurrent ? "default" : "pointer",
                                bgcolor: isCurrent ? "primary.main" + "14" : "transparent",
                                border: isCurrent ? "1px solid" : "1px solid transparent",
                                borderColor: isCurrent ? "primary.main" + "44" : "transparent",
                                "&:hover": { bgcolor: isCurrent ? undefined : "action.hover" },
                              }}>
                              <Box sx={{ width: 5, height: 5, borderRadius: "50%", bgcolor: stColor, flexShrink: 0 }} />
                              <Typography variant="caption" sx={{ fontSize: "0.68rem", flexGrow: 1 }} noWrap>
                                {p.title ?? "Sem título"}
                              </Typography>
                              {isCurrent && <Chip size="small" label="Este" sx={{ height: 14, fontSize: "0.55rem", bgcolor: "primary.main" + "22", color: "primary.main" }} />}
                            </Box>
                          );
                        })}
                      </Stack>
                    )}
                  </>
                ) : (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.68rem" }}>
                    Sem produto vinculado
                  </Typography>
                )}

                {/* Gatilhos */}
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem" }}>
                    ⚡ Gatilhos
                  </Typography>
                  <Tooltip title="Adicionar gatilho">
                    <IconButton size="small" sx={{ p: 0.25 }} onClick={() => {
                      if (product?.projects) setTriggerDialogOpen(true);
                      else setTriggerDialogOpen(true);
                    }}>
                      <BoltIcon sx={{ fontSize: "0.85rem" }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
                {triggers.length === 0 ? (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.68rem" }}>
                    Inicia quando o projeto anterior terminar.
                  </Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {triggers.map((t) => (
                      <Box key={t.id} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <BoltIcon sx={{ fontSize: "0.75rem", color: "warning.main" }} />
                        <Typography variant="caption" sx={{ fontSize: "0.68rem", flexGrow: 1 }} noWrap>
                          {t.trigger_project_title ?? t.trigger_project_id.slice(0, 8)}
                        </Typography>
                        <Chip size="small" label={t.trigger_status}
                          sx={{ height: 14, fontSize: "0.55rem", bgcolor: "warning.main" + "22", color: "warning.main" }} />
                        <Tooltip title="Remover gatilho">
                          <IconButton size="small" sx={{ p: 0.1 }} onClick={async () => {
                            await apiDelete(`/api/projects/${id}/triggers/${t.id}`);
                            setTriggers((prev) => prev.filter((x) => x.id !== t.id));
                          }}>
                            <DeleteOutlineIcon sx={{ fontSize: "0.7rem", color: "text.disabled" }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            {/* Modal: associar a produto */}
            <Dialog open={productDialogOpen} onClose={() => setProductDialogOpen(false)} maxWidth="xs" fullWidth>
              <DialogTitle>Associar a Produto</DialogTitle>
              <DialogContent>
                <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                  <InputLabel>Produto</InputLabel>
                  <Select label="Produto" value={linkProductId} onChange={(e) => setLinkProductId(e.target.value as string)}>
                    {allProducts.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
                  </Select>
                </FormControl>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setProductDialogOpen(false)}>Cancelar</Button>
                <Button variant="contained" disabled={!linkProductId || linkProductSaving}
                  onClick={async () => {
                    setLinkProductSaving(true);
                    try {
                      await apiPatch(`/api/projects/${id}/product`, { productId: linkProductId });
                      const prod = allProducts.find((p) => p.id === linkProductId);
                      if (prod) {
                        const fullProd = await apiGet<typeof product>(`/api/products/${linkProductId}`);
                        setProduct(fullProd);
                      }
                      projectsStore.loadProject(id);
                      setProductDialogOpen(false);
                    } finally { setLinkProductSaving(false); }
                  }}>
                  {linkProductSaving ? "Salvando…" : "Associar"}
                </Button>
              </DialogActions>
            </Dialog>

            {/* Modal: adicionar gatilho */}
            <Dialog open={triggerDialogOpen} onClose={() => setTriggerDialogOpen(false)} maxWidth="xs" fullWidth>
              <DialogTitle>Adicionar Gatilho</DialogTitle>
              <DialogContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Este projeto será iniciado automaticamente quando o projeto selecionado atingir o status escolhido.
                </Typography>
                <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                  <InputLabel>Projeto gatilho</InputLabel>
                  <Select label="Projeto gatilho" value={triggerProjectId}
                    onChange={(e) => setTriggerProjectId(e.target.value as string)}>
                    {(product?.projects ?? [])
                      .filter((p) => p.id !== id)
                      .map((p) => <MenuItem key={p.id} value={p.id}>{p.title ?? p.id.slice(0, 8)}</MenuItem>)}
                    {/* Se não há produto, mostrar campo de texto */}
                  </Select>
                </FormControl>
                {!product && (
                  <TextField fullWidth size="small" label="ID do projeto gatilho" value={triggerProjectId}
                    onChange={(e) => setTriggerProjectId(e.target.value)} sx={{ mb: 2 }} />
                )}
                <FormControl fullWidth size="small">
                  <InputLabel>Disparar quando</InputLabel>
                  <Select label="Disparar quando" value={triggerStatus}
                    onChange={(e) => setTriggerStatus(e.target.value as string)}>
                    <MenuItem value="accepted">Aceito pelo usuário</MenuItem>
                    <MenuItem value="completed">Concluído pelo pipeline</MenuItem>
                  </Select>
                </FormControl>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setTriggerDialogOpen(false)}>Cancelar</Button>
                <Button variant="contained" disabled={!triggerProjectId || triggerSaving}
                  onClick={async () => {
                    setTriggerSaving(true);
                    try {
                      const res = await apiPost<{ id: string; trigger_project_id: string; trigger_status: string }>(
                        `/api/projects/${id}/triggers`,
                        { triggerProjectId, triggerStatus }
                      );
                      const proj = product?.projects?.find((p) => p.id === triggerProjectId);
                      setTriggers((prev) => [...prev, {
                        id: res.id,
                        trigger_project_id: triggerProjectId,
                        trigger_project_title: proj?.title ?? triggerProjectId.slice(0, 8),
                        trigger_project_status: proj?.status ?? "unknown",
                        trigger_status: triggerStatus,
                      }]);
                      setTriggerDialogOpen(false);
                      setTriggerProjectId("");
                    } finally { setTriggerSaving(false); }
                  }}>
                  {triggerSaving ? "Salvando…" : "Salvar"}
                </Button>
              </DialogActions>
            </Dialog>

            {/* Dialog: Ligar ao projeto */}
            <Dialog open={linkDialogOpen} onClose={() => setLinkDialogOpen(false)} maxWidth="xs" fullWidth>
              <DialogTitle>Ligar a outro projeto</DialogTitle>
              <DialogContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Vincule este projeto a um backend, frontend ou serviço relacionado. O Genesis usará esse contexto automaticamente no próximo pipeline.
                </Typography>
                <Stack spacing={2}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Tipo de relação</InputLabel>
                    <Select value={linkRelationType} label="Tipo de relação" onChange={(e) => setLinkRelationType(e.target.value)}>
                      <MenuItem value="uses_backend">Usa Backend (este frontend consome uma API)</MenuItem>
                      <MenuItem value="shares_auth">Compartilha Auth</MenuItem>
                      <MenuItem value="shares_db">Compartilha Banco de Dados</MenuItem>
                      <MenuItem value="depends_on">Depende de</MenuItem>
                      <MenuItem value="related">Relacionado</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl fullWidth size="small">
                    <InputLabel>Projeto destino</InputLabel>
                    <Select value={linkTargetId} label="Projeto destino" onChange={(e) => setLinkTargetId(e.target.value)}>
                      {linkableProjects.map((p) => (
                        <MenuItem key={p.id} value={p.id}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2" noWrap>{p.title}</Typography>
                            <Chip size="small" label={p.project_type ?? p.status} sx={{ fontSize: "0.6rem", height: 16 }} />
                          </Stack>
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  {linkError && <Typography color="error" variant="caption">{linkError}</Typography>}
                </Stack>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setLinkDialogOpen(false)}>Cancelar</Button>
                <Button variant="contained" disabled={!linkTargetId || linkSaving} onClick={handleCreateLink}>
                  {linkSaving ? "Salvando…" : "Vincular"}
                </Button>
              </DialogActions>
            </Dialog>

            {/* Projetos relacionados */}
            <Card>
              <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: links.length > 0 ? 1 : 0 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem" }}>
                    🔗 Projetos relacionados
                  </Typography>
                  <Button size="small" variant="outlined" onClick={handleOpenLinkDialog}
                    sx={{ fontSize: "0.6rem", py: 0.25, px: 0.75, minWidth: 0, lineHeight: 1.4, borderRadius: 1 }}>
                    + Ligar
                  </Button>
                </Stack>
                {links.length > 0 ? (
                  <Stack spacing={0.75}>
                    {links.map((lnk) => {
                      const isOut = lnk.direction === "outgoing";
                      const title = isOut ? lnk.to_title : lnk.from_title;
                      const otherId = isOut ? lnk.to_project_id : lnk.from_project_id;
                      return (
                        <Box key={lnk.id} sx={{ display: "flex", alignItems: "flex-start", gap: 0.75, cursor: "pointer" }}
                          onClick={() => router.push(`/projects/${otherId}`)}>
                          <Typography variant="caption" sx={{ fontSize: "0.65rem", color: "text.secondary", mt: 0.1, flexShrink: 0 }}>
                            {lnk.relation_label ?? lnk.relation_type}
                          </Typography>
                          <Typography variant="caption" fontWeight={500} sx={{ fontSize: "0.72rem", color: "primary.main" }} noWrap>
                            {title}
                          </Typography>
                        </Box>
                      );
                    })}
                  </Stack>
                ) : (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>
                    Nenhum projeto relacionado
                  </Typography>
                )}
              </CardContent>
            </Card>

            {project.freeDescription && (
              <Card>
                <CardContent sx={{ pt: 1.5, pb: "12px !important" }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: collapsed.idea ? 0 : 0.75 }}>
                    <Typography variant="caption" color="text.secondary"
                      sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem" }}>
                      💡 Ideia original
                    </Typography>
                    <IconButton size="small" onClick={() => toggleCollapse("idea")} sx={{ p: 0.25, ml: 0.5 }}>
                      {collapsed.idea ? <ExpandMoreIcon sx={{ fontSize: "0.9rem" }} /> : <ExpandLessIcon sx={{ fontSize: "0.9rem" }} />}
                    </IconButton>
                  </Stack>
                  <Collapse in={!collapsed.idea}>
                    <Typography variant="body2" color="text.secondary"
                      sx={{ fontSize: "0.78rem", lineHeight: 1.6, whiteSpace: "pre-wrap", fontStyle: "italic" }}>
                      &ldquo;{project.freeDescription}&rdquo;
                    </Typography>
                  </Collapse>
                </CardContent>
              </Card>
            )}

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
        </Box>

        {/* Drag handle left↔center */}
        <Box onMouseDown={(e) => startDrag("lc", e)}
          sx={{ width: 6, flexShrink: 0, cursor: "col-resize", alignSelf: "stretch",
            bgcolor: "transparent", "&:hover": { bgcolor: "primary.main" + "40" },
            transition: "background-color 0.15s", borderRadius: 1, mx: 0.25 }} />

        {/* ── CENTER PANEL ── */}
        <Box sx={{ width: `${colWidths.center}%`, flexShrink: 0, px: 0.5 }}>
          <Card sx={{ height: "calc(100vh - 180px)", minHeight: 600, display: "flex", flexDirection: "column" }}>
            {centerTabs.length === 0 ? (
              <Box sx={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 1 }}>
                <Typography variant="body2" color="text.secondary">Todas as abas foram movidas para o painel direito.</Typography>
                <Tooltip title="Mover tudo de volta">
                  <Chip label="Restaurar todas" size="small" onClick={() => { setCenterTabs([0,1,2,3]); setRightTabs([]); }} sx={{ cursor: "pointer" }} />
                </Tooltip>
              </Box>
            ) : (
              <>
                <Stack direction="row" alignItems="center" sx={{ borderBottom: "1px solid", borderColor: "divider", pr: 0.5 }}>
                  <Tabs value={Math.min(centerTab, centerTabs.length - 1)} onChange={(_e, v) => setCenterTab(v as number)}
                    sx={{ flex: 1, minHeight: 44 }}>
                    {centerTabs.map((tabId, idx) => (
                      <Tab key={tabId}
                        icon={TAB_ICONS[tabId] ?? undefined} iconPosition="start"
                        label={tabId === 2 && artifacts?.docs?.length ? `Documentos (${artifacts.docs.length})`
                          : tabId === 3 && codeFiles?.totalFiles ? `Código (${codeFiles.totalFiles})`
                          : TAB_LABELS[tabId]}
                        value={idx}
                        sx={{ minHeight: 44, textTransform: "none", fontWeight: 500, fontSize: "0.82rem", gap: 0.5 }}
                      />
                    ))}
                  </Tabs>
                  <Tooltip title="Mover aba para o painel direito">
                    <IconButton size="small" onClick={() => moveTabToRight(centerTabs[Math.min(centerTab, centerTabs.length - 1)])}
                      sx={{ p: 0.4, mr: 0.5, color: "text.secondary", "&:hover": { color: "primary.main" } }}>
                      <ChevronRightIcon sx={{ fontSize: "1rem" }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
                {renderTabContent(centerTabs[Math.min(centerTab, centerTabs.length - 1)])}
              </>
            )}
          </Card>
        </Box>

        {/* Drag handle center↔right — only when right panel open */}
        {tasksOpen && (
          <Box onMouseDown={(e) => startDrag("cr", e)}
            sx={{ width: 6, flexShrink: 0, cursor: "col-resize", alignSelf: "stretch",
              bgcolor: "transparent", "&:hover": { bgcolor: "primary.main" + "40" },
              transition: "background-color 0.15s", borderRadius: 1, mx: 0.25 }} />
        )}

        {/* ── RIGHT PANEL: Tasks + moved tabs (collapsible) ── */}
        {tasksOpen ? (
          <Box sx={{ width: `${colWidths.right}%`, flexShrink: 0, pl: 0.5 }}>
            <Card sx={{ height: "calc(100vh - 180px)", minHeight: 600, display: "flex", flexDirection: "column" }}>
              {/* Header: unified Tabs — Tasks first, then moved tabs */}
              <Stack direction="row" alignItems="center" sx={{ borderBottom: "1px solid", borderColor: "divider", pr: 0.5, flexShrink: 0 }}>
                <Tabs
                  value={rightActiveTab === -1 ? 0 : rightActiveTab + 1}
                  onChange={(_e, v) => {
                    const idx = v as number;
                    setRightActiveTab(idx === 0 ? -1 : idx - 1);
                  }}
                  sx={{ flex: 1, minHeight: 44 }}
                >
                  {/* Tasks always first tab */}
                  <Tab
                    label={<Stack direction="row" spacing={0.75} alignItems="center">
                      <span>Tasks</span>
                      {tasks && tasks.length > 0 && (
                        <Chip size="small" label={`${tasksDone}/${tasks.length}`}
                          color={tasksDone === tasks.length ? "success" : "default"}
                          sx={{ fontSize: "0.6rem", height: 16 }} />
                      )}
                    </Stack>}
                    value={0}
                    sx={{ minHeight: 44, textTransform: "none", fontSize: "0.78rem" }}
                  />
                  {/* Moved tabs */}
                  {rightTabs.map((tabId, idx) => (
                    <Tab key={tabId}
                      icon={TAB_ICONS[tabId] ?? undefined} iconPosition="start"
                      label={tabId === 2 && artifacts?.docs?.length ? `Docs (${artifacts.docs.length})`
                        : tabId === 3 && codeFiles?.totalFiles ? `Código (${codeFiles.totalFiles})`
                        : TAB_LABELS[tabId]}
                      value={idx + 1}
                      sx={{ minHeight: 44, textTransform: "none", fontSize: "0.75rem", gap: 0.5 }}
                    />
                  ))}
                </Tabs>
                {/* Move back — only when a moved tab is active */}
                {rightActiveTab >= 0 && (
                  <Tooltip title="Mover aba de volta para o centro">
                    <IconButton size="small" onClick={() => moveTabToCenter(rightTabs[rightActiveTab])}
                      sx={{ p: 0.4, color: "text.secondary", "&:hover": { color: "primary.main" } }}>
                      <ChevronLeftIcon sx={{ fontSize: "1rem" }} />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Recolher painel">
                  <IconButton size="small" onClick={() => setTasksOpen(false)}
                    sx={{ p: 0.4, border: "1px solid", borderColor: "divider", borderRadius: 1, ml: 0.5 }}>
                    <ChevronRightIcon sx={{ fontSize: "1rem" }} />
                  </IconButton>
                </Tooltip>
              </Stack>
              {/* Tasks — UNUSED below, keeping for reference only (removed) */}
              {/* Body: Tasks tab or moved tab content */}
              {rightActiveTab === -1 ? (
                <Box sx={{ flexGrow: 1, overflow: "hidden", display: "flex", flexDirection: "column", p: 0 }}>
                  {!tasks || tasks.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 3 }}>
                      {isRunning ? "Aguardando CTO → Engineer → PM para gerar tasks…" : "Nenhuma task registrada."}
                    </Typography>
                  ) : (
                    <>
                    <Box sx={{ flexGrow: 1, overflow: "auto" }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: "action.hover" }}>
                          <TableCell sx={{ width: 24, p: 0.5 }} />
                          <TableCell sx={{ fontSize: "0.68rem", fontWeight: 700 }}>Task</TableCell>
                          <TableCell sx={{ fontSize: "0.68rem", fontWeight: 700 }}>Descrição</TableCell>
                          <TableCell sx={{ width: 100, fontSize: "0.68rem", fontWeight: 700 }}>Status</TableCell>
                          <TableCell sx={{ width: 140, textAlign: "right", fontSize: "0.68rem", fontWeight: 700 }}>Tokens · Custo</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {tasks.map((t) => {
                          const isDoneT   = t.status === "DONE" || t.status === "QA_PASS";
                          const isActiveT = t.status === "IN_PROGRESS" || t.status === "WAITING_REVIEW";
                          const m = taskMetrics[t.taskId ?? ""];
                          const tid = t.taskId ?? "";
                          const logsForTask = taskLogs?.rows.filter(r => r.taskId === tid) ?? [];
                          const isExpanded = logsExpanded === tid;
                          return (
                            <>
                            <TableRow key={t.id}
                              sx={{ bgcolor: isActiveT ? "primary.main" + "08" : isDoneT ? "success.main" + "06" : "transparent",
                                    cursor: logsForTask.length > 0 ? "pointer" : "default" }}
                              onClick={() => logsForTask.length > 0 && setLogsExpanded(isExpanded ? null : tid)}>
                              <TableCell sx={{ p: 0.5, textAlign: "center" }}>
                                {logsForTask.length > 0 && (
                                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>
                                    {isExpanded ? "▲" : "▼"}
                                  </Typography>
                                )}
                              </TableCell>
                              <TableCell><Typography variant="caption" fontFamily="monospace" noWrap sx={{ fontSize: "0.7rem" }}>{tid}</Typography></TableCell>
                              <TableCell>
                                <Typography variant="body2" sx={{ fontSize: "0.73rem" }}>{t.requirements ?? "—"}</Typography>
                              </TableCell>
                              <TableCell>
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  <Chip size="small" label={t.status ?? "—"}
                                    color={TASK_STATUS_COLOR[t.status ?? ""] ?? "default"}
                                    sx={{ fontFamily: "monospace", fontSize: "0.6rem" }} />
                                  {isActiveT && <CircularProgress size={10} color="primary" />}
                                </Stack>
                              </TableCell>
                              <TableCell sx={{ textAlign: "right" }}>
                                {m ? (
                                  <Stack alignItems="flex-end" spacing={0.1}>
                                    <Typography variant="caption" sx={{ fontSize: "0.63rem", color: "text.secondary", fontFamily: "monospace" }}>
                                      {m.totalTokens.toLocaleString("pt-BR")} tok · {m.calls}×
                                    </Typography>
                                    <Typography variant="caption" sx={{ fontSize: "0.63rem", color: "success.main", fontFamily: "monospace", fontWeight: 700 }}>
                                      ~${m.estimatedCostUsd.toFixed(3)}
                                    </Typography>
                                  </Stack>
                                ) : (
                                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.6rem" }}>—</Typography>
                                )}
                              </TableCell>
                            </TableRow>
                            {/* Log expandido por task */}
                            {isExpanded && logsForTask.length > 0 && (
                              <TableRow key={`${t.id}-logs`} sx={{ bgcolor: "#0D0F14" }}>
                                <TableCell colSpan={5} sx={{ p: 0, pb: 0.5 }}>
                                  <Table size="small" sx={{ "& td, & th": { fontSize: "0.62rem", py: 0.4, px: 1 } }}>
                                    <TableHead>
                                      <TableRow sx={{ bgcolor: "#161B22" }}>
                                        <TableCell sx={{ color: "#6B7280" }}>Agente</TableCell>
                                        <TableCell sx={{ color: "#6B7280" }}>Round</TableCell>
                                        <TableCell sx={{ color: "#6B7280" }}>Modelo</TableCell>
                                        <TableCell sx={{ color: "#6B7280", textAlign: "right" }}>In tok</TableCell>
                                        <TableCell sx={{ color: "#6B7280", textAlign: "right" }}>Out tok</TableCell>
                                        <TableCell sx={{ color: "#6B7280", textAlign: "right" }}>Tempo</TableCell>
                                        <TableCell sx={{ color: "#6B7280", textAlign: "right" }}>USD</TableCell>
                                        <TableCell sx={{ color: "#6B7280" }}>Status</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {logsForTask.map((log) => (
                                        <TableRow key={log.id} sx={{ "&:hover": { bgcolor: "#161B22" } }}>
                                          <TableCell sx={{ fontFamily: "monospace", color: "#8B949E" }}>{log.agent}</TableCell>
                                          <TableCell sx={{ fontFamily: "monospace", color: "#6B7280" }}>#{log.round}</TableCell>
                                          <TableCell>
                                            <ModelBadge model={log.model ?? (log.isOpus ? "opus" : "sonnet")} />
                                          </TableCell>
                                          <TableCell sx={{ textAlign: "right", fontFamily: "monospace", color: "#8B949E" }}>
                                            {log.inputTokens.toLocaleString("pt-BR")}
                                          </TableCell>
                                          <TableCell sx={{ textAlign: "right", fontFamily: "monospace", color: "#8B949E" }}>
                                            {log.outputTokens.toLocaleString("pt-BR")}
                                          </TableCell>
                                          <TableCell sx={{ textAlign: "right", fontFamily: "monospace", color: "#6B7280" }}>
                                            {log.durationSec}s
                                          </TableCell>
                                          <TableCell sx={{ textAlign: "right", fontFamily: "monospace", color: "#22c55e", fontWeight: 600 }}>
                                            ${log.estimatedCostUsd.toFixed(4)}
                                          </TableCell>
                                          <TableCell>
                                            <Chip size="small" label={log.status ?? "—"}
                                              sx={{ fontSize: "0.55rem", height: 14,
                                                bgcolor: log.status === "QA_PASS" || log.status === "OK" ? "#22c55e22" :
                                                         log.status === "QA_FAIL" ? "#ef444422" : "#6b728022",
                                                color: log.status === "QA_PASS" || log.status === "OK" ? "#22c55e" :
                                                       log.status === "QA_FAIL" ? "#ef4444" : "#6b7280" }} />
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </TableCell>
                              </TableRow>
                            )}
                            </>
                          );
                        })}
                      </TableBody>
                    </Table>
                    </Box>
                    {/* Rodapé cumulativo — fixo fora do scroll */}
                    {taskLogs && taskLogs.totals.calls > 0 && (
                      <Box sx={{ flexShrink: 0, borderTop: "2px solid", borderColor: "divider", bgcolor: "action.selected" }}>
                        <Table size="small">
                          <TableBody>
                            <TableRow>
                              <TableCell sx={{ width: 24, p: 0.5 }} />
                              <TableCell colSpan={2} sx={{ fontSize: "0.68rem", fontWeight: 700, color: "text.secondary" }}>
                                TOTAL — {taskLogs.totals.calls} chamadas · {Math.round(taskLogs.totals.durationSec / 60)}min
                              </TableCell>
                              <TableCell sx={{ width: 100 }} />
                              <TableCell sx={{ width: 140, textAlign: "right" }}>
                                <Stack alignItems="flex-end" spacing={0.1}>
                                  <Typography variant="caption" sx={{ fontSize: "0.63rem", fontFamily: "monospace", fontWeight: 700 }}>
                                    {taskLogs.totals.tokens.toLocaleString("pt-BR")} tok
                                  </Typography>
                                  <Typography variant="caption" sx={{ fontSize: "0.7rem", color: "success.main", fontFamily: "monospace", fontWeight: 700 }}>
                                    USD {taskLogs.totals.costUsd.toFixed(2)}
                                  </Typography>
                                </Stack>
                              </TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </Box>
                    )}
                    </>
                  )}
                </Box>
              ) : (
                renderTabContent(rightTabs[rightActiveTab])
              )}
            </Card>
          </Box>
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", height: "calc(100vh - 180px)", minHeight: 600 }}>
            <Tooltip title="Abrir painel direito" placement="left">
              <Box onClick={() => setTasksOpen(true)} sx={{
                cursor: "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 1,
                width: 28, height: "100%", bgcolor: "background.paper",
                border: "1px solid", borderColor: "divider", borderRadius: 1,
                "&:hover": { borderColor: "primary.main", bgcolor: "primary.main" + "08" },
                transition: "all 0.15s",
              }}>
                <ChevronLeftIcon sx={{ fontSize: "1rem", color: "text.secondary" }} />
                <Typography variant="caption" color="text.secondary"
                  sx={{ fontSize: "0.6rem", writingMode: "vertical-rl", textOrientation: "mixed", letterSpacing: "0.05em" }}>
                  {rightTabs.length > 0 ? TAB_LABELS[rightTabs[0]] : `Tasks ${tasks?.length ? `${tasksDone}/${tasks.length}` : ""}`}
                </Typography>
              </Box>
            </Tooltip>
          </Box>
        )}
      </Box>

      {/* Doc viewer modal */}
      {docModal && (
        <DocViewerModal
          projectId={id}
          filename={docModal.filename}
          title={docModal.title}
          open={!!docModal}
          onClose={() => setDocModal(null)}
        />
      )}
    </Box>
  );
}

export default observer(ProjectDetailPageInner);
