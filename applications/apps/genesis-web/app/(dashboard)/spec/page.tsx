"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Fab from "@mui/material/Fab";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Autocomplete from "@mui/material/Autocomplete";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import HistoryIcon from "@mui/icons-material/History";
import PreviewIcon from "@mui/icons-material/Preview";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import SendIcon from "@mui/icons-material/Send";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import NoteAddOutlinedIcon from "@mui/icons-material/NoteAddOutlined";
import PostAddOutlinedIcon from "@mui/icons-material/PostAddOutlined";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPostMultipart, apiPut, withQuery } from "@/lib/api";
import { projectsStore } from "@/stores/projectsStore";
import { authStore } from "@/stores/authStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
// Padronização das ações de fábrica (revisão adversarial da Bancada, 2026-09-06): rótulos, tooltips
// e texto de confirmação vivem em UM lugar — três telas diziam coisas diferentes para a MESMA ação.
import {
  FACTORY_LABEL, FACTORY_TOOLTIP, PROMOTE_CONFIRM_WORD, PROMOTED_SPEC_NOTICE,
  promoteButtonLabel, promoteConfirmBody, promotedProductNotice, type PromoteScope,
} from "@/lib/factoryActions";
import { DecomposeDialog, describeEstimate, estimateProposal, type DecomposeSpecRef } from "@/components/DecomposeDialog";
// UI/UX 2026-09-06 — `SpecTreePanel` (a segunda lista de arquivos, com editor próprio) saiu daqui:
// a lista única é o `ProductFolderNav` abaixo e o editor é o desta página. O arquivo do componente
// permanece no repo (não é papel desta frente apagá-lo), mas já não tem nenhum importador.
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import SpecValidationPanel from "@/components/SpecValidationPanel";
import ConnectReadyChecklist from "@/components/ConnectReadyChecklist";
import SpecSplitPanel from "@/components/SpecSplitPanel";
import SpecCodeEditor from "@/components/SpecCodeEditor";
import SpecVersionsPanel from "@/components/SpecVersionsPanel";
import ProductFolderNav from "@/components/ProductFolderNav";
// Rastreabilidade (Jean, 2026-09-07): os três relatórios em PDF. O produto é o DONO da spec aberta
// (`ownerProduct`, fonte autoritativa) — o mesmo objeto que a Fábrica reporta em /products.
import { TraceabilityReportsButton } from "@/components/TraceabilityReports";
import {
  PromotionPlanDialog, describeStartResult,
  type PromotionPlanItem, type PromotionPlanMeta, type StartWaveResult,
} from "@/components/PromotionPlanDialog";

// Lazy-load react-markdown with GFM (tables, strikethrough, task lists)
const ReactMarkdown = dynamic(
  () => Promise.all([import("react-markdown"), import("remark-gfm")])
    .then(([md, gfm]) => {
      const Comp = ({ children, components }: { children: string; components?: Record<string, unknown> }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (md.default as any)({ remarkPlugins: [gfm.default], children, components });
      Comp.displayName = "ReactMarkdownGFM";
      return { default: Comp };
    }),
  { ssr: false }
);

// ── Mermaid block renderer ────────────────────────────────────────────────────
function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    if (!ref.current) return;
    import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
      mermaid.render(idRef.current, code).then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg;
      }).catch(() => {
        if (ref.current) ref.current.innerHTML = `<pre style="font-size:0.72rem;color:#8B949E">${code}</pre>`;
      });
    });
  }, [code]);

  return <Box ref={ref} sx={{ my: 1.5, "& svg": { maxWidth: "100%", height: "auto" } }} />;
}

const ACCEPT = ".md,.txt,.doc,.docx,.pdf,.zip";
// Teto do plugin multipart da API (app.ts: fileSize 10 MiB, files 10) — checado no cliente
// para uma mensagem clara em vez de um 413 opaco.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
// Onda 4 — preferência "Decompor em produto após salvar" lembrada por navegador.
const DECOMPOSE_ON_UPLOAD_KEY = "genesis.spec.decomposeOnUpload";
// Flags de UI vêm da API (G13/D-4.3: NUNCA NEXT_PUBLIC_* — a mesma imagem serve dev e prod).
// Ausente → false (fail-closed).
type UiFeatures = { specUploadDecompose: boolean; dashboardKpis: boolean };
const NO_FEATURES: UiFeatures = { specUploadDecompose: false, dashboardKpis: false };

// INTAKE-GATE: mínimo de caracteres da descrição em texto livre (espelha o backend intakeGate.ts).
const MIN_FREE_TEXT_CHARS = 500;

interface ProjectTypeOption { value: string; label: string; group: string }

const PROJECT_TYPES: ProjectTypeOption[] = [
  // ── Backend ────────────────────────────────────────────────────────────────
  { group: "Backend",   value: "backend_api",           label: "🔌 API REST (Node)"                 },
  { group: "Backend",   value: "backend_api_python",     label: "🐍 API REST (Python)"               },
  { group: "Backend",   value: "backend_graphql",        label: "🔗 API GraphQL"                     },
  { group: "Backend",   value: "backend_grpc",           label: "⚡ API gRPC"                        },
  { group: "Backend",   value: "backend_websocket",      label: "🌐 WebSocket / Realtime"            },
  { group: "Backend",   value: "backend_serverless",     label: "☁️ Serverless (Lambda / Functions)" },
  { group: "Backend",   value: "backend_microservice",   label: "🔧 Microsserviço"                   },
  { group: "Backend",   value: "backend_worker",         label: "🤖 Worker / Job agendado (cron/queue)" },
  { group: "Backend",   value: "backend_data_pipeline",  label: "🔄 Pipeline de Dados / ETL"        },
  { group: "Backend",   value: "backend_event_driven",   label: "📨 Event-Driven / Message Bus"     },
  { group: "Backend",   value: "backend_auth_service",   label: "🔐 Serviço de Autenticação / IAM"  },
  { group: "Backend",   value: "backend_notification",   label: "🔔 Serviço de Notificações"        },
  { group: "Backend",   value: "backend_file_storage",   label: "📂 Serviço de Armazenamento"       },
  { group: "Backend",   value: "backend_search",         label: "🔍 Serviço de Busca / Indexação"   },
  { group: "Backend",   value: "backend_payment",        label: "💳 Serviço de Pagamentos"          },
  { group: "Backend",   value: "backend_cms_api",        label: "📝 CMS Headless / Content API"     },
  { group: "Backend",   value: "backend_analytics_api",  label: "📊 API de Analytics / Métricas"    },
  { group: "Backend",   value: "backend_ai_ml",          label: "🧠 API de IA / ML / LLM"           },

  // ── Frontend ───────────────────────────────────────────────────────────────
  { group: "Frontend",  value: "frontend_webapp",        label: "🎨 Web App (SPA)"                  },
  { group: "Frontend",  value: "frontend_pwa",           label: "📱 Progressive Web App (PWA)"      },
  { group: "Frontend",  value: "frontend_landing",       label: "🏠 Landing Page"                   },
  { group: "Frontend",  value: "frontend_institutional", label: "🏢 Site Institucional / Portfólio" },
  { group: "Frontend",  value: "frontend_blog",          label: "📰 Blog / Portal de Conteúdo"      },
  { group: "Frontend",  value: "frontend_ecommerce",     label: "🛒 E-commerce (Frontend)"          },
  { group: "Frontend",  value: "frontend_dashboard",     label: "📊 Dashboard / Admin Panel"        },
  { group: "Frontend",  value: "frontend_design_system", label: "🎨 Design System / Component Lib"  },

  // ── Fullstack ──────────────────────────────────────────────────────────────
  { group: "Fullstack", value: "fullstack_webapp",       label: "🖥️ Web App Fullstack"             },
  { group: "Fullstack", value: "fullstack_saas",         label: "☁️ Plataforma SaaS"               },
  { group: "Fullstack", value: "fullstack_ecommerce",    label: "🛒 E-commerce Completo"            },
  { group: "Fullstack", value: "fullstack_erp",          label: "🏢 ERP / Sistema Interno"          },
  { group: "Fullstack", value: "fullstack_marketplace",  label: "🏪 Marketplace"                    },
  { group: "Fullstack", value: "fullstack_crm",          label: "👥 CRM / Gestão de Clientes"       },
  { group: "Fullstack", value: "fullstack_lms",          label: "🎓 Plataforma EAD / LMS"           },
  { group: "Fullstack", value: "fullstack_fintech",      label: "💰 Fintech / Banco Digital"        },
  { group: "Fullstack", value: "fullstack_healthtech",   label: "🏥 Healthtech / Telemedicina"      },
  { group: "Fullstack", value: "fullstack_proptech",     label: "🏠 Proptech / Imobiliário"         },

  // ── Mobile ─────────────────────────────────────────────────────────────────
  { group: "Mobile",    value: "mobile_crossplatform",   label: "📱 App Mobile Multiplataforma (RN/Flutter)" },
  { group: "Mobile",    value: "mobile_ios",             label: "🍎 App iOS Nativo (Swift)"         },
  { group: "Mobile",    value: "mobile_android",         label: "🤖 App Android Nativo (Kotlin)"    },

  // ── Infra / DevOps ─────────────────────────────────────────────────────────
  { group: "Infra / DevOps", value: "infra_iac",         label: "🏗️ IaC / Infraestrutura (Terraform/CDK)" },
  { group: "Infra / DevOps", value: "infra_cicd",        label: "🔄 Pipeline CI/CD"                 },
  { group: "Infra / DevOps", value: "infra_monitoring",  label: "📡 Observabilidade / Monitoring"   },
  { group: "Infra / DevOps", value: "infra_data_lake",   label: "🗄️ Data Lake / Data Warehouse"    },

  // ── Automação / Bots ───────────────────────────────────────────────────────
  { group: "Automação / Bots", value: "bot_chat",        label: "🤖 Chatbot (Telegram/Discord/WhatsApp)" },
  { group: "Automação / Bots", value: "bot_scraper",     label: "🕷️ Web Scraper / Crawler"         },
  { group: "Automação / Bots", value: "bot_automation",  label: "⚙️ Automação / RPA"               },
  { group: "Automação / Bots", value: "integration",     label: "🔌 Integração / Conector de APIs"  },

  // ── Biblioteca / SDK ───────────────────────────────────────────────────────
  { group: "Biblioteca / SDK", value: "lib_sdk",         label: "📦 SDK / Biblioteca / Package"     },
  { group: "Biblioteca / SDK", value: "lib_cli",         label: "⌨️ CLI / Ferramenta de linha de comando" },
  { group: "Biblioteca / SDK", value: "lib_plugin",      label: "🔧 Plugin / Extensão"              },

  // ── Outro ──────────────────────────────────────────────────────────────────
  { group: "Outro",     value: "other",                  label: "📦 Outro / Não listado"            },
];

function ProjectTypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = PROJECT_TYPES.find(t => t.value === value) ?? null;
  return (
    <Autocomplete
      size="small"
      options={PROJECT_TYPES}
      groupBy={(o) => o.group}
      getOptionLabel={(o) => o.label}
      value={selected}
      onChange={(_e, v) => onChange(v?.value ?? "")}
      isOptionEqualToValue={(o, v) => o.value === v.value}
      renderInput={(params) => (
        <TextField {...params} label="Tipo do projeto" required
          placeholder="Digite para filtrar…" sx={{ mb: 2 }} />
      )}
      renderGroup={(params) => (
        <li key={params.key}>
          <div style={{ padding: "4px 12px 2px", fontSize: "0.65rem", fontWeight: 700,
            textTransform: "uppercase", letterSpacing: "0.08em", color: "#8B949E" }}>
            {params.group}
          </div>
          <ul style={{ padding: 0 }}>{params.children}</ul>
        </li>
      )}
      slotProps={{ paper: { sx: { maxHeight: 320 } } }}
      clearOnEscape
      sx={{ mb: 0 }}
    />
  );
}
// DM-T2/UX: pergunta de topo (o que quer receber?) + avançado. Para TODOS os tipos,
// respeitando o tipo: backend/fullstack → source_only/demo/production; web/frontend →
// source_only/publish (S3). "publish" preserva o comportamento antigo do S3.
const DELIVERY_MODES_BACKEND = [
  { value: "source_only", icon: "📦", label: "Só o código", desc: "Repo testado + kit de deploy (Docker/Terraform/k8s). Você provisiona." },
  { value: "demo",        icon: "🧪", label: "Demo",         desc: "Link pra testar, descartável, sem custo de infra." },
  { value: "production",  icon: "🚀", label: "Produção",     desc: "Sistema pra valer: dados persistentes, HTTPS, banco gerenciado." },
];
const DELIVERY_MODES_WEB = [
  { value: "source_only", icon: "📦", label: "Só o código", desc: "Repo testado + kit de deploy (Docker/estático). Você publica onde quiser." },
  { value: "publish",     icon: "🌐", label: "Publicar (S3)", desc: "Site publicado com URL pública (hospedagem estática S3)." },
];
// ── Deploy na nuvem: pré-seleção no envio da spec (Item 2) ──────────────────────
// Espelha `viableFormatsForProjectType` do backend (services/provision/deployTargets.ts):
// só os formatos que fazem sentido para o tipo do projeto. É um DEFAULT — pode ser trocado
// depois no cockpit (/projects/:id). Duplicação intencional e localizada (cliente sem backend).
type DeployFmt = "container" | "static" | "vm" | "serverless";
function viableDeployFormats(projectType: string): DeployFmt[] {
  const pt = (projectType ?? "").toLowerCase().trim();
  if (!pt) return [];
  if (pt.startsWith("mobile") || pt.startsWith("lib") || pt.startsWith("infra")) return [];
  if (pt === "other" || pt === "_default") return ["container", "static"];
  if (pt.startsWith("fullstack")) return ["container", "vm"];
  if (pt.startsWith("frontend") || pt.includes("landing") || pt.includes("static") || pt.includes("dashboard") || pt.includes("ecommerce")) return ["static", "container"];
  if (pt.startsWith("backend")) { return pt.includes("worker") ? ["serverless", "container"] : ["container", "vm", "serverless"]; }
  if (pt.startsWith("bot")) return ["serverless", "container"];
  return ["container", "static"];
}
const FMT_GENERIC: Record<DeployFmt, string> = {
  container: "Container", static: "Site estático", vm: "Máquina virtual (VM)", serverless: "Serverless",
};
const PROVIDER_FMT_LABELS: Record<string, Record<DeployFmt, string>> = {
  aws:   { container: "ECS Fargate (ECR)", static: "S3 static website", vm: "EC2 (via SSM)", serverless: "Lambda" },
  azure: { container: "Container Apps (ACR)", static: "Static Web Apps / Blob", vm: "Virtual Machine", serverless: "Azure Functions" },
  gcp:   { container: "Cloud Run (GCR)", static: "Cloud Storage website", vm: "Compute Engine", serverless: "Cloud Functions" },
};
const CLOUD_PROVIDER_LABEL: Record<string, string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud" };

interface DeliverySectionProps {
  visible: boolean;
  isBackend: boolean;
  mode: string; onMode: (v: string) => void;
  // Item 2: pré-seleção de deploy na nuvem (conexão + formato + prazo p/ demo).
  projectType: string;
  cloudConnections: Array<{ id: string; provider: string; label: string | null }>;
  cloudConnId: string; onCloudConn: (v: string) => void;
  deployFormat: string; onDeployFormat: (v: string) => void;
  deployTtlDays: number; onDeployTtlDays: (v: number) => void;
  advancedOpen: boolean; onAdvancedOpen: (v: boolean) => void;
  dbMode: string; onDbMode: (v: string) => void;
  runtimeTarget: string; onRuntimeTarget: (v: string) => void;
  domainMode: string; onDomainMode: (v: string) => void;
  // Item 3: Ferramentas UI/UX — conta conectada + arquivos Figma escolhidos (por URL).
  uiuxConnections: Array<{ id: string; provider: string; label: string | null }>;
  uiuxConnId: string; onUiuxConn: (v: string) => void;
  uiuxSelectedProvider: string;
  // Figma: arquivos resolvidos {id: fileKey, name}; uiuxProjectIds carrega as fileKeys escolhidas.
  uiuxProjects: Array<{ id: string; name: string }>;
  uiuxProjectIds: string[]; onUiuxProjectIds: (v: string[]) => void;
  uiuxLoadingProjects: boolean;
  uiuxProjectsError: string | null;
  onUiuxAddFigma: (url: string) => void;
  onUiuxRemoveFigma: (key: string) => void;
}
function DeliverySection(p: DeliverySectionProps) {
  const [figmaUrl, setFigmaUrl] = useState("");
  if (!p.visible) return null;
  const modes = p.isBackend ? DELIVERY_MODES_BACKEND : DELIVERY_MODES_WEB;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.06em", color: "#8B949E", mb: 1 }}>
        O que você quer receber?
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1 }}>
        {modes.map((m) => {
          const active = p.mode === m.value;
          return (
            <Card key={m.value} onClick={() => p.onMode(m.value)}
              sx={{ flex: 1, cursor: "pointer", p: 1.2, border: "2px solid",
                borderColor: active ? "primary.main" : "divider",
                bgcolor: active ? "action.selected" : "background.paper",
                transition: "border-color .15s" }}>
              <div style={{ fontSize: "1.1rem" }}>{m.icon} <strong style={{ fontSize: "0.85rem" }}>{m.label}</strong></div>
              <div style={{ fontSize: "0.72rem", color: "#8B949E", marginTop: 2 }}>{m.desc}</div>
            </Card>
          );
        })}
      </Stack>
      {/* Item 2: onde e como publicar — pré-seleção (default do cockpit). Só aparece quando o
          tipo é publicável na nuvem E existe conexão de cloud configurada. */}
      {(() => {
        const viable = viableDeployFormats(p.projectType);
        if (viable.length === 0 || p.cloudConnections.length === 0) return null;
        const activeConn = p.cloudConnections.find((c) => c.id === p.cloudConnId) ?? null;
        const fmtLabel = (f: DeployFmt) =>
          activeConn ? PROVIDER_FMT_LABELS[activeConn.provider]?.[f] ?? FMT_GENERIC[f] : FMT_GENERIC[f];
        return (
          <Box sx={{ mb: 1 }}>
            <Typography sx={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.06em", color: "#8B949E", mb: 1 }}>
              Onde publicar (opcional — dá pra trocar depois)
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>Nuvem (conexão)</InputLabel>
                <Select value={p.cloudConnId} label="Nuvem (conexão)"
                  onChange={(e) => { p.onCloudConn(e.target.value); p.onDeployFormat(""); }}>
                  <MenuItem value="">Decidir depois</MenuItem>
                  {p.cloudConnections.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {CLOUD_PROVIDER_LABEL[c.provider] ?? c.provider}{c.label ? ` · ${c.label}` : ""}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth disabled={!p.cloudConnId}>
                <InputLabel>Tipo de deploy</InputLabel>
                <Select value={viable.includes(p.deployFormat as DeployFmt) ? p.deployFormat : ""}
                  label="Tipo de deploy" onChange={(e) => p.onDeployFormat(e.target.value)}>
                  <MenuItem value="">Recomendado</MenuItem>
                  {viable.map((f, i) => (
                    <MenuItem key={f} value={f}>{fmtLabel(f)}{i === 0 ? " · recomendado" : ""}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            {p.mode === "demo" && (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} sx={{ mb: 1 }}>
                <TextField size="small" type="number" label="Demo expira em (dias, 1–30)"
                  value={p.deployTtlDays}
                  onChange={(e) => p.onDeployTtlDays(Math.min(Math.max(Math.round(Number(e.target.value) || 0), 1), 30))}
                  inputProps={{ min: 1, max: 30, step: 1 }} sx={{ width: { xs: "100%", sm: 220 } }} />
                <Typography sx={{ fontSize: "0.72rem", color: "#8B949E" }}>
                  Demo é removida automaticamente ao fim do prazo (você confirma o teardown no disparo).
                </Typography>
              </Stack>
            )}
          </Box>
        );
      })()}
      {p.uiuxConnections.length > 0 && (
        <>
          <FormControl size="small" fullWidth sx={{ mb: 1 }}>
            <InputLabel>Ferramenta UI/UX (opcional)</InputLabel>
            <Select value={p.uiuxConnId} label="Ferramenta UI/UX (opcional)"
              onChange={(e) => p.onUiuxConn(e.target.value)}>
              <MenuItem value="">Nenhuma</MenuItem>
              {p.uiuxConnections.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.label ? `${c.label} · ${c.provider}` : c.provider}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {p.uiuxConnId && p.uiuxSelectedProvider === "canva" && (
            <Typography sx={{ fontSize: "0.72rem", color: "#D29922", mb: 1 }}>
              Extração Canva em breve (requer app OAuth registrado). Selecione uma conta Figma para extrair as definições de UI/UX.
            </Typography>
          )}
          {p.uiuxConnId && p.uiuxSelectedProvider === "figma" && (
            <Box sx={{ mb: 1 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1 }}>
                <TextField size="small" fullWidth label="URL do arquivo Figma"
                  placeholder="https://www.figma.com/design/…"
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && figmaUrl.trim()) {
                      e.preventDefault();
                      p.onUiuxAddFigma(figmaUrl.trim());
                      setFigmaUrl("");
                    }
                  }} />
                <Button size="small" variant="outlined"
                  disabled={!figmaUrl.trim() || p.uiuxLoadingProjects}
                  onClick={() => { p.onUiuxAddFigma(figmaUrl.trim()); setFigmaUrl(""); }}>
                  Adicionar
                </Button>
              </Stack>
              {p.uiuxProjects.length > 0 && (
                <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5, mb: 1 }}>
                  {p.uiuxProjects.map((f) => (
                    <Chip key={f.id} label={f.name} size="small" onDelete={() => p.onUiuxRemoveFigma(f.id)} />
                  ))}
                </Stack>
              )}
              {p.uiuxLoadingProjects && (
                <Typography sx={{ fontSize: "0.72rem", color: "#8B949E", mb: 1 }}>Lendo arquivo no Figma…</Typography>
              )}
              {p.uiuxProjectsError && (
                <Typography sx={{ fontSize: "0.72rem", color: "#F85149", mb: 1 }}>{p.uiuxProjectsError}</Typography>
              )}
              <Typography sx={{ fontSize: "0.7rem", color: "#8B949E" }}>
                No Figma: abra o arquivo › Compartilhar › Copiar link e cole aqui. O token precisa do escopo
                “Leia o conteúdo de arquivos e renderize imagens a partir deles”.
              </Typography>
            </Box>
          )}
        </>
      )}
      {p.isBackend && (
      <Button size="small" variant="text" onClick={() => p.onAdvancedOpen(!p.advancedOpen)}
        sx={{ fontSize: "0.72rem", textTransform: "none", color: "text.secondary" }}>
        {p.advancedOpen ? "▲ Ocultar avançado" : "▼ Avançado (opcional)"}
      </Button>
      )}
      {p.isBackend && p.advancedOpen && (
        <Stack spacing={1.5} sx={{ mt: 1, pl: 0.5 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Banco de dados</InputLabel>
            <Select value={p.dbMode} label="Banco de dados" onChange={(e) => p.onDbMode(e.target.value)}>
              <MenuItem value="">Automático (recomendado)</MenuItem>
              <MenuItem value="rds">RDS gerenciado</MenuItem>
              <MenuItem value="sidecar">Junto com o backend (sidecar)</MenuItem>
              <MenuItem value="none">Sem banco</MenuItem>
              <MenuItem value="external">Banco externo (informo DATABASE_URL)</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Compute</InputLabel>
            <Select value={p.runtimeTarget} label="Compute" onChange={(e) => p.onRuntimeTarget(e.target.value)}>
              <MenuItem value="">Fargate (padrão)</MenuItem>
              <MenuItem value="app_runner">App Runner</MenuItem>
              <MenuItem value="ec2">EC2</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Domínio</InputLabel>
            <Select value={p.domainMode} label="Domínio" onChange={(e) => p.onDomainMode(e.target.value)}>
              <MenuItem value="">Subdomínio Zentriz automático</MenuItem>
              <MenuItem value="custom">Meu domínio (configuro CNAME)</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      )}
    </Box>
  );
}
const RELATION_LABELS: Record<string, string> = {
  uses_backend: "🔌 Consome backend",
  shares_auth:  "🔐 Compartilha autenticação",
  shares_db:    "🗄️ Compartilha banco de dados",
  depends_on:   "➡️ Depende de",
  related:      "🔗 Relacionado",
  part_of:      "🧩 Componente de",
};

interface ProductLinkSectionProps {
  products: { id: string; name: string; is_inbox?: boolean }[];
  productId: string; onProductId: (v: string) => void;
  onProductsReload: () => void;
  allProjects: { id: string; title: string; status: string }[];
  linkProjectId: string; onLinkProjectId: (v: string) => void;
  linkRelation: string; onLinkRelation: (v: string) => void;
}
function ProductLinkSection({ products, productId, onProductId, onProductsReload, allProjects, linkProjectId, onLinkProjectId, linkRelation, onLinkRelation }: ProductLinkSectionProps) {
  const [newProductName, setNewProductName] = useState("");
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [showNewProduct, setShowNewProduct] = useState(false);

  const handleCreateProduct = async () => {
    if (!newProductName.trim()) return;
    setCreatingProduct(true);
    try {
      const { apiPost: post } = await import("@/lib/api");
      const created = await post<{ id: string; name: string }>("/api/products", { name: newProductName.trim() });
      onProductId(created.id);
      onProductsReload();
      setNewProductName("");
      setShowNewProduct(false);
    } catch {
      // silencioso — produto não criado
    } finally {
      setCreatingProduct(false);
    }
  };

  return (
    <Box sx={{ mt: 0.5, mb: 2, p: 2, border: "1px solid", borderColor: "divider", borderRadius: 1, bgcolor: "action.hover" }}>
      <Typography variant="caption" color="text.secondary"
        sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5, fontSize: "0.6rem" }}>
        🧩 Produto &amp; Relações (opcional)
      </Typography>

      {/* Produto — Select + botão [+] para criar novo */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <FormControl fullWidth size="small">
          <InputLabel>Adicionar a um produto</InputLabel>
          <Select value={productId} label="Adicionar a um produto" onChange={(e) => onProductId(e.target.value)}>
            {/* §5.3: sem "Nenhum/standalone" — todo App pertence a um produto. O INBOX "Rascunhos"
                aparece rotulado; se a lista não trouxe o inbox, injeta opção sintética com value ""
                (sentinela → o backend resolve para o INBOX do tenant). */}
            {!products.some((p) => p.is_inbox) && (
              <MenuItem value=""><em>Rascunhos (inbox)</em></MenuItem>
            )}
            {products.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.is_inbox ? <em>Rascunhos (inbox)</em> : p.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Tooltip title="Criar novo produto">
          <IconButton size="small" onClick={() => setShowNewProduct(v => !v)} color={showNewProduct ? "primary" : "default"}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {showNewProduct && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <TextField
            size="small" fullWidth autoFocus
            label="Nome do novo produto"
            value={newProductName}
            onChange={e => setNewProductName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreateProduct()}
            placeholder="Ex: E-commerce de Cosméticos"
          />
          <Button size="small" variant="contained" disabled={!newProductName.trim() || creatingProduct} onClick={handleCreateProduct}>
            {creatingProduct ? "…" : "Criar"}
          </Button>
          <Button size="small" onClick={() => { setShowNewProduct(false); setNewProductName(""); }}>Cancelar</Button>
        </Stack>
      )}
      {!showNewProduct && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5, fontSize: "0.68rem", lineHeight: 1.5 }}>
          Um produto agrupa projetos relacionados (backend + frontend + mobile do mesmo sistema).
          Deixe em <em>Rascunhos (inbox)</em> se ainda não sabe onde organizar — dá para mover depois.
        </Typography>
      )}

      <Divider sx={{ mb: 1.5 }} />

      {/* Link a outro projeto */}
      <FormControl fullWidth size="small" sx={{ mb: 1 }}>
        <InputLabel>Linkar a um projeto existente</InputLabel>
        <Select value={linkProjectId} label="Linkar a um projeto existente" onChange={(e) => onLinkProjectId(e.target.value)}>
          <MenuItem value=""><em>Nenhum</em></MenuItem>
          {allProjects.map((p) => <MenuItem key={p.id} value={p.id}>{p.title} <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>({p.status})</Typography></MenuItem>)}
        </Select>
      </FormControl>
      {linkProjectId && (
        <FormControl fullWidth size="small" sx={{ mt: 1 }}>
          <InputLabel>Tipo de relação</InputLabel>
          <Select value={linkRelation} label="Tipo de relação" onChange={(e) => onLinkRelation(e.target.value)}>
            {Object.entries(RELATION_LABELS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </Select>
        </FormControl>
      )}
      {linkProjectId ? (
        <Typography variant="caption" color="success.main" sx={{ display: "block", mt: 1, fontSize: "0.68rem", lineHeight: 1.5 }}>
          ✅ O CTO receberá o contexto do projeto linkado (api_contract, endpoints, porta) ao gerar o charter — sem criar banco ou API próprios.
        </Typography>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1, fontSize: "0.68rem", lineHeight: 1.5 }}>
          ⚠️ Se este projeto consome um backend existente, linke-o acima — o Genesis usará o contrato da API automaticamente.
        </Typography>
      )}
    </Box>
  );
}

type SubmitResponse = { projectId: string; status: string; message: string };
type SpecJobResponse = { jobId: string; status: "pending" | "running" | "done" | "error"; specMarkdown?: string; summary?: string; error?: string; elapsed?: number };
// Feature #63 — chat de edição de spec
// `seeded`: turno vindo do HISTÓRICO do servidor (migração 089). É EXIBIÇÃO apenas — nunca vai
// no payload ao CTO. Reenviar conversas antigas mudaria o contexto do modelo e poderia ressuscitar
// uma instrução de dias atrás ("remova o módulo X") num turno novo.
type ChatMessage = { role: "user" | "assistant"; content: string; seeded?: boolean };
// `specMarkdown` pode vir preenchido COM `status: "error"` — job reprovado pelo enforcer que ainda
// guarda a revisão inteira (a api devolve para ser OFERECIDA, nunca aplicada sozinha).
// `truncated` (T1): a resposta bateu no teto de saída do modelo → a spec veio CORTADA. Nunca vai
// direto ao editor: aplicar uma spec truncada APAGA o que o modelo não chegou a reescrever.
type SpecChatJobResponse = { jobId: string; status: "pending" | "running" | "done" | "error"; specMarkdown?: string | null; reply?: string; error?: string; elapsed?: number; filePath?: string | null; baseSha?: string | null; baseSpecSha?: string | null; deadlineAt?: string | null; truncated?: boolean };
// Migração 089 — job do chat que o SERVIDOR ainda tem (em voo, ou concluído e não coletado).
// É o que permite reabrir a Bancada e reencontrar o estado em vez de redisparar outro Opus 5.
type InFlightChatJob = {
  jobId: string;
  status: "pending" | "running" | "done" | "error";
  kind: "chat" | "resolve_gaps" | "file";
  filePath: string | null;
  baseSha: string | null;
  baseSpecSha: string | null;
  error: string | null;
  elapsed: number;
  deadlineAt: string | null;
  createdAt: string;
  /** true = terminou enquanto ninguém olhava → OFERECER o resultado, nunca aplicar sozinho. */
  recovered: boolean;
  /** true = job REPROVADO que ainda guarda uma spec (ex.: enforcer bloqueou por metadados). O
   *  resultado existe e vale ser oferecido — com o motivo da reprovação à vista. */
  salvaged?: boolean;
  /** true = a resposta foi CORTADA no teto de saída do modelo (spec incompleta). */
  truncated?: boolean;
};
// T4.3: uma revisão de UM arquivo, produzida pela IA, aguardando confirmação de aplicação.
type PendingApply = { path: string; content: string; baseSha: string | null };
// Migração 089: revisão da SPEC INTEIRA recuperada de um job que terminou sem ninguém olhando.
// Não pode ir direto ao editor: nesse intervalo o usuário pode ter editado a spec à mão, e
// `setSpecMarkdown` cego apagaria a edição silenciosamente.
// `rejected`: a revisão existe mas o agente a REPROVOU (enforcer/BLOCKED). Continua sendo oferecida
// — o documento costuma estar íntegro e a reprovação ser de metadados — mas com o motivo à vista.
// `truncated`: a revisão está INCOMPLETA (cortada no teto de saída). Ela é oferecida para o humano
// aproveitar o que servir, mas com aviso explícito de que aplicar por cima da spec atual APAGA o
// trecho final que o modelo não chegou a reescrever.
type RecoveredSpec = { jobId: string; content: string; reply: string | null; kind: "chat" | "resolve_gaps"; rejected?: string | null; truncated?: boolean };
// Fallback do teto de espera quando o servidor não informa `deadlineAt` (api antiga). O valor
// AUTORITATIVO vem do 202/do job — o 18 min hardcoded que existia aqui matava a espera ANTES de
// revisões que o CTO concluía em 19 min, jogando fora o trabalho já pago.
const CHAT_CLIENT_DEADLINE_MS = 40 * 60_000;

// ── Modo autônomo (migração 090) ─────────────────────────────────────────────
// O laço "Resolver GAPs → Salvar rascunho → Validar" roda NO SERVIDOR (uma linha em
// `spec_autonomy_runs` avançada pelo tick de 20 s). Esta tela só liga a opção, desenha o log das
// rodadas e recarrega a spec quando o servidor a reescreve no disco — nada do laço depende de o
// navegador ficar aberto.
type AutonomyStatus =
  | "pending" | "cto_running" | "applying" | "validating"
  | "succeeded" | "exhausted" | "stalled" | "failed" | "stopped";
type AutonomyRoundLog = {
  round: number;
  /** PR-5: arquivo tratado nesta rodada (ausente = rodada de spec inteira). */
  filePath?: string | null;
  /** PR-5: a que passe de validação esta rodada pertence (0-based). */
  pass?: number;
  startedAt?: string;
  finishedAt?: string;
  gapsBefore?: number | null;
  gapsAfter?: number | null;
  /** GAPs 🔴/🟡 DESTE arquivo (rodada `per_file`) ou do projeto no início da rodada (`whole`). */
  blockers?: number | null;
  warnings?: number | null;
  /**
   * GAP-45: recorte 🔴/🟡 do PROJETO ao fim do PASSE, medido pela validação. Vive em campo separado
   * porque antes ele era gravado SOBRE `blockers`/`warnings` da última rodada de arquivo — e esta tela
   * desenha esses dois números ao lado do nome do arquivo, atribuindo a ele os GAPs dos outros onze.
   */
  passBlockers?: number | null;
  passWarnings?: number | null;
  applied?: boolean;
  specChars?: number | null;
  note?: string;
};
type AutonomyRun = {
  id: string;
  projectId: string;
  status: AutonomyStatus;
  active: boolean;
  /** PR-5: `per_file` = spec dividida (uma rodada = um arquivo); `whole` = ciclo da 090. */
  mode?: "whole" | "per_file";
  /** `per_file`: ARQUIVOS revisados. `whole`: rodadas do ciclo completo. */
  round: number;
  /** PR-5: passes de validação concluídos — é este que respeita `maxRounds`. */
  passes?: number;
  /** Arquivo em revisão agora (só em `per_file`). */
  currentFile?: string | null;
  /** Arquivos já tratados no passe corrente. */
  filesDone?: string[];
  maxRounds: number;
  gapsInitial: number | null;
  gapsCurrent: number | null;
  rounds: AutonomyRoundLog[];
  lastError: string | null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};
type AutonomyState = { run: AutonomyRun | null; enabled: boolean; maxRoundsAllowed: number };

/** PR-4 (F2) — GET /api/specs/:id/gap-scope: quantos GAPs ATIVOS cada arquivo da spec tem. */
type GapScopeWire = {
  latestRunId: string | null;
  fileCount: number;
  totalActive: number;
  /** GAPs ativos que ainda não têm arquivo definido (globais do Stage A / path obsoleto). */
  unrouted: number;
  files: Array<{ path: string; isPrimary: boolean; active: number; blockers: number; warnings: number; routed: number }>;
  /** Ordem sugerida de trabalho (mais blockers primeiro) — a mesma fila do laço autônomo. */
  queue: string[];
  /** J1: arquivos que viraram índice depois desta validação — o nome citado nos GAPs não vale mais. */
  stalePaths?: string[];
  /** J1: GAPs desviados ao roteador por causa disso (estão AGUARDANDO rota, não sem rota). */
  staleNameMatches?: number;
};

/** Rótulo PT-BR do estado do laço + severidade para o Alert (o usuário precisa saber se acabou). */
const AUTONOMY_LABEL: Record<AutonomyStatus, string> = {
  pending: "aguardando a próxima rodada",
  cto_running: "o CTO está resolvendo os GAPs",
  applying: "salvando a spec revisada",
  validating: "validação adversarial em andamento",
  succeeded: "concluído — sem GAPs vermelhos ou amarelos em aberto",
  exhausted: "teto de rodadas atingido com GAPs ainda em aberto",
  stalled: "interrompido por falta de progresso (ou spec editada à mão)",
  failed: "interrompido por erro",
  stopped: "interrompido por você",
};
function autonomySeverity(s: AutonomyStatus): "info" | "success" | "warning" | "error" {
  if (s === "succeeded") return "success";
  if (s === "failed") return "error";
  if (s === "exhausted" || s === "stalled" || s === "stopped") return "warning";
  return "info";
}

/**
 * UI/UX 2026-09-06 — UMA frase para o estado do laço, usada nos TRÊS lugares que o mostram
 * (aviso do corpo da página, linha compacta do chat e aba "Autonomia" do editor). Antes o corpo
 * da página dizia "rodada 12/5" em runs `per_file`, porque lá `round` conta ARQUIVOS e quem
 * respeita `maxRounds` é `passes` — a mesma confusão que já tinha sido corrigida só no chat.
 */
function autonomyHeadline(run: AutonomyRun, running = run.active): string {
  if (run.mode === "per_file") {
    const pass = Math.min((run.passes ?? 0) + (running ? 1 : 0), run.maxRounds);
    return `Modo autônomo por arquivo — passe ${pass}/${run.maxRounds} · ${run.round} arquivo(s) revisado(s)`;
  }
  return `Modo autônomo — rodada ${run.round}/${run.maxRounds}`;
}

/**
 * Relatório do laço autônomo (o registro de AÇÕES por rodada). Vive numa ABA do editor: no chat
 * ele consumia a coluna inteira — no mobile, a tela inteira — empurrando o campo de mensagem para
 * fora da vista. Aqui tem espaço para respirar e o chat fica com uma linha só.
 */
function AutonomyReport({ run, running, onStop }: {
  run: AutonomyRun;
  running: boolean;
  onStop?: () => void;
}) {
  return (
    <Box sx={{ p: { xs: 1.5, md: 2 } }} aria-live="polite">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        {running && <CircularProgress size={16} />}
        <Typography variant="subtitle2" sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0 }}>
          🤖 {autonomyHeadline(run, running)}
        </Typography>
        {running && onStop && (
          <Button size="small" color="inherit" variant="outlined" onClick={onStop}
            sx={{ fontSize: "0.7rem", textTransform: "none", flexShrink: 0 }}>
            Interromper laço
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.6, mb: 1 }}>
        {AUTONOMY_LABEL[run.status]}
        {run.currentFile ? ` · arquivo atual: ${run.currentFile}` : ""}
        {typeof run.gapsInitial === "number" && typeof run.gapsCurrent === "number"
          ? ` · GAPs importantes: ${run.gapsInitial} → ${run.gapsCurrent}`
          : ""}
      </Typography>
      {run.lastError && (
        <Alert severity={autonomySeverity(run.status)} sx={{ mb: 1, fontSize: "0.72rem" }}>{run.lastError}</Alert>
      )}
      {run.rounds.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          Nenhuma rodada registrada ainda — o laço vive no servidor e continua mesmo com esta tela fechada.
        </Typography>
      ) : (
        <Stack spacing={0.4}>
          {run.rounds.map((r) => (
            <Stack key={r.round} direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap" useFlexGap
              sx={{ py: 0.4, borderBottom: "1px solid", borderColor: "divider" }}>
              <Typography variant="caption" sx={{ fontWeight: 700, minWidth: 26 }}>#{r.round}</Typography>
              {r.filePath && (
                <Typography variant="caption" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{r.filePath}</Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                🔴 {r.blockers ?? 0} · 🟡 {r.warnings ?? 0}
                {/* GAP-45: os números do arquivo acima; os do PASSE (validação) explicitamente rotulados. */}
                {typeof r.gapsAfter === "number"
                  ? ` → ${r.gapsAfter} restante(s) na spec${
                      typeof r.passBlockers === "number" ? ` (🔴 ${r.passBlockers} · 🟡 ${r.passWarnings ?? 0})` : ""
                    }`
                  : ""}
                {r.applied === false ? " · não aplicada" : ""}
                {r.note ? ` · ${r.note}` : ""}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function formatFileSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Onda 4 — mapa PT-BR dos erros do upload (POST /api/specs) por código/status. A mensagem do
// servidor vence quando é específica; aqui damos a ação corretiva. Sem status (rede) → texto do erro.
function describeUploadError(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = e.message?.trim();
    switch (e.code) {
      case "SPEC_INTAKE_INCOMPLETE": return msg || "Spec incompleta: informe título, tipo e pelo menos um anexo legível.";
      case "SPEC_ATTACHMENT_UNREADABLE": return msg || "Não foi possível extrair texto do anexo (PDF só-imagem ou .doc antigo). Envie .md/.docx/.txt ou cole o texto.";
      case "FILE_SIGNATURE_MISMATCH": return "O conteúdo do arquivo não corresponde à extensão (arquivo disfarçado). Envie o arquivo original.";
      case "ZIP_TOO_LARGE": return "O ZIP descompactado excede o limite. Envie menos arquivos ou divida em partes.";
      case "RATE_LIMITED": return msg || "Muitos envios em pouco tempo. Aguarde um minuto e tente de novo.";
      case "BUDGET_EXCEEDED": return msg || "Orçamento mensal de IA do tenant atingido.";
      case "PROJECT_LIMIT_REACHED": return msg || "Limite de projetos do plano atingido.";
      default: break;
    }
    switch (e.status) {
      case 400: return msg || "Formato de arquivo não aceito. Use .md, .txt, .doc, .docx, .pdf ou .zip.";
      case 403: return msg || "Sem permissão para enviar specs neste tenant.";
      case 409: return msg || "Conflito ao criar a spec. Recarregue e tente novamente.";
      case 413: return `Arquivo grande demais — o limite é ${formatFileSize(MAX_UPLOAD_BYTES)} por arquivo (até ${MAX_UPLOAD_FILES} arquivos).`;
      case 422: return msg || "A spec não passou no gate de entrada — falta conteúdo legível.";
      case 429: return msg || "Limite de uso atingido. Tente mais tarde.";
      case 503: return "Serviço temporariamente indisponível. Tente novamente em instantes.";
      default: return msg || "Falha ao enviar spec.";
    }
  }
  return e instanceof Error && e.message ? e.message : "Falha ao enviar spec.";
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
      <ReactMarkdown
        components={{
          // Intercept code blocks: render mermaid as SVG, others as code
          code({ className, children }: { className?: string; children?: React.ReactNode }) {
            const lang = (className ?? "").replace("language-", "");
            const codeStr = String(children).replace(/\n$/, "");
            if (lang === "mermaid") return <MermaidBlock code={codeStr} />;
            return <code className={className}>{children}</code>;
          },
        }}
      >{content}</ReactMarkdown>
    </Box>
  );
}

// ── Divisória arrastável (resize horizontal entre painéis) ───────────────────
// Barra fina de 6px com cursor col-resize. Emite o deslocamento (deltaX) do ponteiro
// enquanto arrastado; o pai converte em largura/proporção. Usa Pointer Events (mouse+touch)
// e listeners em window para não perder o arraste ao sair da barra. Só ≥md (no mobile os
// painéis empilham). `onDoubleClick` reseta ao default.
function ResizeHandle({ onResize, onReset, ariaLabel }: {
  onResize: (deltaX: number) => void;
  onReset?: () => void;
  ariaLabel?: string;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      onResizeRef.current(e.clientX - lastX.current);
      lastX.current = e.clientX;
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);
  return (
    <Box
      role="separator" aria-orientation="vertical" aria-label={ariaLabel || "Redimensionar painel"}
      onPointerDown={(e) => {
        dragging.current = true;
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={() => onReset?.()}
      sx={{
        flexShrink: 0, width: "6px", cursor: "col-resize", alignSelf: "stretch",
        display: { xs: "none", md: "block" }, position: "relative", zIndex: 1,
        bgcolor: "divider", transition: "background-color .15s",
        "&:hover": { bgcolor: "primary.main" },
        // alvo de clique maior sem alargar o layout
        "&::after": { content: '""', position: "absolute", inset: "0 -4px", cursor: "col-resize" },
      }}
    />
  );
}

// Limita a largura do painel de chat entre 300 e 640px (mantém o editor legível).
const clampChatWidth = (w: number) => Math.max(300, Math.min(640, w));
const clampTreeWidth = (w: number) => Math.max(180, Math.min(420, w));

// ── Editor + Preview side by side ─────────────────────────────────────────────
function SpecEditor({
  value, onChange, fullscreen, onToggleFullscreen,
  onSave, approving, onRegen, regenDisabled,
  projectId = null, isAdmin = false, validationReloadSignal, gapCount = null,
  onPromote, promoteScope = null, fileExt = "md", onValidationChange, openGapsSignal,
  activeFilePath = null, onVersionRestored,
  saveLabel = "Salvar rascunho", autonomy = null, onStopAutonomy, openAutonomySignal,
}: {
  value: string;
  onChange: (v: string) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSave: () => void;
  approving: "save" | "start" | null;
  onRegen?: () => void;
  regenDisabled: boolean;
  // Onda 3 (a): quando há projeto (modo edição), a validação/GAPs vira uma ABA do editor
  // — [Editar | Lado a lado | Preview | GAPs (X)] — em vez de um card separado acima.
  projectId?: string | null;
  isAdmin?: boolean;
  validationReloadSignal?: number;
  gapCount?: number | null;
  // Onda 3 (b): promoção (substitui "Salvar e iniciar"). Só aparece quando provido (modo edição).
  // A confirmação com digitação (quando há GAPs) é tratada pelo pai.
  onPromote?: () => void;
  // B1 da revisão adversarial (2026-09-06): o rótulo tem de dizer o ESCOPO REAL do clique — a spec
  // dentro de um produto promove o produto INTEIRO; uma spec avulsa promove só ela. Escondê-lo fazia
  // o usuário admitir N projetos acreditando ter admitido um.
  promoteScope?: PromoteScope | null;
  // Onda 3 (d): extensão do arquivo em edição → realce de sintaxe por tipo (default markdown).
  fileExt?: string;
  // Onda 3 — a validação (dentro da aba GAPs) reporta o nº de GAPs ao pai p/ manter o badge
  // e o gate de promoção sincronizados após validar sem sair do editor.
  onValidationChange?: (count: number | null) => void;
  // Após "Salvar rascunho" (que persiste a spec e revalida), o pai bump-a este sinal para
  // trazer o usuário à aba GAPs — onde o SpecValidationPanel mostra a revalidação ao vivo e a
  // lista já sem os GAPs resolvidos.
  openGapsSignal?: number;
  // Onda 4 (A4.3) — aba "Versões": arquivo aberto na árvore (liga o filtro "só este arquivo") e
  // aviso de restauração feita, para o pai recarregar a spec do servidor (o editor não pode
  // continuar com o texto velho — salvar por cima desfaria a restauração em silêncio).
  activeFilePath?: string | null;
  onVersionRestored?: (path: string) => void;
  // UI/UX 2026-09-06 — rótulo do botão de salvar: com um arquivo da árvore aberto, o que se salva
  // é AQUELE arquivo (PUT /spec-file com If-Match), não o rascunho da spec inteira.
  saveLabel?: string;
  // UI/UX 2026-09-06 — o laço autônomo virou uma ABA daqui (antes ocupava a coluna inteira do chat,
  // e no mobile a tela toda). `openAutonomySignal` traz o usuário a ela a partir do chat.
  autonomy?: AutonomyState | null;
  onStopAutonomy?: () => void;
  openAutonomySignal?: number;
}) {
  const hasGapsTab = !!projectId;
  const autonomyRun = autonomy?.run ?? null;
  // A aba só existe quando há um laço para mostrar (nunca uma aba vazia).
  const hasAutonomyTab = Boolean(autonomyRun);
  // "Preview deve ser a tab default" (pedido do Jean, 2026-09-06): quem abre a Bancada quer LER a
  // spec; editar é uma decisão seguinte. "Lado a lado" continua a um clique.
  const [editorTab, setEditorTab] = useState<"edit" | "preview" | "split" | "gaps" | "versions" | "autonomy">("preview");
  // Abre a aba GAPs quando o pai sinaliza (pós-salvar). Ignora o mount inicial (só reage a bumps).
  const lastOpenGaps = useRef(openGapsSignal);
  useEffect(() => {
    if (openGapsSignal === lastOpenGaps.current) return;
    lastOpenGaps.current = openGapsSignal;
    if (hasGapsTab) setEditorTab("gaps");
  }, [openGapsSignal, hasGapsTab]);
  // Mesmo padrão para a aba Autonomia (link "detalhes" na linha compacta do chat).
  const lastOpenAutonomy = useRef(openAutonomySignal);
  useEffect(() => {
    if (openAutonomySignal === lastOpenAutonomy.current) return;
    lastOpenAutonomy.current = openAutonomySignal;
    if (hasAutonomyTab) setEditorTab("autonomy");
  }, [openAutonomySignal, hasAutonomyTab]);
  // O laço terminou e a aba desapareceu (ou nunca existiu) enquanto estava selecionada → volta ao
  // Preview em vez de renderizar uma aba fantasma sem conteúdo.
  useEffect(() => {
    if (!hasAutonomyTab) setEditorTab((t) => (t === "autonomy" ? "preview" : t));
  }, [hasAutonomyTab]);
  // Badge dos GAPs: >99 vira "99+"; 0 não mostra número (aba fica só "GAPs").
  const gapBadge = gapCount == null ? null : gapCount > 99 ? "99+" : String(gapCount);
  // "Lado a lado": proporção do editor (%) arrastável entre 20% e 80%; duplo-clique reseta a 50%.
  const [splitPct, setSplitPct] = useState(50);
  const splitRef = useRef<HTMLDivElement | null>(null);

  const toolbar = (
    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap
      sx={{ px: 1.5, py: 0.75, rowGap: 0.75, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
        <Tabs value={editorTab} onChange={(_e, v) => setEditorTab(v as typeof editorTab)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ minHeight: 32 }}>
          <Tab value="edit"    icon={<EditIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Editar"    sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="split"   icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Lado a lado" sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="preview" icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Preview"  sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          {hasGapsTab && (
            <Tab value="gaps" icon={<FactCheckOutlinedIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start"
              label={
                <Stack direction="row" spacing={0.5} alignItems="center" component="span">
                  <span>GAPs</span>
                  {gapBadge && (
                    <Box component="span" sx={{
                      px: 0.6, minWidth: 16, height: 16, borderRadius: "8px", display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: "0.6rem", fontWeight: 700, lineHeight: 1,
                      bgcolor: (gapCount ?? 0) > 0 ? "error.main" : "success.main", color: "#fff",
                    }}>{gapBadge}</Box>
                  )}
                </Stack>
              }
              sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          )}
          {/* Onda 4 (A4.3): o histórico de versões da spec (G2) — só existe com projeto. */}
          {hasGapsTab && (
            <Tab value="versions" icon={<HistoryIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Versões"
              sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          )}
          {/* UI/UX 2026-09-06: o registro do laço autônomo saiu do chat e virou esta aba. */}
          {hasAutonomyTab && (
            <Tab value="autonomy" icon={<SmartToyOutlinedIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start"
              label={
                <Stack direction="row" spacing={0.5} alignItems="center" component="span">
                  <span>Autonomia</span>
                  {autonomyRun?.active && <CircularProgress size={10} />}
                </Stack>
              }
              sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          )}
        </Tabs>
        {/* Qual arquivo está no editor: com a árvore única, o editor deixa de ser sempre "a spec
            inteira" — sem este rótulo o usuário não sabe o que o botão Salvar vai gravar. */}
        {activeFilePath && (
          <Tooltip title={activeFilePath}>
            <Chip size="small" variant="outlined" color="primary" label={activeFilePath.split("/").pop()}
              sx={{ ml: 1, height: 18, maxWidth: 180, "& .MuiChip-label": { fontFamily: "monospace", fontSize: "0.62rem" } }} />
          </Tooltip>
        )}
        <Chip label={`${value.split("\n").length} linhas`} size="small" sx={{ fontSize: "0.65rem", height: 18, ml: 1 }} />
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ rowGap: 0.5 }}>
        {onRegen && (
          <Tooltip title="Regenerar spec com IA">
            <span>
              <Button size="small" variant="outlined" startIcon={<AutoFixHighIcon sx={{ fontSize: "0.8rem !important" }} />}
                disabled={regenDisabled} onClick={onRegen} sx={{ fontSize: "0.7rem", py: 0.3 }}>
                Regenerar
              </Button>
            </span>
          </Tooltip>
        )}
        {/* Onda 3 (b): a spec APENAS salva aqui — nunca "salva e inicia". A ida à fábrica é
            exclusiva do botão de promoção (abaixo, só no modo edição). */}
        <Tooltip title="Guardar a spec — promova à fábrica quando estiver pronta">
          <span>
            <Button size="small" variant="contained"
              startIcon={approving === "save" ? <CircularProgress size={12} color="inherit" /> : <span style={{ fontSize: "0.9rem" }}>💾</span>}
              disabled={approving !== null || !value.trim()} onClick={onSave}
              sx={{ fontSize: "0.72rem", py: 0.35 }}>
              {approving === "save" ? "Salvando…" : saveLabel}
            </Button>
          </span>
        </Tooltip>
        {onPromote && (
          // Migração 097: promover ADMITE na fábrica e NÃO inicia. Com produto, entra o produto
          // TODO na ordem de interdependência; o início é um clique separado. B1: o rótulo e o
          // tooltip vêm do escopo real, não de um texto fixo que valia só para um dos dois casos.
          <Tooltip title={promoteScope === "spec" ? FACTORY_TOOLTIP.promoteSpec : FACTORY_TOOLTIP.promoteProduct}>
            <span>
              <Button size="small" variant="contained" color="success"
                startIcon={approving === "start" ? <CircularProgress size={12} color="inherit" /> : <RocketLaunchIcon sx={{ fontSize: "0.85rem !important" }} />}
                disabled={approving !== null || !value.trim()} onClick={onPromote} sx={{ fontSize: "0.75rem", py: 0.4 }}>
                {approving === "start" ? FACTORY_LABEL.promoting : promoteButtonLabel(promoteScope)}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={fullscreen ? "Sair de tela cheia" : "Tela cheia"}>
          <IconButton size="small" onClick={onToggleFullscreen}>
            {fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );

  /**
   * UI/UX 2026-09-06 (item 3 do Jean: "sempre que um arquivo for carregado nos editores e preview,
   * rolar para o início do texto"). Chave de ESCOPO (projeto + arquivo aberto): usada como `key`
   * do editor e do preview, o que os REMONTA ao trocar de arquivo — DOM novo nasce com
   * `scrollTop = 0`. Trocar de arquivo mantendo o mesmo nó deixava o CodeMirror/preview na
   * posição de rolagem do arquivo ANTERIOR (no meio de um arquivo grande, parecia que o
   * conteúdo estava cortado). Não entra no `key` a aba nem o `value`: digitar não pode remontar.
   */
  const scopeKey = `${projectId ?? ""}|${activeFilePath ?? ""}`;

  // Onda 3 (d): editor com REALCE DE SINTAXE por tipo de arquivo (CodeMirror + tema vscodeDark),
  // no lugar do antigo <textarea> de cor única. `fileExt` decide a linguagem (default markdown).
  const editorArea = (h: string) => (
    <SpecCodeEditor key={scopeKey} value={value} onChange={onChange} ext={fileExt} height={h} />
  );

  const content = (areaH: string) => {
    if (editorTab === "edit") return editorArea(areaH);
    // UI/UX 2026-09-06 — Preview virou a aba DEFAULT, e a árvore única abre também arquivos que
    // não são Markdown (`connect.yaml`, JSON). Renderizar YAML como Markdown come a indentação —
    // que é a sintaxe do arquivo. Fora de .md/.markdown, o preview é o texto cru monoespaçado.
    if (editorTab === "preview") {
      const md = /^(md|markdown|mdx)$/i.test(fileExt);
      // `key={scopeKey}` nos dois: trocar de arquivo remonta → rolagem volta ao início (item 3).
      return md ? <MarkdownPreview key={scopeKey} content={value} /> : (
        <Box key={scopeKey} component="pre" sx={{
          height: areaH, width: "100%", minWidth: 0, overflow: "auto", m: 0, p: 1.5,
          bgcolor: "background.default", fontFamily: "monospace", fontSize: "0.78rem",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{value}</Box>
      );
    }
    // Onda 3 (a): aba GAPs — a validação da spec vive aqui dentro (antes era um card à parte).
    if (editorTab === "gaps") {
      return (
        <Box sx={{ height: areaH, width: "100%", minWidth: 0, overflow: "auto", p: 1.5, bgcolor: "background.default", overflowWrap: "anywhere", wordBreak: "break-word" }}>
          {projectId
            ? <SpecValidationPanel projectId={projectId} isAdmin={isAdmin} reloadSignal={validationReloadSignal}
                onFindingsChange={onValidationChange}
                /* 🗂️ Jean 2026-09-08 — arquivo escolhido na árvore filtra as listas de GAPs; pasta do
                   produto (`activeFilePath = null`, "spec inteira") mostra todos. */
                activeFilePath={activeFilePath} />
            : null}
        </Box>
      );
    }
    // Onda 4 (A4.3) — aba Versões: o histórico da spec (G2/migração 092) com "ver" e "restaurar".
    if (editorTab === "versions") {
      return (
        <Box sx={{ height: areaH, width: "100%", minWidth: 0, overflow: "auto", bgcolor: "background.default", overflowWrap: "anywhere" }}>
          {projectId
            ? <SpecVersionsPanel projectId={projectId} activeFilePath={activeFilePath} onRestored={onVersionRestored} />
            : null}
        </Box>
      );
    }
    // UI/UX 2026-09-06 — aba Autonomia: o log de rodadas do laço do servidor.
    if (editorTab === "autonomy") {
      return (
        <Box sx={{ height: areaH, width: "100%", minWidth: 0, overflow: "auto", bgcolor: "background.default", overflowWrap: "anywhere" }}>
          {autonomyRun
            ? <AutonomyReport run={autonomyRun} running={autonomyRun.active} onStop={onStopAutonomy} />
            : null}
        </Box>
      );
    }
    // split — editor | divisória arrastável | preview
    return (
      <Box ref={splitRef} sx={{ display: "flex", height: areaH, overflow: "hidden" }}>
        <Box sx={{ flex: { xs: 1, md: `0 0 ${splitPct}%` }, minWidth: 0, overflow: "hidden" }}>
          {editorArea("100%")}
        </Box>
        <ResizeHandle
          ariaLabel="Redimensionar editor e preview"
          onReset={() => setSplitPct(50)}
          onResize={(dx) => {
            const w = splitRef.current?.clientWidth || 1;
            setSplitPct((p) => Math.max(20, Math.min(80, p + (dx / w) * 100)));
          }}
        />
        <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <MarkdownPreview key={scopeKey} content={value} />
        </Box>
      </Box>
    );
  };

  return (
    // flex:1 + minWidth:0 + width:100% → preenche E limita a coluna quando o pai é flex-row
    // (dialog em tela cheia: editor à esquerda, chat 380px à direita). Sem isto, o SpecEditor
    // dimensionava pelo conteúdo e a aba GAPs (findings longos) vazava horizontalmente por baixo
    // do painel de chat. No layout inline (pai bloco) width:100% já bastava.
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minWidth: 0, width: "100%", overflow: "hidden" }}>
      {toolbar}
      <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", bgcolor: "background.default" }}>
        {content("100%")}
      </Box>
    </Box>
  );
}

// ── Chat de edição de spec (Feature #63) ──────────────────────────────────────
// Painel lateral onde o usuário conversa com a IA para refinar a spec. A cada turno,
// a IA devolve a spec revisada (aplicada no editor/preview) + uma resposta curta.
function SpecChatPanel({
  messages, input, onInput, onSend, sending, error,
  activeFilePath = null, treeDirty = false,
  openFilePath = null, openFileIsPrimary = false,
  historyLoading = false, historyError = null, onRetryHistory,
  pending = null, applying = false, applyError = null, conflict = false,
  onApply, onDiscard, onOverwrite,
  gapCount = null, onResolveGaps,
  fileGapCount = null, onResolveFileGaps,
  gapReconcile = null,
  isEvolution = false, onEvolvePlan,
  recovered = null, onApplyRecovered, onDiscardRecovered,
  autonomyOn = false, onAutonomyToggle, autonomy = null, autonomyError = null,
  autonomyStarting = false, onStopAutonomy, onShowAutonomy, onStartAutonomy,
}: {
  // Evoluir E2/E6 — em projeto de evolução, botão que pede ao arquiteto os artefatos
  // (RFC/ADR/CHANGELOG/connect.yaml) a partir do pedido (ou do texto digitado no chat).
  isEvolution?: boolean;
  onEvolvePlan?: () => void;
  messages: ChatMessage[];
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  // Onda 1 — botão "Resolver GAPs" (spec inteira): dispara a resolução adversarial dos findings.
  gapCount?: number | null;
  onResolveGaps?: () => void;
  // PR-4 (F2) — mesmo botão, escopado no ARQUIVO aberto. null = sem validação/sem escopo carregado.
  fileGapCount?: number | null;
  onResolveFileGaps?: () => void;
  /**
   * UI/UX 2026-09-06 (item 2 do Jean: "revisar todos os totalizadores de GAPs"). Os números da
   * tela batem entre si (todos contam finding sem triagem), MAS a soma dos badges por arquivo
   * podia ser MENOR que o badge da aba GAPs sem nenhuma explicação: os GAPs que o roteador não
   * conseguiu atribuir a um arquivo (`unrouted`) não apareciam em lugar nenhum. Esta linha
   * reconcilia o total com o que está visível por arquivo.
   */
  gapReconcile?: { total: number; unrouted: number; fileCount: number; stale?: number } | null;
  // T4.3 — contexto por-arquivo + fluxo de aplicação com confirmação (opcionais:
  // quando ausentes, o painel opera no modo clássico de spec inteira).
  activeFilePath?: string | null;
  treeDirty?: boolean;
  /**
   * Arquivo ABERTO na lista, para exibição no topo — inclusive o PRIMÁRIO, que edita a spec
   * inteira (`activeFilePath = null`). Sem isto, selecionar o índice deixava o topo dizendo só
   * "Editando a spec inteira", sem dizer QUAL arquivo estava aberto (Jean, 2026-09-06).
   */
  openFilePath?: string | null;
  openFileIsPrimary?: boolean;
  /** Histórico da conversa deste escopo: carregando / falhou (com "tentar de novo"). */
  historyLoading?: boolean;
  historyError?: string | null;
  onRetryHistory?: () => void;
  pending?: PendingApply | null;
  applying?: boolean;
  applyError?: string | null;
  conflict?: boolean;
  onApply?: () => void;
  onDiscard?: () => void;
  onOverwrite?: () => void;
  // Migração 089 — revisão da SPEC INTEIRA recuperada de um job que terminou fora desta tela.
  recovered?: RecoveredSpec | null;
  onApplyRecovered?: () => void;
  onDiscardRecovered?: () => void;
  // Migração 090 — modo autônomo: o checkbox só muda o DESTINO do botão "Resolver GAPs"
  // (POST /api/spec-autonomy em vez de POST /api/spec-chat). O laço em si vive no servidor;
  // `autonomy` é o estado lido por poll e desenhado como log de rodadas.
  autonomyOn?: boolean;
  onAutonomyToggle?: (on: boolean) => void;
  autonomy?: AutonomyState | null;
  autonomyError?: string | null;
  autonomyStarting?: boolean;
  onStopAutonomy?: () => void;
  /** UI/UX 2026-09-06 — leva o usuário à aba "Autonomia" do editor (fecha overlays do mobile). */
  onShowAutonomy?: () => void;
  /**
   * UI/UX 2026-09-06 (Jean: "no arquivo principal existe o `Ativar modo autônomo`, por que os
   * demais não têm essa opção?"). Inicia o laço autônomo DIRETO, sem passar pelo turno único da
   * spec inteira — é o que o escopo de arquivo precisa: o laço é POR PROJETO e, com spec dividida,
   * ele já roda em modo `per_file` (percorre arquivo a arquivo). Antes o controle só existia no
   * arquivo primário, escondendo justamente o caminho correto de uma spec grande.
   */
  onStartAutonomy?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending, pending, recovered]);
  const fileMode = Boolean(activeFilePath);
  /** Caminho a EXIBIR: o arquivo em escopo ou, se o aberto for o primário, o próprio primário. */
  const scopePath = activeFilePath ?? openFilePath;
  // Migração 090 — laço autônomo do servidor: enquanto ativo, o botão "Resolver GAPs" fica
  // travado (o laço já está chamando o CTO) e o painel abaixo mostra o que ele fez em cada rodada.
  const autonomyRun = autonomy?.run ?? null;
  const autonomyRunning = Boolean(autonomyRun?.active);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", bgcolor: "background.paper" }}>
      <Stack direction="row" spacing={1} alignItems="center"
        sx={{ px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
        <AutoFixHighIcon sx={{ fontSize: "1rem", color: PRIMARY }} />
        <Typography variant="subtitle2" fontWeight={600} sx={{ fontSize: "0.8rem" }}>Melhorar com IA</Typography>
      </Stack>

      {/* T4.3 — indicador de escopo: arquivo selecionado na árvore vs. spec inteira.
          2026-09-06 — o NOME do arquivo aberto aparece SEMPRE (inclusive o primário/índice, que
          edita a spec inteira). O escopo continua sendo dito em texto ao lado do chip, para o
          usuário não confundir "arquivo aberto" com "o que a IA vai reescrever". */}
      <Box sx={{ px: 1.5, py: 0.75, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0, bgcolor: "action.hover" }}>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          {scopePath ? (
            <Tooltip title={scopePath}>
              <Chip size="small" variant="outlined" color={fileMode ? "primary" : "default"}
                icon={<InsertDriveFileOutlinedIcon sx={{ fontSize: "0.9rem" }} />}
                label={scopePath.split("/").pop()}
                sx={{ maxWidth: "60%", "& .MuiChip-label": { fontFamily: "monospace", fontSize: "0.7rem" } }} />
            </Tooltip>
          ) : null}
          <Typography variant="caption" color="text.secondary" noWrap>
            {fileMode ? "só este arquivo" : openFileIsPrimary ? "arquivo principal · edita a spec inteira" : "Editando a spec inteira"}
          </Typography>
        </Stack>
      </Box>

      {/* Histórico da conversa: carregando / falhou. Antes a falha era silenciosa (catch vazio) e o
          chat simplesmente nascia vazio — Jean: "nem sempre o historico carrega, as vezes preciso
          forçar o refresh da tela". Agora ele vê o motivo e recarrega sem sair da tela. */}
      {historyError ? (
        <Alert severity="warning" sx={{ mx: 1.5, my: 0.75, py: 0, fontSize: "0.7rem" }}
          action={onRetryHistory ? (
            <Button size="small" onClick={onRetryHistory} sx={{ fontSize: "0.7rem" }}>Tentar de novo</Button>
          ) : undefined}>
          Não foi possível carregar o histórico desta conversa.
        </Alert>
      ) : historyLoading ? (
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ px: 1.5, py: 0.5 }}>
          <CircularProgress size={11} />
          <Typography variant="caption" color="text.secondary">Carregando histórico…</Typography>
        </Stack>
      ) : null}

      <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: "auto", p: 1.5 }}>
        {messages.length === 0 && !fileMode && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.6 }}>
            Peça ajustes em linguagem natural — ex.: &quot;adicione autenticação por Google&quot;,
            &quot;detalhe melhor o modelo de dados&quot;, &quot;remova o módulo de relatórios&quot;.
            A spec é revisada no preview a cada resposta.
          </Typography>
        )}
        {messages.length === 0 && fileMode && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.6 }}>
            Peça ajustes SÓ neste arquivo — ex.: &quot;adicione um campo email&quot;, &quot;detalhe os
            critérios de aceite&quot;. A revisão da IA é mostrada aqui e só grava no arquivo após você
            clicar em <strong>Aplicar</strong>.
          </Typography>
        )}
        <Stack spacing={1.25}>
          {messages.map((m, i) => (
            <Box key={i} sx={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "92%",
              bgcolor: m.role === "user" ? PRIMARY + "22" : "action.hover",
              border: "1px solid", borderColor: m.role === "user" ? PRIMARY + "44" : "divider",
              borderRadius: 1.5, px: 1.25, py: 0.75,
            }}>
              <Typography variant="caption" sx={{
                display: "block", fontWeight: 700, fontSize: "0.6rem", textTransform: "uppercase",
                letterSpacing: "0.06em", color: m.role === "user" ? "primary.main" : "text.secondary", mb: 0.25,
              }}>
                {m.role === "user" ? "Você" : "CTO"}
              </Typography>
              <Typography variant="body2" sx={{ fontSize: "0.8rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                {m.content}
              </Typography>
            </Box>
          ))}
          {sending && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 0.5, py: 0.5 }} aria-live="polite">
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">
                CTO revisando a spec… <Box component="span" sx={{ opacity: 0.75 }}>pode fechar esta tela — o servidor guarda o resultado.</Box>
              </Typography>
            </Stack>
          )}
        </Stack>
      </Box>

      {error && <Alert severity="error" sx={{ mx: 1, mb: 1, fontSize: "0.72rem" }}>{error}</Alert>}

      {/* T4.3 — árvore com edições não salvas: pedir revisão por IA agora clobraria o baseSha. */}
      {fileMode && treeDirty && !pending && (
        <Alert severity="warning" sx={{ mx: 1, mb: 1, fontSize: "0.72rem" }}>
          Há edições não salvas neste arquivo na árvore. Salve ou descarte antes de pedir uma revisão por IA.
        </Alert>
      )}

      {/* Migração 089 — revisão da spec INTEIRA que terminou enquanto esta tela estava fechada.
          Nunca entra no editor sozinha: a spec pode ter sido editada à mão nesse intervalo. */}
      {!fileMode && recovered && (
        <Box sx={{ mx: 1, mb: 1, p: 1, border: "1px solid", borderColor: recovered.truncated ? "error.main" : recovered.rejected ? "warning.main" : "success.main", borderRadius: 1.5, bgcolor: "background.paper" }} aria-live="polite">
          <Typography variant="caption" sx={{ display: "block", fontWeight: 700, mb: 0.5 }}>
            {recovered.truncated
              ? "🔴 Revisão INCOMPLETA (cortada no limite do modelo)"
              : recovered.rejected ? "⚠ Revisão recuperada de um job reprovado" : "✓ Revisão recuperada"}
            {" "}({recovered.content.length} caracteres)
          </Typography>
          {/* T1 — truncamento é MAIS grave que reprovação do enforcer: aqui o documento em si está
              mutilado (o fim não foi gerado). Aplicar por cima da spec atual apaga o que falta. */}
          {recovered.truncated && (
            <Alert severity="error" sx={{ mb: 1, fontSize: "0.72rem" }}>
              A resposta do CTO bateu no <b>limite de saída do modelo</b> e o documento parou no meio —
              o fim da spec <b>não foi gerado</b>. Se você aplicar e salvar, o trecho final da spec atual
              é <b>apagado</b>. Para specs grandes, revise <b>por arquivo</b> (spec dividida) ou trate os
              GAPs em blocos menores.
            </Alert>
          )}
          {/* Reprovado pelo enforcer: o documento em si costuma estar íntegro (a reprovação é de
              metadados/evidência), mas o motivo fica à vista para o Jean decidir com informação. */}
          {recovered.rejected && !recovered.truncated && (
            <Alert severity="warning" sx={{ mb: 1, fontSize: "0.72rem" }}>
              O agente reprovou o próprio resultado: {recovered.rejected} — revise o conteúdo antes de aplicar.
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, lineHeight: 1.5 }}>
            {recovered.truncated
              ? "O conteúdo está aqui para você aproveitar o que servir — compare antes de aplicar."
              : recovered.rejected
                ? "A revisão foi produzida por inteiro e ficou guardada no servidor em vez de ser descartada."
                : recovered.kind === "resolve_gaps"
                  ? "O CTO terminou de resolver os GAPs enquanto você estava fora desta tela."
                  : "O CTO terminou esta revisão enquanto você estava fora desta tela."}
            {" "}Aplicar substitui o conteúdo do editor — se você editou a spec desde então, essa
            edição é perdida.
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant={recovered.truncated ? "outlined" : "contained"}
              color={recovered.truncated ? "error" : recovered.rejected ? "warning" : "success"}
              startIcon={<CheckCircleIcon sx={{ fontSize: "1rem" }} />}
              onClick={onApplyRecovered}>
              {recovered.truncated ? "Aplicar mesmo assim" : "Aplicar ao editor"}
            </Button>
            <Button size="small" color="inherit" onClick={onDiscardRecovered}>Descartar</Button>
          </Stack>
        </Box>
      )}

      {/* T4.3 — revisão pronta aguardando confirmação de aplicação (só modo por-arquivo). */}
      {fileMode && pending && (
        <Box sx={{ mx: 1, mb: 1, p: 1, border: "1px solid", borderColor: conflict ? "warning.main" : "primary.main", borderRadius: 1.5, bgcolor: "background.paper" }}>
          <Typography variant="caption" sx={{ display: "block", fontWeight: 700, mb: 0.5 }}>
            Revisão pronta para <code style={{ fontSize: "0.72rem" }}>{pending.path.split("/").pop()}</code>
            {" "}({pending.content.length} caracteres)
          </Typography>
          {applyError && !conflict && (
            <Alert severity="error" sx={{ mb: 1, fontSize: "0.72rem" }}>{applyError}</Alert>
          )}
          {conflict ? (
            <>
              <Alert severity="warning" sx={{ mb: 1, fontSize: "0.72rem" }}>
                O arquivo mudou desde que a IA o revisou. Sobrescreva (perde a outra edição) ou descarte esta revisão e recomece.
              </Alert>
              <Stack direction="row" spacing={1}>
                <Button size="small" color="warning" variant="contained" disabled={applying}
                  startIcon={applying ? <CircularProgress size={14} color="inherit" /> : undefined}
                  onClick={onOverwrite}>Sobrescrever</Button>
                <Button size="small" color="inherit" disabled={applying} onClick={onDiscard}>Descartar</Button>
              </Stack>
            </>
          ) : (
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" disabled={applying}
                startIcon={applying ? <CircularProgress size={14} color="inherit" /> : <CheckCircleIcon sx={{ fontSize: "1rem" }} />}
                onClick={onApply}>Aplicar ao arquivo</Button>
              <Button size="small" color="inherit" disabled={applying} onClick={onDiscard}>Descartar</Button>
            </Stack>
          )}
        </Box>
      )}

      <Box sx={{ p: 1, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}>
        {/* Evoluir E2 — gera RFC/ADR/CHANGELOG/connect.yaml na árvore da spec a partir do pedido
            de evolução (ou do texto digitado abaixo, se houver). Nada é promovido aqui. */}
        {isEvolution && onEvolvePlan && (
          <Tooltip title="O arquiteto da Bancada analisa o pedido de evolução e escreve RFC (Gherkin + escopo de arquivos), ADR se houver decisão, CHANGELOG e connect.yaml evoluído. Se houver texto no campo abaixo, ele é usado como pedido.">
            <span>
              <Button fullWidth size="small" variant="contained" color="secondary"
                disabled={sending}
                onClick={onEvolvePlan}
                sx={{ mb: 0.75, fontSize: "0.72rem", textTransform: "none" }}>
                🧭 Gerar RFC / CHANGELOG da evolução
              </Button>
            </span>
          </Tooltip>
        )}
        {/* Migração 090 — painel do laço autônomo: o registro de AÇÕES que o pedido exige
            ("entrar em modo recursivo registrando ações"). Fica visível também depois de terminar,
            para o usuário ver por que o laço parou sem precisar abrir o histórico. */}
        {/* PR-5: no modo POR ARQUIVO o laço trabalha arquivo a arquivo — o painel também aparece
            quando o usuário está com um arquivo aberto (é ali que ele vê a spec mudar sozinha). */}
        {/* UI/UX 2026-09-06 — aqui sobra UMA LINHA. O log completo de rodadas foi para a aba
            "Autonomia" do editor: no chat ele ocupava a coluna inteira (no mobile, a tela toda) e
            empurrava o campo de mensagem para fora da vista. O estado continua à vista — o que
            mudou é o espaço que ele cobra. */}
        {/* UI/UX 2026-09-06 — a linha aparece em QUALQUER escopo. O laço é do PROJETO: esconder o
            estado com um arquivo aberto fazia a spec mudar sozinha sem nada na tela explicando. */}
        {autonomyRun && (autonomyRunning || autonomyRun.rounds.length > 0) && (
          <Tooltip title={autonomyRun.lastError
            ? `${AUTONOMY_LABEL[autonomyRun.status]} — ${autonomyRun.lastError}`
            : AUTONOMY_LABEL[autonomyRun.status]}>
            <Stack direction="row" spacing={0.5} alignItems="center" aria-live="polite"
              sx={{
                mb: 0.75, pl: 0.75, pr: 0.25, py: 0.25, borderRadius: 1.5, bgcolor: "action.hover",
                border: "1px solid",
                borderColor: autonomyRunning
                  ? "primary.main"
                  : autonomyRun.lastError ? `${autonomySeverity(autonomyRun.status)}.main` : "divider",
              }}
            >
              {autonomyRunning
                ? <CircularProgress size={12} sx={{ flexShrink: 0 }} />
                : <SmartToyOutlinedIcon sx={{ fontSize: "0.9rem", flexShrink: 0, color: "text.secondary" }} />}
              <Typography variant="caption" noWrap
                sx={{ flexGrow: 1, minWidth: 0, fontWeight: 700, fontSize: "0.66rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                {autonomyHeadline(autonomyRun, autonomyRunning)}
              </Typography>
              {onShowAutonomy && (
                <Button size="small" onClick={onShowAutonomy}
                  sx={{ flexShrink: 0, minWidth: 0, px: 0.5, fontSize: "0.62rem", textTransform: "none" }}>
                  detalhes
                </Button>
              )}
              {autonomyRunning && onStopAutonomy && (
                <Tooltip title="Interromper o laço autônomo">
                  <IconButton size="small" aria-label="Interromper o laço autônomo" onClick={onStopAutonomy}
                    sx={{ flexShrink: 0, p: 0.25 }}>
                    <StopCircleOutlinedIcon sx={{ fontSize: "1rem" }} />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          </Tooltip>
        )}
        {/* O erro de iniciar/parar o laço também vale em escopo de arquivo (o botão está lá agora). */}
        {autonomyError && (
          <Alert severity="warning" sx={{ mb: 0.75, fontSize: "0.7rem", py: 0 }}>{autonomyError}</Alert>
        )}
        {/* UI/UX 2026-09-06 — item 2 do Jean: os totalizadores agora FECHAM na tela. Em spec
            dividida, a soma dos badges por arquivo podia dar menos que o badge da aba GAPs, e
            nada dizia por quê: os GAPs que o roteador não conseguiu atribuir a um arquivo
            (`unrouted`) eram invisíveis — e o botão por-arquivo nunca os alcança. */}
        {gapReconcile && gapReconcile.fileCount > 1 && gapReconcile.total > 0 && (
          <Tooltip title={(gapReconcile.stale ?? 0) > 0
            ? `${gapReconcile.stale} GAP(s) citam um arquivo que virou ÍNDICE depois desta validação (a spec foi dividida): o nome não vale mais e um agente vai escolher o arquivo certo na próxima rodada. Revalidar a spec resolve de vez.`
            : gapReconcile.unrouted > 0
              ? "GAPs \"sem arquivo\" são os que o roteador não conseguiu atribuir (afetam a spec como um todo). O botão por-arquivo não os alcança — use o modo autônomo, que percorre a spec inteira."
              : "Todos os GAPs ativos estão atribuídos a um arquivo — a soma dos badges da lista fecha com o total."}>
            <Typography variant="caption" color="text.secondary"
              sx={{ display: "block", mb: 0.5, fontSize: "0.64rem", lineHeight: 1.4 }}>
              {gapReconcile.total} GAP(s) ativo(s) na spec
              {fileMode && fileGapCount != null ? ` · ${fileGapCount} neste arquivo` : ""}
              {gapReconcile.unrouted > 0
                ? ` · ${gapReconcile.unrouted} sem arquivo atribuído`
                : " · todos atribuídos a um arquivo"}
              {(gapReconcile.stale ?? 0) > 0 ? ` (${gapReconcile.stale} aguardando roteamento após a divisão)` : ""}
            </Typography>
          </Tooltip>
        )}
        {/* Onda 1 — Resolver GAPs (só na spec inteira): manda o CTO corrigir os findings da
            validação adversarial, com o relatório + arquivos irmãos como contexto.
            Migração 090: com o checkbox marcado, o mesmo botão inicia o LAÇO no servidor
            (resolver → salvar → validar), repetido enquanto sobrar GAP 🔴/🟡, até 5 rodadas. */}
        {!fileMode && onResolveGaps && (
          <>
            <Tooltip title={autonomy?.enabled === false
              ? "Modo autônomo desligado nesta instalação (SPEC_AUTONOMY=off)"
              : "O CTO resolve os GAPs, a spec é salva e revalidada automaticamente; repete enquanto sobrar GAP vermelho ou amarelo, no limite de rodadas. GAPs de baixo risco (azuis) não sustentam nova rodada."}>
              <FormControlLabel
                sx={{ ml: 0, mb: 0.25, alignItems: "flex-start" }}
                control={
                  <Checkbox
                    size="small" checked={autonomyOn}
                    disabled={autonomyRunning || autonomyStarting || autonomy?.enabled === false}
                    onChange={(e) => onAutonomyToggle?.(e.target.checked)}
                    sx={{ py: 0.25 }}
                  />
                }
                label={
                  <Typography variant="caption" sx={{ fontSize: "0.7rem", lineHeight: 1.4 }}>
                    Ativar modo autônomo{" "}
                    <Box component="span" sx={{ color: "text.secondary" }}>
                      (até {autonomy?.maxRoundsAllowed ?? 5} rodadas)
                    </Box>
                  </Typography>
                }
              />
            </Tooltip>
            <Tooltip title={(gapCount ?? 0) > 0
              ? (autonomyOn
                ? "Iniciar o laço autônomo no servidor — continua rodando mesmo se você fechar esta tela"
                : "Enviar os GAPs da validação para o CTO resolver de forma adversarial")
              : "Nenhum GAP em aberto — rode Validar para (re)avaliar a spec"}>
              <span>
                <Button fullWidth size="small" variant={autonomyOn ? "contained" : "outlined"} color="warning"
                  startIcon={autonomyStarting
                    ? <CircularProgress size={14} color="inherit" />
                    : <AutoFixHighIcon sx={{ fontSize: "0.9rem" }} />}
                  disabled={sending || autonomyRunning || autonomyStarting || (gapCount ?? 0) === 0}
                  onClick={onResolveGaps}
                  sx={{ mb: 0.75, fontSize: "0.72rem", textTransform: "none" }}>
                  {(gapCount ?? 0) > 0
                    ? (autonomyRunning
                      ? "Laço autônomo em andamento…"
                      : `${autonomyOn ? "Resolver GAPs em modo autônomo" : "Resolver GAPs"} (${gapCount})`)
                    : "Sem GAPs em aberto"}
                </Button>
              </span>
            </Tooltip>
          </>
        )}
        {/* UI/UX 2026-09-06 — item 1 do Jean: "por que os demais arquivos não têm 'Ativar modo
            autônomo'?". O laço é POR PROJETO e, em spec dividida, o servidor já o roda em modo
            `per_file` (fila de arquivos). Esconder o controle no escopo de arquivo escondia o
            caminho CORRETO de uma spec grande. Aqui ele é um BOTÃO, não um checkbox: no escopo de
            arquivo não existe o turno único da spec inteira para um checkbox "modificar" — e o
            rótulo diz o alcance real (TODOS os arquivos), para ninguém confundir com o botão
            de um arquivo só logo abaixo. */}
        {fileMode && onStartAutonomy && (
          <Tooltip title={autonomy?.enabled === false
            ? "Modo autônomo desligado nesta instalação (SPEC_AUTONOMY=off)"
            : (gapCount ?? 0) > 0
              ? `O laço percorre a spec INTEIRA — arquivo a arquivo — resolvendo, salvando e revalidando, enquanto sobrar GAP 🔴/🟡, até ${autonomy?.maxRoundsAllowed ?? 5} rodada(s). Roda no servidor: continua mesmo se você fechar esta tela.`
              : "Nenhum GAP em aberto na spec — rode Validar para (re)avaliar"}>
            <span>
              <Button fullWidth size="small" variant="outlined" color="secondary"
                startIcon={autonomyStarting
                  ? <CircularProgress size={14} color="inherit" />
                  : <SmartToyOutlinedIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={autonomyRunning || autonomyStarting || autonomy?.enabled === false || (gapCount ?? 0) === 0}
                onClick={onStartAutonomy}
                sx={{ mb: 0.75, fontSize: "0.72rem", textTransform: "none" }}>
                {autonomyRunning
                  ? "Laço autônomo em andamento…"
                  : (gapCount ?? 0) > 0
                    ? `Modo autônomo em TODOS os arquivos (${gapCount})`
                    : "Modo autônomo — sem GAPs em aberto"}
              </Button>
            </span>
          </Tooltip>
        )}
        {/* PR-4 (F2) — Resolver GAPs DESTE ARQUIVO. Aparece só com um arquivo aberto: é o caminho
            correto numa spec dividida (o botão da spec inteira reemitiria o documento todo). */}
        {fileMode && onResolveFileGaps && fileGapCount != null && (
          <Tooltip title={fileGapCount > 0
            ? "O CTO resolve apenas os GAPs deste arquivo e devolve o arquivo editado para você aplicar"
            : "Este arquivo não tem GAP em aberto na última validação"}>
            <span>
              <Button fullWidth size="small" variant="outlined" color="warning"
                startIcon={<AutoFixHighIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={sending || treeDirty || fileGapCount === 0}
                onClick={onResolveFileGaps}
                sx={{ mb: 0.75, fontSize: "0.72rem", textTransform: "none" }}>
                {fileGapCount > 0 ? `Resolver GAPs deste arquivo (${fileGapCount})` : "Sem GAPs neste arquivo"}
              </Button>
            </span>
          </Tooltip>
        )}
        <Stack direction="row" spacing={0.75} alignItems="flex-end">
          <TextField
            fullWidth multiline maxRows={4} size="small" value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (input.trim() && !sending) onSend(); }
            }}
            placeholder="Peça um ajuste na spec…"
            sx={{ "& textarea": { fontSize: "0.8rem" } }}
          />
          <IconButton color="primary" disabled={!input.trim() || sending} onClick={onSend} sx={{ mb: 0.25 }}>
            {sending ? <CircularProgress size={18} /> : <SendIcon fontSize="small" />}
          </IconButton>
        </Stack>
      </Box>
    </Box>
  );
}

const PRIMARY = "#6366F1";

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function SpecPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const inputRef     = useRef<HTMLInputElement>(null);

  // URL params
  const [parentProjectId, setParentProjectId] = useState<string | null>(null);
  const [parentTitle, setParentTitle]         = useState<string | null>(null);
  // editProjectId: modo edição de spec existente (sem criar novo projeto)
  const [editProjectId, setEditProjectId]     = useState<string | null>(null);
  const [editLoading, setEditLoading]         = useState(false);
  const [editLoadError, setEditLoadError]     = useState<string | null>(null);

  // Tab: 0=texto livre, 1=upload arquivo
  const [tab, setTab] = useState(0);

  // Tipo do projeto
  const [projectType, setProjectType] = useState("");

  // DM-T2: modo de entrega + avançado (só relevante p/ backend/fullstack).
  const [deliveryMode, setDeliveryMode] = useState("source_only");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dbMode, setDbMode] = useState("");        // "" = automático
  const [runtimeTarget, setRuntimeTarget] = useState(""); // "" = padrão (ecs_fargate)
  const [domainMode, setDomainMode] = useState("");       // "" = subdomínio Zentriz
  const isBackendType = /^(backend|fullstack)/.test(projectType);

  // Item 2: pré-seleção de deploy na nuvem no envio da spec (default do cockpit, trocável depois).
  const [cloudConnections, setCloudConnections] = useState<Array<{ id: string; provider: string; label: string | null }>>([]);
  const [cloudConnId, setCloudConnId] = useState<string>("");
  const [deployFormat, setDeployFormat] = useState<string>("");
  const [deployTtlDays, setDeployTtlDays] = useState<number>(7);
  useEffect(() => {
    let alive = true;
    apiGet<Array<{ id: string; provider: string; label: string | null }>>("/api/tenant/cloud-connections")
      .then((r) => { if (alive) setCloudConnections(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setCloudConnections([]); });
    return () => { alive = false; };
  }, []);

  // Item 3: Ferramentas UI/UX — conta conectada + arquivos Figma escolhidos (por URL).
  // uiuxConnId "" = nenhuma. Figma: o usuário cola a URL do arquivo e resolvemos o nome via
  // /v1/files/:key (escopo file_content:read). Não listamos mais projetos do time (endpoint
  // /projects exige projects:read, escopo deprecado e ausente em PATs novos).
  const [uiuxConnId, setUiuxConnId] = useState<string>("");
  const [uiuxConnections, setUiuxConnections] = useState<Array<{ id: string; provider: string; label: string | null }>>([]);
  const [uiuxProjects, setUiuxProjects] = useState<Array<{ id: string; name: string }>>([]); // arquivos resolvidos {id:key, name}
  const [uiuxProjectIds, setUiuxProjectIds] = useState<string[]>([]); // fileKeys escolhidas
  const [uiuxLoadingProjects, setUiuxLoadingProjects] = useState(false);
  const [uiuxProjectsError, setUiuxProjectsError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<Array<{ id: string; provider: string; label: string | null }>>("/api/tenant/uiux-connections")
      .then((r) => { if (alive) setUiuxConnections(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setUiuxConnections([]); });
    return () => { alive = false; };
  }, []);
  // Provider da conta UI/UX selecionada (governa: Figma extrai; Canva ainda não).
  const uiuxSelectedProvider = uiuxConnections.find((c) => c.id === uiuxConnId)?.provider ?? "";
  // Ao trocar de conta, zera os arquivos escolhidos e o erro.
  useEffect(() => {
    setUiuxProjectIds([]);
    setUiuxProjects([]);
    setUiuxProjectsError(null);
  }, [uiuxConnId]);
  // Resolve uma URL de arquivo Figma → { key, name } e adiciona à seleção (evita duplicatas).
  const addFigmaFile = useCallback((url: string) => {
    const raw = (url ?? "").trim();
    if (!uiuxConnId || !raw) return;
    setUiuxProjectsError(null);
    setUiuxLoadingProjects(true);
    apiGet<{ key: string; name: string }>(
      `/api/tenant/uiux-connections/${uiuxConnId}/figma-file?url=${encodeURIComponent(raw)}`,
    )
      .then((r) => {
        if (!r?.key) return;
        setUiuxProjects((prev) => (prev.some((f) => f.id === r.key) ? prev : [...prev, { id: r.key, name: r.name || r.key }]));
        setUiuxProjectIds((prev) => (prev.includes(r.key) ? prev : [...prev, r.key]));
      })
      .catch((e) => setUiuxProjectsError(e instanceof Error ? e.message : "Não foi possível ler o arquivo Figma."))
      .finally(() => setUiuxLoadingProjects(false));
  }, [uiuxConnId]);
  const removeFigmaFile = useCallback((key: string) => {
    setUiuxProjects((prev) => prev.filter((f) => f.id !== key));
    setUiuxProjectIds((prev) => prev.filter((k) => k !== key));
  }, []);

  // Produto e links (§5.3: inclui o INBOX "Rascunhos" via ?includeInbox=1; is_inbox marca-o)
  const [products, setProducts]       = useState<{ id: string; name: string; is_inbox?: boolean }[]>([]);
  /**
   * B4 da revisão adversarial (2026-09-06): UM único carregamento de produtos, com o MESMO escopo de
   * tenant que `/products` usa. A Bancada tinha quatro `fetch` crus sem `tenantId` — para o master,
   * `GET /api/products` sem `tenantId` devolve produtos de TODOS os tenants, então o select de
   * produto oferecia destinos de outro cliente. Sem `observer`, o valor é lido a cada chamada.
   */
  const reloadProducts = useCallback(async (): Promise<{ id: string; name: string; is_inbox?: boolean }[] | null> => {
    try {
      // O `useEffect` do layout (que hidrata o escopo) roda DEPOIS dos efeitos dos filhos: sem este
      // `hydrate()` idempotente, a primeira carga da Bancada sairia sem `tenantId`.
      tenantScopeStore.hydrate();
      const rows = await apiGet<{ id: string; name: string; is_inbox?: boolean }[]>(
        withQuery("/api/products", { includeInbox: 1, tenantId: tenantScopeStore.selectedTenantId }),
      );
      setProducts(rows);
      return rows;
    } catch {
      return null;                 // select fica com o que já tinha; a tela segue utilizável
    }
  }, []);
  // "" = sentinela → o backend resolve para o INBOX do tenant (normalizeProductId→resolveInboxProductId).
  const [productId, setProductId]     = useState("");
  const [linkProjectId, setLinkProjectId] = useState("");
  const [linkRelation, setLinkRelation]   = useState("uses_backend");
  const [allProjects, setAllProjects]     = useState<{ id: string; title: string; status: string; project_type?: string; productId?: string | null }[]>([]);

  // SPEC-APPROVED: "Especificações aprovadas por humanos". Quando marcado, o CTO VALIDA a spec
  // (Sub-modo C) em vez de regenerar. Engineer/charter/PM seguem normalmente.
  const [specApproved, setSpecApproved] = useState(false);

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
  // H2 (adversarial Onda 2) — sha do que foi LIDO do disco na última carga/recarga. Viaja no
  // "Salvar rascunho" como If-Match: sem ele, salvar sobrescrevia às cegas o que o modo autônomo
  // (ou outra aba) já tinha gravado. `null` = ainda não sei sobre o que estou editando → salvo como
  // antes, sem pré-condição, porque bloquear o salvamento seria pior do que o risco que ele corre.
  const [specBaseSha, setSpecBaseSha] = useState<string | null>(null);
  /** H2 — conflito do último "Salvar rascunho": nada foi gravado e o humano decide o desfecho. */
  const [specSaveConflict, setSpecSaveConflict] = useState(false);
  const [specConflictBusy, setSpecConflictBusy] = useState(false);
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  // Em tela cheia, no mobile não cabem editor, chat e árvore lado a lado → alterna o painel
  // visível ("files" só existe quando a spec veio de um produto). No desktop todos aparecem
  // juntos (o toggle fica oculto).
  const [fsPane, setFsPane] = useState<"editor" | "chat" | "files">("editor");
  const [approving, setApproving]       = useState<"save" | "start" | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Chat de edição de spec (Feature #63)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatSending, setChatSending]   = useState(false);
  const [chatError, setChatError]       = useState<string | null>(null);
  const chatPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // T4.3 — sequência monotônica: invalida jobs em voo quando o usuário troca de arquivo
  // ou dispara outro turno (evita aplicar a revisão de um arquivo no arquivo errado).
  const chatSeqRef = useRef(0);
  // Migração 089 — o jobId sai do closure e passa a viver num ref: era exatamente por só existir
  // dentro do `handleChatSend` que sair da tela perdia o rastro do trabalho em voo.
  const chatJobIdRef = useRef<string | null>(null);
  // Tick corrente do poll, para consultar NA HORA quando a aba volta ao foco (em vez de
  // esperar os 8 s do intervalo — e navegadores estrangulam timers de aba oculta).
  const chatTickRef = useRef<(() => Promise<void>) | null>(null);
  // Revisão da spec inteira recuperada de um job que terminou sem ninguém olhando.
  const [recoveredSpec, setRecoveredSpec] = useState<RecoveredSpec | null>(null);

  // T4.3 — chat por-arquivo: arquivo ativo (vindo da árvore), estado "sujo" da árvore,
  // revisão da IA aguardando aplicação, e sinal para recarregar a árvore após aplicar.
  const [activeFile, setActiveFile] = useState<{ path: string; content: string; baseSha: string } | null>(null);
  const [treeDirty, setTreeDirty] = useState(false);
  const [pendingApply, setPendingApply] = useState<PendingApply | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyConflict, setApplyConflict] = useState(false);
  const [treeReloadSignal, setTreeReloadSignal] = useState(0);
  const [validationReloadSignal, setValidationReloadSignal] = useState(0);
  // Bump para trazer o editor à aba GAPs (pós-salvar rascunho → revalidação ao vivo).
  const [openGapsSignal, setOpenGapsSignal] = useState(0);
  // ── Árvore única (UI/UX 2026-09-06) ────────────────────────────────────────────────────────
  // O editor PRINCIPAL passou a editar o arquivo escolhido na lista (antes o `SpecTreePanel` tinha
  // um editor próprio, escondido numa segunda lista). `fileDraft` é o texto não salvo do arquivo;
  // `activeFile.content` continua sendo o conteúdo SALVO (o que casa com `baseSha` e o que o chat
  // manda para a IA) — é a diferença entre os dois que define `treeDirty`.
  const [fileDraft, setFileDraft] = useState("");
  /** Arquivo que veio na URL (`?file=`) e só pode ser aberto depois que o projeto carregar. */
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  /** Metadados do projeto aberto reportados pela árvore (evita repetir o GET do índice). */
  const [specFileMeta, setSpecFileMeta] = useState<{ editable: boolean; fileCount: number } | null>(null);
  /**
   * Arquivo que o usuário ABRIU na lista — inclusive quando é o PRIMÁRIO. Existe separado de
   * `activeFile` porque abrir o primário significa "spec inteira" (`activeFile = null`, regra de
   * integridade: um só rascunho dos mesmos bytes). Jean, 2026-09-06: "quando seleciono um arquivo
   * que tem historico de conversas, o nome do arquivo atual nao é exibido no topo" — era exatamente
   * o primário, o único cujo histórico existe desde antes da divisão. Isto é EXIBIÇÃO: nunca
   * decide escopo de escrita nem de chat.
   */
  const [openFile, setOpenFile] = useState<{ path: string; primary: boolean } | null>(null);
  /** Bump para trazer o editor à aba "Autonomia" (o relatório do laço saiu do corpo da página). */
  const [openAutonomySignal, setOpenAutonomySignal] = useState(0);
  /** Diálogo "Dividir a spec em arquivos" (abre pelo ícone da lista) + estado espelhado do painel. */
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitState, setSplitState] = useState<{ enabled: boolean; awaitingDecision: boolean; active: boolean } | null>(null);
  // `handleSaveSpec` (spec inteira) é declarado bem depois nesta função; o botão único de salvar
  // precisa dele desde cedo. Ref preenchido por efeito = sem reordenar 1.000 linhas de handlers.
  const handleSaveSpecRef = useRef<(() => Promise<void>) | null>(null);
  // Largura (px) do painel de chat "Melhorar com IA" — arrastável pela divisória (300–640).
  const [chatWidth, setChatWidth] = useState(380);
  const shrinkChat = useCallback((dx: number) => setChatWidth((w) => clampChatWidth(w - dx)), []);
  // Largura (px) do rail da árvore da pasta (modo edição, ≥lg) — arrastável pela divisória (180–420).
  const [treeWidth, setTreeWidth] = useState(240);
  const growTree = useCallback((dx: number) => setTreeWidth((w) => clampTreeWidth(w + dx)), []);
  const [staleValidation, setStaleValidation] = useState(false);
  // Onda 1 — nº de GAPs (findings da última validação) para o badge e o botão "Resolver GAPs".
  const [gapCount, setGapCount] = useState<number | null>(null);
  /** PR-4 — GAPs ativos por arquivo da spec (+ fila sugerida). null = não carregado/sem validação. */
  const [gapScope, setGapScope] = useState<GapScopeWire | null>(null);
  // Onda 3 (b) — diálogo da promoção com confirmação por digitação quando há GAPs.
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteConfirmText, setPromoteConfirmText] = useState("");
  // Migração 097 — plano de promoção do PRODUTO (ordem por onda). Preenchido pelo 202 do
  // POST /api/products/:id/promote e re-lido do GET /api/products/:id/promotion depois de iniciar.
  const [planOpen, setPlanOpen] = useState(false);
  const [planProduct, setPlanProduct] = useState<{ id: string; name: string } | null>(null);
  const [planMeta, setPlanMeta] = useState<PromotionPlanMeta | null>(null);
  const [planItems, setPlanItems] = useState<PromotionPlanItem[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planStarting, setPlanStarting] = useState(false);
  const [startedNotice, setStartedNotice] = useState<string | null>(null);
  const [startedSeverity, setStartedSeverity] = useState<"success" | "warning">("success");
  // Pivô Bancada (Opção 1): produto dono da spec em edição (vem da URL ?productId=…).
  // Habilita a árvore "Pasta do produto" ao lado do editor, que navega entre os
  // projetos do produto sem abrir a tela redundante /products/:id/spec.
  const [treeProductId, setTreeProductId] = useState<string>("");
  // No mobile o chat não cabe ao lado do editor → abre em tela cheia via FAB.
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  // Mesma história para a ÁRVORE da pasta do produto: o rail só existe ≥lg, então no mobile/tablet
  // o usuário simplesmente não tinha acesso aos outros arquivos do produto. FAB + dialog fullScreen,
  // exatamente como o chat.
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  // Ao cruzar para o desktop, cada painel volta a ser inline → fecha o dialog fullScreen (senão
  // ficaria aberto sobre o layout desktop após um resize/rotação). Breakpoints diferentes: o chat
  // é inline a partir de md (900px), a árvore só a partir de lg (1200px).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mqChat = window.matchMedia("(min-width:900px)");
    const mqTree = window.matchMedia("(min-width:1200px)");
    const onChat = () => { if (mqChat.matches) setMobileChatOpen(false); };
    const onTree = () => { if (mqTree.matches) setMobileTreeOpen(false); };
    mqChat.addEventListener("change", onChat);
    mqTree.addEventListener("change", onTree);
    return () => {
      mqChat.removeEventListener("change", onChat);
      mqTree.removeEventListener("change", onTree);
    };
  }, []);

  // Migração 090 — modo autônomo. `autonomyOn` é só a intenção do usuário (o checkbox); o LAÇO
  // vive no servidor, numa linha de `spec_autonomy_runs` avançada pelo tick de 20 s da api. Por
  // isso o estado autoritativo vem sempre do GET, nunca de um timer local.
  const [autonomyOn, setAutonomyOn] = useState(false);
  const [autonomy, setAutonomy] = useState<AutonomyState | null>(null);
  const [autonomyError, setAutonomyError] = useState<string | null>(null);
  const [autonomyStarting, setAutonomyStarting] = useState(false);
  // Última observação do laço, para detectar "a rodada virou" / "o laço terminou" — os dois
  // momentos em que o servidor reescreveu a spec no disco e o editor precisa reler.
  const autonomySyncRef = useRef<{ runId: string; round: number; active: boolean } | null>(null);

  // Upload flow
  const [files, setFiles]         = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult]       = useState<SubmitResponse | null>(null);

  // Onda 4 — "Decompor em produto após salvar" (aba Upload). Flag vem da API (features no
  // /api/dashboard/summary); ausente/erro → oculto. Preferência do switch lembrada no navegador.
  const [features, setFeatures] = useState<UiFeatures>(NO_FEATURES);
  const [decomposeOnUpload, setDecomposeOnUpload] = useState(false);
  // Spec recém-salva que vai ser decomposta (abre o DecomposeDialog em modo spec, source upload).
  const [decomposeTarget, setDecomposeTarget] = useState<DecomposeSpecRef | null>(null);
  // true entre onSaved() e o onClose() que o diálogo dispara logo depois (evita push duplo).
  const decomposeSavedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    apiGet<{ features?: Partial<UiFeatures> | null }>("/api/dashboard/summary")
      .then((r) => {
        if (!alive) return;
        setFeatures({
          specUploadDecompose: r?.features?.specUploadDecompose === true,
          dashboardKpis: r?.features?.dashboardKpis === true,
        });
      })
      .catch(() => { if (alive) setFeatures(NO_FEATURES); });
    try { setDecomposeOnUpload(localStorage.getItem(DECOMPOSE_ON_UPLOAD_KEY) === "1"); } catch { /* sem storage */ }
    return () => { alive = false; };
  }, []);
  const toggleDecomposeOnUpload = useCallback((on: boolean) => {
    setDecomposeOnUpload(on);
    try { localStorage.setItem(DECOMPOSE_ON_UPLOAD_KEY, on ? "1" : "0"); } catch { /* sem storage */ }
  }, []);
  // Master (zentriz_admin) não decompõe (denyCreationForManagement → 403): esconde o switch.
  const canDecomposeOnUpload = features.specUploadDecompose && !authStore.isZentrizAdmin;
  // Prévia local: bytes dos anexos ≈ caracteres (exato para .md/.txt; .docx/.pdf/.zip são
  // aproximações grosseiras — por isso "≈" e faixa ±30 %).
  const uploadBytes = files.reduce((acc, f) => acc + f.size, 0);
  const uploadEstimate = uploadBytes > 0 ? estimateProposal(uploadBytes) : null;

  useEffect(() => {
    const pp = searchParams?.get("parentProjectId");
    const pt = searchParams?.get("parentTitle");
    const ep = searchParams?.get("editProjectId");
    const prod = searchParams?.get("productId");
    const file = searchParams?.get("file");
    if (pp) setParentProjectId(pp);
    if (pt) setParentTitle(decodeURIComponent(pt));
    if (ep) setEditProjectId(ep);
    // Só a árvore de navegação usa este productId; não confunde com o do fluxo de criação.
    setTreeProductId(prod ?? "");
    // UI/UX 2026-09-06 — arquivo escolhido na lista de OUTRO projeto viaja na URL: o projeto muda
    // primeiro (e reseta o editor/chat), então o arquivo só pode ser aberto depois disso.
    if (file) setPendingFilePath(file);
  }, [searchParams]);

  // Evoluir E2/E6 — é um projeto de EVOLUÇÃO? (extra.evolution) → habilita "Gerar RFC / CHANGELOG"
  // e orienta o humano no chat (uma vez por projeto).
  const [isEvolution, setIsEvolution] = useState(false);
  /**
   * B1 — dono da spec em edição, para o botão de promoção poder dizer o ESCOPO REAL do clique.
   * Vem da MESMA rota autoritativa que `promoteToFactory` reconsulta no clique (`/api/projects/:id`),
   * nunca do `?productId=` da URL (que é só navegação da árvore).
   */
  const [ownerProduct, setOwnerProduct] = useState<{ id: string | null; name: string | null } | null>(null);
  useEffect(() => {
    setIsEvolution(false);
    setOwnerProduct(null);
    if (!editProjectId) return;
    let cancelled = false;
    apiGet<{
      extra?: { evolution?: boolean; evolution_plan?: unknown } | null;
      productId?: string | null; productName?: string | null;
    }>(`/api/projects/${editProjectId}`)
      .then((p) => {
        if (cancelled) return;
        setOwnerProduct({ id: p?.productId ?? null, name: p?.productName ?? null });
        const evo = p?.extra?.evolution === true;
        setIsEvolution(evo);
        if (evo && !p?.extra?.evolution_plan) {
          setChatMessages((prev) => prev.length ? prev : [{
            role: "assistant",
            content: "🔄 **Esta é uma evolução.** Clique em **\"Gerar RFC / CHANGELOG da evolução\"** para o arquiteto transformar o pedido em RFC (critérios Gherkin + escopo de arquivos), ADR se houver decisão, CHANGELOG e `connect.yaml` evoluído — direto na árvore da spec. Revise os arquivos (o RFC define o que a fábrica PODE tocar) e só então promova à fábrica.",
          }]);
        }
      })
      .catch(() => { /* sem meta → sem botão */ });
    return () => { cancelled = true; };
  }, [editProjectId]);

  // Quando editProjectId estiver presente, carrega a spec existente do servidor
  useEffect(() => {
    if (!editProjectId) return;
    setEditLoading(true);
    setEditLoadError(null);
    apiGet<{ specMarkdown: string; title: string; contentSha256?: string }>(`/api/projects/${editProjectId}/spec-content`)
      .then((data) => {
        setSpecMarkdown(data.specMarkdown);
        setSpecBaseSha(data.contentSha256 ?? null);
        if (data.title) setProjectTitle(data.title);
      })
      .catch((e) => setEditLoadError(e instanceof Error ? e.message : "Erro ao carregar spec"))
      .finally(() => setEditLoading(false));
  }, [editProjectId]);

  // Onda 1 — busca a contagem de GAPs da última validação (badge + botão "Resolver GAPs").
  // Recarrega quando a validação muda (validationReloadSignal) ou o projeto troca.
  useEffect(() => {
    if (!editProjectId) { setGapCount(null); return; }
    let alive = true;
    // Zera ao trocar de projeto → sem flash da contagem do projeto anterior enquanto o fetch corre.
    setGapCount(null);
    apiGet<{ latestRun: { findings?: Array<{ triage?: unknown }> } | null; counts?: { active: number } | null }>(`/api/specs/${editProjectId}/validation`)
      // RFC-0005: null = nunca validada (aba GAPs sem número); N = GAPs ATIVOS (ignorados/refutados não contam).
      .then((r) => {
        if (!alive) return;
        if (!r?.latestRun) { setGapCount(null); return; }
        if (r.counts) { setGapCount(r.counts.active); return; }
        setGapCount(Array.isArray(r.latestRun.findings) ? r.latestRun.findings.filter((f) => !f?.triage).length : 0);
      })
      .catch(() => { if (alive) setGapCount(null); });
    return () => { alive = false; };
  }, [editProjectId, validationReloadSignal]);

  // PR-4 (F2) — mapa GAPs ↔ ARQUIVOS. Duas coisas dependem disso: o botão "Resolver GAPs deste
  // arquivo" (quantos GAPs há no arquivo aberto) e o badge por arquivo na árvore. O GET é grátis
  // (lê o `file` que o validador já devolveu + as rotas persistidas); quando sobram GAPs sem arquivo
  // e a spec tem 2+ arquivos, pedimos UMA vez o roteamento por agente (POST, custo baixo, gravado
  // na run) — senão os GAPs globais ficariam invisíveis em todo arquivo e o botão nunca apareceria.
  useEffect(() => {
    if (!editProjectId) { setGapScope(null); return; }
    let alive = true;
    setGapScope(null);
    (async () => {
      try {
        let scope = await apiGet<GapScopeWire>(`/api/specs/${editProjectId}/gap-scope`);
        if (!alive) return;
        setGapScope(scope);
        if (scope.unrouted > 0 && scope.fileCount > 1) {
          scope = await apiPost<GapScopeWire>(`/api/specs/${editProjectId}/gap-routes`, {});
          if (!alive) return;
          setGapScope(scope);
        }
      } catch { if (alive) setGapScope(null); }
    })();
    return () => { alive = false; };
  }, [editProjectId, validationReloadSignal]);

  // Load products + projects for linking (§5.3: ?includeInbox=1 traz o INBOX p/ o select)
  useEffect(() => {
    void reloadProducts();
    apiGet<{ id: string; title: string; status: string; project_type?: string; productId?: string | null }[]>("/api/projects").then(setAllProjects).catch(() => {});
  }, [reloadProducts]);

  // §5.3: default do produto = herdado do pai (nova versão) senão o INBOX. Só semeia enquanto
  // o usuário não escolheu nada (productId === "") — não sobrescreve escolha manual.
  useEffect(() => {
    if (productId !== "") return;
    if (parentProjectId) {
      const parent = allProjects.find((p) => p.id === parentProjectId);
      if (parent?.productId) { setProductId(parent.productId); return; }
    }
    const inbox = products.find((p) => p.is_inbox);
    if (inbox) setProductId(inbox.id);
  }, [products, allProjects, parentProjectId, productId]);

  // Auto-sugerir backend quando projectType é frontend E produto selecionado tem backend
  // T-15: legado `landing_page` e `web_*` removido; usar frontend_/mobile_/fullstack_ canônicos.
  useEffect(() => {
    if (!projectType) return;
    const isFrontendOrMobile =
      projectType.startsWith("frontend_") ||
      projectType.startsWith("mobile_") ||
      projectType.startsWith("fullstack_");
    if (!isFrontendOrMobile) return;
    if (linkProjectId) return; // usuário já escolheu — não sobrescrever
    // Buscar projetos do produto selecionado (ou de todos se sem produto) que são backend
    const backendProjects = allProjects.filter(p =>
      p.project_type?.startsWith("backend_") &&
      (p.status === "accepted" || p.status === "completed" || p.status === "running")
    );
    if (backendProjects.length === 1) {
      // Só 1 backend disponível — pré-selecionar automaticamente
      setLinkProjectId(backendProjects[0].id);
      setLinkRelation("uses_backend");
    }
  }, [projectType, allProjects, linkProjectId]);

  // ── Generate spec via CTO — async job with polling ─────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!freeText.trim() || freeText.trim().length < MIN_FREE_TEXT_CHARS) {
      setGenError(`Descreva o produto com pelo menos ${MIN_FREE_TEXT_CHARS} caracteres.`);
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
      } catch (e) {
        // log to help diagnose silent failures
        console.warn("[SpecPreview] poll error:", e instanceof Error ? e.message : e);
      }
    }, 8000); // 8s: gives time for 30k spec JSON to be read completely
  }, [freeText, projectTitle, stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Chat de edição de spec (Feature #63) ────────────────────────────────────
  const stopChatPolling = useCallback(() => {
    if (chatPollRef.current) { clearInterval(chatPollRef.current); chatPollRef.current = null; }
    chatTickRef.current = null;
  }, []);
  useEffect(() => () => stopChatPolling(), [stopChatPolling]);

  // ── Poll de UM job de chat (migração 089) ───────────────────────────────────
  // Lugar ÚNICO que consulta `/api/spec-chat/:jobId` — usado por quem acabou de disparar o turno
  // E pela rehidratação de quem voltou à tela. Antes havia três cópias divergentes deste laço e
  // só a do Evoluir tratava 404/estado terminal: no chat de spec, um job perdido num restart
  // deixava o painel girando "CTO revisando a spec…" para sempre, sem nunca dizer o motivo.
  const startChatPolling = useCallback((opts: {
    jobId: string;
    seq: number;
    kind: "chat" | "resolve_gaps" | "file";
    filePath: string | null;
    baseSha: string | null;
    /** Instante-limite ABSOLUTO (ms). Vem do `deadlineAt` do servidor quando conhecido — o teto
     *  fixo de 18 min do cliente descartava revisões de 19 min que o CTO havia CONCLUÍDO. */
    deadlineMs: number;
    /** true = job de outra sessão: OFERECE o resultado, não escreve no editor por conta própria. */
    recovered?: boolean;
    /** Quando a revisão foi PEDIDA (ms). Uma recuperada pode ser de ontem — aplicar sem saber a
     *  idade sobrescreveria o trabalho feito depois dela. */
    requestedAtMs?: number;
  }) => {
    const { jobId, seq, kind, filePath, baseSha, deadlineMs, recovered, requestedAtMs } = opts;
    chatJobIdRef.current = jobId;
    let pollErrors = 0;

    const finish = () => { stopChatPolling(); chatJobIdRef.current = null; setChatSending(false); };

    const tick = async () => {
      if (seq !== chatSeqRef.current) { stopChatPolling(); return; }
      // 2026-09-06 (Jean: "porque o arquivo principal exibe o aviso 'Esta revisão passou do tempo
      // máximo'?") — o teto era conferido ANTES do poll. Um job já `done` no banco, com a spec
      // pronta e `collected_at IS NULL`, era descartado no primeiro tick da rehidratação só porque
      // o `deadline_at` dele havia passado — e, como o resultado nunca era coletado, o
      // `/in-flight` o reofertava a CADA abertura da tela: aviso eterno que refresh não limpava
      // (medido em prod: job 4cc2a5a0, `resolve_gaps` done desde 2026-09-05 18:19).
      // O teto expira a ESPERA, nunca o RESULTADO → a conferência mudou para o ramo pending/running.
      try {
        const poll = await apiGet<SpecChatJobResponse>(`/api/spec-chat/${jobId}`);
        if (seq !== chatSeqRef.current) { stopChatPolling(); return; }
        pollErrors = 0;
        if (poll.status === "done") {
          finish();
          if (kind === "file") {
            // NÃO grava no arquivo — deixa a revisão pendente de confirmação (apply).
            const path = poll.filePath ?? filePath;
            if (poll.specMarkdown && path) {
              setPendingApply({ path, content: poll.specMarkdown, baseSha: poll.baseSha ?? baseSha });
            }
            setChatMessages((prev) => [...prev, { role: "assistant", content: poll.reply || "Revisão pronta. Confira e clique em Aplicar." }]);
          } else if (recovered) {
            // Terminou enquanto ninguém olhava: nesse intervalo o usuário pode ter editado a spec
            // à mão. Um `setSpecMarkdown` cego apagaria a edição em silêncio → oferecemos.
            if (poll.specMarkdown) setRecoveredSpec({ jobId, content: poll.specMarkdown, reply: poll.reply ?? null, kind, truncated: poll.truncated === true });
            // A IDADE vai no texto: uma revisão pedida ontem, aplicada hoje, apagaria tudo o que foi
            // editado no meio. Quem decide é o usuário — mas com a data à vista.
            const age = requestedAtMs && Number.isFinite(requestedAtMs)
              ? ` (pedida em ${new Date(requestedAtMs).toLocaleString("pt-BR")})` : "";
            setChatMessages((prev) => [...prev, { role: "assistant", content: (poll.reply || "Revisão concluída enquanto esta tela estava fechada.") + age }]);
          } else if (poll.truncated === true) {
            // T1 — a resposta foi CORTADA no teto de saída do modelo: a spec está INCOMPLETA.
            // Encher o editor com ela e o usuário salvar = apagar o trecho final que o modelo não
            // chegou a reescrever (medido em prod 2026-09-05, spec de 98k chars). OFERECEMOS com
            // aviso, no mesmo card das revisões recuperadas.
            if (poll.specMarkdown) {
              setRecoveredSpec({ jobId, content: poll.specMarkdown, reply: poll.reply ?? null, kind: kind === "resolve_gaps" ? "resolve_gaps" : "chat", truncated: true });
            }
            setChatMessages((prev) => [...prev, { role: "assistant", content: poll.reply || "Revisão concluída, porém INCOMPLETA (cortada no limite de saída do modelo)." }]);
          } else if (kind === "resolve_gaps") {
            if (poll.specMarkdown) setSpecMarkdown(poll.specMarkdown);
            // A revisão está no EDITOR mas ainda NÃO no disco → a validação (que lê do disco) só
            // reflete os GAPs resolvidos depois de "Salvar rascunho" (que persiste e revalida).
            const applied = poll.reply || "GAPs tratados na spec.";
            setChatMessages((prev) => [...prev, { role: "assistant", content: `${applied}\n\n➡️ Clique em **"Salvar rascunho"** para persistir e revalidar. A validação adversarial recalcula a lista de GAPs: os resolvidos somem, mas a análise **pode apontar novos pontos** a tratar — não confie no relato acima antes de revalidar.` }]);
            setStaleValidation(true); // a spec mudou → validação anterior ficou desatualizada
          } else {
            if (poll.specMarkdown) setSpecMarkdown(poll.specMarkdown);
            setChatMessages((prev) => [...prev, { role: "assistant", content: poll.reply || "Spec atualizada." }]);
          }
        } else if (poll.status === "error") {
          // `interrupted`/`lost` do banco chegam aqui como error + a causa real no campo `error`.
          finish();
          setChatError(poll.error ?? "O CTO encontrou um erro. Tente novamente.");
          // 2026-09-05 — um envelope reprovado pelo enforcer ainda carrega a spec inteira, e a api
          // agora a devolve junto do erro. Não some com ~20 min de Opus 5: OFERECE (nunca aplica),
          // com o motivo da reprovação no card. Modo por-arquivo não passa pelo enforcer.
          if (kind !== "file" && poll.specMarkdown) {
            setRecoveredSpec({ jobId, content: poll.specMarkdown, reply: null, kind, rejected: poll.error ?? null, truncated: poll.truncated === true });
          }
        } else if (Date.now() > deadlineMs) {
          // AINDA pending/running e o teto passou: aqui sim a espera acabou (o trabalho pode
          // continuar no agente — o coletor do servidor fecha o job quando souber o desfecho).
          finish();
          setChatError("Esta revisão passou do tempo máximo. O servidor continua tentando coletar o resultado — se o CTO terminar, ele aparece ao reabrir esta tela.");
          return;
        }
        // pending/running dentro do teto → segue pollando (o servidor também coleta, sem duplicar).
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pollErrors += 1;
        if (/NOT_FOUND|404|expirado/i.test(msg) || pollErrors >= 5) {
          finish();
          setChatError(/NOT_FOUND|404|expirado/i.test(msg)
            ? "Esta revisão não existe mais no servidor. Peça o ajuste novamente."
            : `Falha ao consultar a revisão: ${msg}`);
          return;
        }
        console.warn("[SpecChat] poll error:", msg);
      }
    };

    chatTickRef.current = tick;
    chatPollRef.current = setInterval(() => { void tick(); }, 8000);
    // Primeiro tick IMEDIATO: na rehidratação o resultado pode já estar pronto no banco —
    // esperar 8 s para descobrir isso seria latência de graça.
    void tick();
  }, [stopChatPolling]);

  // Aba voltou ao foco → consulta na hora. Navegadores estrangulam timers de aba oculta
  // (até ~1 tick/min), então quem volta da outra aba veria o spinner parado sem isto.
  useEffect(() => {
    const onWake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (chatPollRef.current && chatTickRef.current) void chatTickRef.current();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

  // T4.3 — árvore notifica o arquivo selecionado. Trocar de arquivo zera a conversa (H3),
  // a revisão pendente e invalida qualquer job em voo (chatSeqRef). Salvar o mesmo arquivo
  // (mesmo path, novo sha) apenas atualiza o baseSha, preservando a conversa.
  const handleFileSelected = useCallback((f: { path: string; content: string; baseSha: string } | null) => {
    setActiveFile((prev) => {
      const changed = (prev?.path ?? null) !== (f?.path ?? null);
      if (changed) {
        chatSeqRef.current += 1;
        stopChatPolling();
        setChatMessages([]);
        setChatInput("");
        setChatSending(false);
        setChatError(null);
        setPendingApply(null);
        setApplyError(null);
        setApplyConflict(false);
      }
      return f;
    });
    // UI/UX 2026-09-06 — o EDITOR PRINCIPAL passou a editar o arquivo selecionado (antes o
    // `SpecTreePanel` tinha um editor próprio). O rascunho nasce igual ao conteúdo do servidor.
    setFileDraft(f?.content ?? "");
    setTreeDirty(false);
  }, [stopChatPolling]);

  // ── Árvore única (UI/UX 2026-09-06): abrir / salvar / criar / excluir arquivo ───────────────
  // Tudo isto vivia dentro do `SpecTreePanel` — a SEGUNDA lista de arquivos da Bancada, com seu
  // próprio editor. Jean: "criar duas listas de arquivos quebra o conceito de UI/UX fácil de usar
  // e é contra intuitivo". A lista agora é uma só (`ProductFolderNav`) e é a PÁGINA que carrega o
  // arquivo no editor principal, com o chat e os GAPs já escopados por arquivo.
  //
  // Regra de integridade (não é detalhe de UI): o arquivo PRIMÁRIO é o que o `spec-content`
  // grava — abrir o primário significa "spec inteira" (`activeFile = null`), senão existiriam
  // DOIS rascunhos dos mesmos bytes (o `specMarkdown` e o do arquivo) e o último a salvar apagaria
  // o outro em silêncio.
  const openSpecFile = useCallback(async (specPath: string) => {
    if (!editProjectId) return;
    try {
      const f = await apiGet<{ path: string; content: string; contentSha256: string; isPrimary: boolean }>(
        `/api/projects/${editProjectId}/spec-file?path=${encodeURIComponent(specPath)}`,
      );
      // Rótulo do arquivo aberto (inclusive o primário) — só exibição, ver `openFile`.
      setOpenFile({ path: f.path, primary: f.isPrimary });
      if (f.isPrimary) { handleFileSelected(null); return; }
      handleFileSelected({ path: f.path, content: f.content, baseSha: f.contentSha256 });
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Falha ao abrir o arquivo da spec.");
    }
  }, [editProjectId, handleFileSelected]);

  // Estado atual em refs: o efeito de recarga não deve re-disparar por digitação no editor.
  const activeFileRef = useRef<{ path: string; content: string; baseSha: string } | null>(null);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);
  const treeDirtyRef = useRef(false);
  useEffect(() => { treeDirtyRef.current = treeDirty; }, [treeDirty]);

  // Algo reescreveu os arquivos no servidor (revisão aplicada, divisão, rodada do laço autônomo):
  // reabre o arquivo ativo para pegar conteúdo e sha novos. NUNCA por cima de edição não salva —
  // aí o usuário perderia o texto que está digitando.
  const lastTreeReload = useRef(treeReloadSignal);
  useEffect(() => {
    if (treeReloadSignal === lastTreeReload.current) return;
    lastTreeReload.current = treeReloadSignal;
    const cur = activeFileRef.current;
    if (cur && !treeDirtyRef.current) void openSpecFile(cur.path);
  }, [treeReloadSignal, openSpecFile]);

  // Clique num arquivo da árvore. Outro projeto → navega (o arquivo viaja na URL, `?file=`, e é
  // aberto pelo efeito de baixo depois que o novo projeto carrega); mesmo projeto → abre direto.
  /**
   * 🗂️ Clique numa PASTA da árvore (Jean, 2026-09-08: "quando clicar na pasta do produto exibir
   * todos") — volta ao modo "spec inteira" (`activeFile = null`), que é o que a aba GAPs lê para
   * tirar o filtro por arquivo. Pasta de OUTRO projeto navega para ele sem `?file=`.
   */
  const handleOpenTreeFolder = useCallback((projId: string) => {
    if (projId === editProjectId) { handleFileSelected(null); setOpenFile(null); return; }
    const q = new URLSearchParams({ editProjectId: projId });
    if (treeProductId) q.set("productId", treeProductId);
    router.replace(`/spec?${q.toString()}`);
  }, [editProjectId, handleFileSelected, treeProductId, router]);

  const handleOpenTreeFile = useCallback((projId: string, specPath: string) => {
    if (projId === editProjectId) { void openSpecFile(specPath); return; }
    const q = new URLSearchParams({ editProjectId: projId, file: specPath });
    if (treeProductId) q.set("productId", treeProductId);
    // replace (não push): navegar entre arquivos da pasta é troca de contexto, não um passo de
    // histórico — senão "Voltar" percorreria cada arquivo já aberto.
    router.replace(`/spec?${q.toString()}`);
  }, [editProjectId, treeProductId, openSpecFile, router]);

  useEffect(() => {
    if (!editProjectId || !pendingFilePath) return;
    const p = pendingFilePath;
    setPendingFilePath(null);
    void openSpecFile(p);
  }, [editProjectId, pendingFilePath, openSpecFile]);

  // Salvar o ARQUIVO aberto (PUT com If-Match). Conflito → mensagem que diz o que fazer, em vez
  // de sobrescrever a edição de outra pessoa/agente.
  const handleSaveActiveFile = useCallback(async () => {
    const cur = activeFile;
    if (!editProjectId || !cur) return;
    setApproving("save"); setApproveError(null);
    try {
      const r = await apiPut<{ ok: boolean; contentSha256: string }>(
        `/api/projects/${editProjectId}/spec-file?path=${encodeURIComponent(cur.path)}`,
        { content: fileDraft, baseSha: cur.baseSha },
      );
      setActiveFile((prev) => (prev && prev.path === cur.path
        ? { ...prev, content: fileDraft, baseSha: r.contentSha256 } : prev));
      setTreeDirty(false);
      setTreeReloadSignal((n) => n + 1);
      setValidationReloadSignal((n) => n + 1);
      setStaleValidation(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setApproveError(msg.includes("mudou desde") || msg.toUpperCase().includes("CONFLICT")
        ? `${cur.path} mudou no servidor desde que você o abriu (revisão da IA, laço autônomo ou outra sessão). Clique no arquivo na lista para recarregar — sua versão atual está no editor, copie o que quiser manter antes.`
        : msg);
    } finally { setApproving(null); }
  }, [editProjectId, activeFile, fileDraft]);

  // Um único botão "Salvar": grava o arquivo aberto ou o rascunho da spec inteira.
  const handleSaveCurrent = useCallback(() => {
    if (activeFile) { void handleSaveActiveFile(); return; }
    void handleSaveSpecRef.current?.();
  }, [activeFile, handleSaveActiveFile]);

  // Digitação no editor principal: em modo arquivo alimenta o rascunho do arquivo (e o `treeDirty`
  // que bloqueia pedir revisão à IA com bytes ambíguos); senão a spec inteira.
  const handleEditorChange = useCallback((v: string) => {
    if (activeFile) {
      setFileDraft(v);
      setTreeDirty(v !== activeFile.content);
      return;
    }
    setSpecMarkdown(v);
  }, [activeFile]);

  // Criar arquivo / RFC e excluir — os ícones que Jean pediu NA LISTA, junto do excluir.
  const handleCreateSpecFile = useCallback(async () => {
    if (!editProjectId) return;
    const p = window.prompt("Caminho do novo arquivo (ex.: backend/02-fila.md):");
    if (!p) return;
    try {
      await apiPost(`/api/projects/${editProjectId}/spec-file`, { path: p, content: `# ${p}\n\n` });
      setTreeReloadSignal((n) => n + 1);
      await openSpecFile(p);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Falha ao criar o arquivo.");
    }
  }, [editProjectId, openSpecFile]);

  const handleCreateRfc = useCallback(async () => {
    if (!editProjectId) return;
    const title = window.prompt("Título da funcionalidade do RFC (ex.: Exportar extrato em PDF):");
    if (!title) return;
    try {
      const r = await apiPost<{ ok: boolean; path: string; number: number }>(
        `/api/projects/${editProjectId}/rfc-from-template`, { title },
      );
      setTreeReloadSignal((n) => n + 1);
      await openSpecFile(r.path);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Falha ao criar o RFC.");
    }
  }, [editProjectId, openSpecFile]);

  const handleDeleteSpecFile = useCallback(async (projId: string, specPath: string) => {
    // A lista mostra a pasta do PRODUTO inteiro; excluir só vale no projeto aberto (é dele que
    // temos permissão de escrita confirmada e GAPs carregados) — a árvore já esconde o ícone nos
    // irmãos, isto é a guarda de defesa-em-profundidade.
    if (projId !== editProjectId) return;
    if (!window.confirm(`Excluir ${specPath} da spec? Esta ação não pode ser desfeita.`)) return;
    try {
      await apiDelete(`/api/projects/${projId}/spec-file?path=${encodeURIComponent(specPath)}`);
      if (activeFileRef.current?.path === specPath) handleFileSelected(null);
      setOpenFile((prev) => (prev?.path === specPath ? null : prev));
      setTreeReloadSignal((n) => n + 1);
      setValidationReloadSignal((n) => n + 1);
      setStaleValidation(true);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Falha ao excluir o arquivo.");
    }
  }, [editProjectId, handleFileSelected]);

  // A árvore já leu o índice: reaproveitamos o `editable`/nº de arquivos dela em vez de repetir o
  // GET. Compara antes de setar — as 3 instâncias (rail, tela cheia, mobile) reportam o mesmo.
  const handleTreeMeta = useCallback((m: { editable: boolean; fileCount: number; primaryPath?: string | null }) => {
    setSpecFileMeta((prev) => (prev && prev.editable === m.editable && prev.fileCount === m.fileCount ? prev : m));
    // 2026-09-06 (Jean: "ainda não vejo o nome do arquivo no topo") — ao ABRIR a tela nenhum arquivo
    // foi clicado, mas o editor JÁ mostra o primário (é ele que o `spec-content` grava). Sem semear
    // o rótulo aqui, o topo do chat só dizia "Editando a spec inteira", sem dizer QUAL arquivo.
    // Só semeia quando não há arquivo aberto — um clique do usuário nunca é sobrescrito.
    if (m.primaryPath) {
      setOpenFile((prev) => (prev ? prev : { path: m.primaryPath as string, primary: true }));
    }
  }, []);

  // Linha compacta do chat → aba "Autonomia" do editor. Fecha os overlays do mobile, senão o
  // usuário clicaria em "detalhes" e continuaria olhando o chat em tela cheia.
  const handleShowAutonomy = useCallback(() => {
    setMobileChatOpen(false);
    setFsPane("editor");
    setOpenAutonomySignal((n) => n + 1);
  }, []);

  // Pivô Bancada (Opção 1): a árvore "Pasta do produto" NAVEGA o editor trocando
  // editProjectId na MESMA rota (/spec) — a página NÃO desmonta. Sem este reset, o
  // estado transitório do projeto anterior vazaria para o novo: o chat continuaria
  // exibindo (e reenviando ao CTO) a conversa do projeto A, e um "Aplicar" pendente
  // gravaria o conteúdo revisado de A no projeto B (arquivo/sha errados → 404 ou,
  // pior, sobrescrita silenciosa). Ao trocar de projeto, zeramos tudo que é por-projeto:
  // conversa/entrada de chat, arquivo ativo + revisão pendente, dirty/stale e erros.
  // (specMarkdown/título/gapCount são recarregados pelos seus próprios efeitos.)
  //
  // Migração 089 — e é AQUI, depois de zerar, que a REHIDRATAÇÃO acontece: o servidor é a fonte
  // da verdade sobre "há trabalho em voo neste projeto?". Sem isso, sair da tela e voltar não só
  // perdia o estado como convidava o usuário a disparar um segundo Opus 5 em paralelo ao primeiro.
  useEffect(() => {
    chatSeqRef.current += 1;      // invalida qualquer job de chat em voo do projeto anterior
    stopChatPolling();
    chatJobIdRef.current = null;
    setChatMessages([]);
    setChatInput("");
    setChatSending(false);
    setChatError(null);
    setActiveFile(null);
    setOpenFile(null);       // e o rótulo do arquivo aberto é do projeto anterior
    setFileDraft("");        // trocou de projeto → o rascunho do arquivo anterior não vale mais
    setSpecFileMeta(null);   // e o `editable`/nº de arquivos vêm do índice do projeto novo
    setTreeDirty(false);
    setPendingApply(null);
    setApplyError(null);
    setApplyConflict(false);
    setStaleValidation(false);
    setApproveError(null);
    setRecoveredSpec(null);

    if (!editProjectId) return;
    const projectAtStart = editProjectId;
    let cancelled = false;
    void (async () => {
      // 1) O histórico da conversa é carregado por ESCOPO num efeito próprio (projeto + arquivo
      //    aberto) — ver `loadChatHistory` abaixo. Aqui ficou só a reanexação do job em voo.

      // 2) Job em voo (ou concluído e não coletado) da spec INTEIRA deste projeto.
      //    Sem `filePath`, o servidor devolve só jobs de spec inteira — jobs por-arquivo dependem
      //    da seleção na árvore (que um reload não restaura) e não são reanexados aqui.
      try {
        const r = await apiGet<{ job: InFlightChatJob | null }>(`/api/spec-chat/in-flight?projectId=${projectAtStart}`);
        if (cancelled || !r?.job) return;
        const job = r.job;
        if (job.kind === "file") return; // fora de escopo (ver acima)
        // seq capturada DEPOIS do fetch: se o usuário trocou de projeto durante o await, o
        // `cancelled` acima já barrou; capturar antes só criaria uma janela para o inverso.
        const seq = chatSeqRef.current;
        if (chatPollRef.current) return; // o usuário já disparou um turno novo enquanto isto voltava
        // Job JÁ TERMINAL (done, ou reprovado com spec salva): não há espera a expirar — só falta
        // buscar o resultado. Herdar um `deadline_at` vencido aqui é o que fazia a tela avisar
        // "passou do tempo máximo" para uma revisão pronta (ver comentário no `tick`).
        const terminal = job.status !== "pending" && job.status !== "running";
        const serverDeadline = job.deadlineAt ? Date.parse(job.deadlineAt) : NaN;
        const deadlineMs = terminal
          ? Date.now() + 5 * 60_000
          : (Number.isFinite(serverDeadline) ? serverDeadline : Date.now() + 40 * 60_000);
        if (job.status === "error" && !job.salvaged) {
          setChatError(job.error ?? "A revisão anterior terminou em erro.");
          return;
        }
        // `salvaged` → o job foi REPROVADO mas guarda a spec inteira. Deixa o polling seguir: o
        // GET /:jobId devolve error + specMarkdown e o ramo de erro do poll OFERECE a revisão
        // (com o motivo da reprovação) em vez de descartar ~20 min de Opus 5.
        setChatSending(true);
        setChatError(null);
        startChatPolling({
          jobId: job.jobId,
          seq,
          kind: job.kind,
          filePath: job.filePath,
          baseSha: job.baseSha,
          deadlineMs,
          // Reanexado de outra sessão → o resultado é OFERECIDO, nunca escrito no editor sozinho.
          recovered: true,
          requestedAtMs: job.createdAt ? Date.parse(job.createdAt) : undefined,
        });
      } catch { /* rehidratação é best-effort: falhar aqui só devolve a tela ao estado limpo */ }
    })();
    return () => { cancelled = true; };
  }, [editProjectId, stopChatPolling, startChatPolling]);

  // ── Histórico da conversa POR ESCOPO (projeto + arquivo aberto) ──────────────────────────────
  // Dois defeitos relatados pelo Jean em 2026-09-06 nasciam do mesmo lugar: o histórico era buscado
  // UMA vez, no efeito de troca de projeto, SEM `filePath` e com `catch {}` vazio. Consequências:
  //   (a) conversa de um arquivo específico NUNCA aparecia (o servidor filtra por `file_path`);
  //   (b) qualquer falha transitória deixava o chat vazio em silêncio — só um refresh da página
  //       dava outra chance ("nem sempre o historico carrega, as vezes preciso forçar o refresh").
  // Agora: refaz o fetch quando o ESCOPO muda, mostra estado de carga, e falha VISÍVEL com retry.
  const historyScopeKey = `${editProjectId ?? ""}|${activeFile?.path ?? ""}`;
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const retryChatHistory = useCallback(() => setHistoryRetry((n) => n + 1), []);
  useEffect(() => {
    const [projId, filePath] = [editProjectId, activeFile?.path ?? null];
    if (!projId) { setHistoryLoading(false); setHistoryError(null); return; }
    let cancelled = false;
    // `seq` de partida: se o usuário mandar uma mensagem (ou trocar de arquivo) enquanto o histórico
    // volta, o resultado é DESCARTADO — nunca por cima do turno vivo.
    const seqAtStart = chatSeqRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams({ projectId: projId, limit: "40" });
        if (filePath) qs.set("filePath", filePath);
        const h = await apiGet<{ messages: Array<{ role: "user" | "assistant"; content: string }> }>(
          `/api/spec-chat/history?${qs.toString()}`,
        );
        if (cancelled || seqAtStart !== chatSeqRef.current) return;
        const msgs = Array.isArray(h?.messages) ? h.messages : [];
        // É EXIBIÇÃO (`seeded`): não volta ao CTO, senão um pedido de dias atrás reentraria no turno.
        setChatMessages(msgs.map((m) => ({ role: m.role, content: m.content, seeded: true })));
      } catch (e) {
        if (cancelled || seqAtStart !== chatSeqRef.current) return;
        setHistoryError(e instanceof Error ? e.message : "falha ao carregar histórico");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // `historyScopeKey` é a chave real (projeto+arquivo); `historyRetry` é o botão "tentar de novo".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyScopeKey, historyRetry]);

  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    const fileMode = activeFile !== null;
    // Conteúdo-alvo: em modo por-arquivo é o arquivo ativo; senão a spec inteira.
    const contentToSend = fileMode ? activeFile!.content : specMarkdown;
    if (!contentToSend) return;
    // C1 (cliente): espelha o teto do servidor — arquivo grande seria revisado truncado.
    if (fileMode && contentToSend.length > 20_000) {
      setChatError(`Arquivo grande demais para o chat por-arquivo (${contentToSend.length} > 20000 caracteres). Edite manualmente ou divida o arquivo.`);
      return;
    }
    // Edições não salvas na árvore tornam o baseSha ambíguo → bloqueia até salvar/descartar.
    if (fileMode && treeDirty) {
      setChatError("Há edições não salvas neste arquivo. Salve ou descarte antes de pedir uma revisão por IA.");
      return;
    }
    const seq = (chatSeqRef.current += 1);
    const sentFilePath = fileMode ? activeFile!.path : null;
    const sentBaseSha = fileMode ? activeFile!.baseSha : null;
    const nextMessages: ChatMessage[] = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatSending(true);
    setChatError(null);
    setPendingApply(null);
    setApplyError(null);
    setApplyConflict(false);
    stopChatPolling();

    let jobId: string;
    let deadlineMs = Date.now() + CHAT_CLIENT_DEADLINE_MS;
    try {
      const res = await apiPost<SpecChatJobResponse>("/api/spec-chat", {
        specMarkdown: contentToSend,
        // `seeded` (histórico do banco) fica fora: é contexto de exibição, não do turno.
        messages: nextMessages.filter((m) => !m.seeded),
        projectId: editProjectId ?? undefined,
        ...(fileMode ? { filePath: sentFilePath, baseSha: sentBaseSha ?? undefined } : {}),
      });
      jobId = res.jobId;
      const d = res.deadlineAt ? Date.parse(res.deadlineAt) : NaN;
      if (Number.isFinite(d)) deadlineMs = d;
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Erro ao enviar mensagem.");
      setChatSending(false);
      return;
    }
    // O usuário trocou de arquivo enquanto o POST voltava → descarta este turno.
    if (seq !== chatSeqRef.current) { setChatSending(false); return; }

    startChatPolling({
      jobId, seq,
      kind: fileMode ? "file" : "chat",
      filePath: sentFilePath, baseSha: sentBaseSha,
      deadlineMs,
    });
  }, [chatInput, specMarkdown, chatMessages, chatSending, editProjectId, activeFile, treeDirty, stopChatPolling, startChatPolling]);

  // ── Modo autônomo (migração 090) ────────────────────────────────────────────
  // Três responsabilidades AQUI (o laço é do servidor): iniciar, pollar/desenhar e — o ponto
  // sutil — RECARREGAR a spec do editor a cada rodada. O servidor reescreve o arquivo no disco;
  // um editor com o texto velho salvaria por cima do trabalho da rodada seguinte (e a guarda de
  // edição humana do servidor abortaria o laço, acusando edição por fora).
  const reloadSpecFromServer = useCallback(async () => {
    if (!editProjectId) return;
    try {
      const data = await apiGet<{ specMarkdown: string; title: string; contentSha256?: string }>(`/api/projects/${editProjectId}/spec-content`);
      setSpecMarkdown(data.specMarkdown);
      // H2: recarregar move a BASE do If-Match — o editor passa a editar sobre o que o servidor
      // acabou de gravar (rodada do laço, restauração de versão). Sem isto o próximo salvamento
      // levaria o sha antigo e tomaria 409 por um conflito que já foi resolvido pelo recarregamento.
      setSpecBaseSha(data.contentSha256 ?? null);
    } catch { /* mantém o editor como está; o próximo tick tenta de novo */ }
  }, [editProjectId]);

  // Onda 4 (A4.3) — restaurou uma versão (G2): o servidor já reescreveu o arquivo, e é AQUI que o
  // editor deixa de mentir. Sem este recarregamento, o texto em memória continuaria o de antes e o
  // próximo "Salvar rascunho" desfaria a restauração em silêncio — exatamente o modo de falha que
  // as versões existem para consertar. A validação anterior passa a valer para outro conteúdo.
  const handleVersionRestored = useCallback(() => {
    void reloadSpecFromServer();
    setTreeReloadSignal((n) => n + 1);
    setValidationReloadSignal((n) => n + 1);
    setStaleValidation(true);
  }, [reloadSpecFromServer]);

  const refreshAutonomy = useCallback(async () => {
    if (!editProjectId) return;
    let state: AutonomyState;
    try {
      state = await apiGet<AutonomyState>(`/api/spec-autonomy?projectId=${editProjectId}`);
    } catch { return; } // falha de rede não some com o painel — o próximo tick reconsulta
    setAutonomy(state);
    const run = state.run;
    if (!run) { autonomySyncRef.current = null; return; }
    const prev = autonomySyncRef.current;
    autonomySyncRef.current = { runId: run.id, round: run.round, active: run.active };
    // Reconcilia o editor quando a rodada avançou, quando o laço terminou, ou na primeira vez que
    // encontramos um laço ATIVO (ele pode ter escrito rodadas com esta tela fechada).
    const advanced = prev?.runId === run.id && (run.round !== prev.round || (prev.active && !run.active));
    if (advanced || (!prev && run.active)) {
      await reloadSpecFromServer();
      // PR-5: no modo por arquivo quem muda no disco são os ARQUIVOS da árvore (não a spec
      // primária) — sem recarregar a árvore o usuário veria o conteúdo velho e cairia em conflito
      // de If-Match ao editar.
      if (run.mode === "per_file") setTreeReloadSignal((n) => n + 1);
      setValidationReloadSignal((n) => n + 1);
      setStaleValidation(false);
    }
  }, [editProjectId, reloadSpecFromServer]);

  useEffect(() => {
    setAutonomy(null);
    setAutonomyError(null);
    autonomySyncRef.current = null;
    if (!editProjectId) return;
    void refreshAutonomy();
  }, [editProjectId, refreshAutonomy]);

  // Poll de 15 s só enquanto o laço está ativo (tick do servidor é 20 s). Terminado, o painel
  // congela no último estado — sem timer pendurado.
  useEffect(() => {
    if (!autonomy?.run?.active) return;
    const t = setInterval(() => { void refreshAutonomy(); }, 15_000);
    return () => clearInterval(t);
  }, [autonomy?.run?.active, refreshAutonomy]);

  const handleStartAutonomy = useCallback(async () => {
    if (!editProjectId || autonomyStarting || autonomy?.run?.active) return;
    setAutonomyError(null);
    setAutonomyStarting(true);
    try {
      const res = await apiPost<{ run: AutonomyRun; maxRoundsAllowed: number }>("/api/spec-autonomy", { projectId: editProjectId });
      autonomySyncRef.current = { runId: res.run.id, round: res.run.round, active: res.run.active };
      setAutonomy({ run: res.run, enabled: true, maxRoundsAllowed: res.maxRoundsAllowed });
      setChatMessages((prev) => [...prev, {
        role: "user",
        content: `🤖 Modo autônomo iniciado — resolver GAPs, salvar e validar por até ${res.run.maxRounds} rodada(s). Só GAPs 🔴/🟡 em aberto sustentam uma nova rodada.`,
      }]);
    } catch (e) {
      setAutonomyError(e instanceof Error ? e.message : "Erro ao iniciar o modo autônomo.");
    } finally {
      setAutonomyStarting(false);
    }
  }, [editProjectId, autonomyStarting, autonomy?.run?.active]);

  const handleStopAutonomy = useCallback(async () => {
    const run = autonomy?.run;
    if (!run?.active) return;
    setAutonomyError(null);
    try {
      const res = await apiPost<{ run: AutonomyRun | null; stopped: boolean }>(`/api/spec-autonomy/${run.id}/stop`, {});
      if (res?.run) setAutonomy((prev) => (prev ? { ...prev, run: res.run } : prev));
      await refreshAutonomy();
    } catch (e) {
      setAutonomyError(e instanceof Error ? e.message : "Erro ao interromper o modo autônomo.");
    }
  }, [autonomy?.run, refreshAutonomy]);

  // Onda 1 — "Resolver GAPs": turno de chat (spec inteira) que manda o CTO corrigir os findings
  // da validação adversarial. O servidor injeta o relatório + irmãos e sintetiza a instrução;
  // aqui só logamos a solicitação/resposta no chat e aplicamos a spec revisada.
  // Migração 090: com o checkbox de modo autônomo marcado, o mesmo botão inicia o LAÇO no
  // servidor em vez de um turno único (o laço usa exatamente este mesmo caminho por rodada).
  const handleResolveGaps = useCallback(async () => {
    if (autonomyOn) { await handleStartAutonomy(); return; }
    if (chatSending || !editProjectId || !specMarkdown) return;
    const seq = (chatSeqRef.current += 1);
    const label = (gapCount ?? 0) > 0 ? `🛠️ Resolver GAPs (${gapCount})` : "🛠️ Resolver GAPs";
    setChatMessages((prev) => [...prev, { role: "user", content: label }]);
    setChatSending(true);
    setChatError(null);
    setPendingApply(null); setApplyError(null); setApplyConflict(false);
    stopChatPolling();

    let jobId: string;
    let deadlineMs = Date.now() + CHAT_CLIENT_DEADLINE_MS;
    try {
      const res = await apiPost<SpecChatJobResponse>("/api/spec-chat", {
        specMarkdown,
        // `seeded` fora do payload (histórico é exibição) — ver handleChatSend.
        messages: chatMessages.filter((m) => !m.seeded),
        projectId: editProjectId, resolveGaps: true,
      });
      jobId = res.jobId;
      const d = res.deadlineAt ? Date.parse(res.deadlineAt) : NaN;
      if (Number.isFinite(d)) deadlineMs = d;
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Erro ao resolver GAPs.");
      setChatSending(false);
      return;
    }
    if (seq !== chatSeqRef.current) { setChatSending(false); return; }

    startChatPolling({ jobId, seq, kind: "resolve_gaps", filePath: null, baseSha: null, deadlineMs });
  }, [autonomyOn, handleStartAutonomy, chatSending, editProjectId, specMarkdown, chatMessages, gapCount, stopChatPolling, startChatPolling]);

  // PR-4 (F2) — "Resolver GAPs DESTE ARQUIVO": mesma ideia do botão da spec inteira, mas escopado.
  // É este caminho que faz sentido depois de dividir a spec: o CTO recebe UM arquivo + os GAPs
  // daquele arquivo e devolve o arquivo editado (que o usuário aplica com If-Match, como no chat
  // por-arquivo). Sem isso, uma spec de 98k chars voltaria a ser reemitida inteira e truncaria.
  const fileGapCount = useMemo(() => {
    if (!activeFile || !gapScope) return null;
    return gapScope.files.find((f) => f.path === activeFile.path)?.active ?? 0;
  }, [activeFile, gapScope]);

  // Badge por arquivo na árvore: sem isto o usuário não descobre ONDE estão os GAPs de uma spec
  // dividida (a aba GAPs lista findings; o trabalho agora é arquivo a arquivo).
  const gapsByPath = useMemo(() => {
    if (!gapScope) return null;
    const map: Record<string, { active: number; blockers: number }> = {};
    for (const f of gapScope.files) {
      if (f.active > 0) map[f.path] = { active: f.active, blockers: f.blockers };
    }
    return map;
  }, [gapScope]);

  /**
   * UI/UX 2026-09-06 (item 2) — insumo da linha que RECONCILIA os totalizadores de GAP: total
   * ativo da spec, quanto está no arquivo aberto e quanto ficou SEM arquivo atribuído. Sem o
   * `unrouted` à vista, a soma dos badges da lista dava menos que o badge da aba GAPs e o
   * usuário não tinha como saber que aqueles GAPs só o caminho da spec inteira alcança.
   */
  const gapReconcile = useMemo(() => {
    if (!gapScope) return null;
    return {
      total: gapScope.totalActive,
      unrouted: gapScope.unrouted,
      fileCount: gapScope.fileCount,
      // J1: parte do `unrouted` não é "o roteador falhou" — é "o arquivo citado virou índice depois
      // desta validação". Sem distinguir, a mensagem culpa o roteador por trabalho que ele ainda vai fazer.
      stale: gapScope.staleNameMatches ?? 0,
    };
  }, [gapScope]);

  const handleResolveFileGaps = useCallback(async () => {
    if (chatSending || !editProjectId || !activeFile) return;
    if (treeDirty) {
      setChatError("Há edições não salvas neste arquivo. Salve ou descarte antes de pedir uma revisão por IA.");
      return;
    }
    const seq = (chatSeqRef.current += 1);
    const sentFilePath = activeFile.path;
    const sentBaseSha = activeFile.baseSha;
    setChatMessages((prev) => [...prev, {
      role: "user",
      content: `🛠️ Resolver GAPs de \`${sentFilePath}\`${fileGapCount ? ` (${fileGapCount})` : ""}`,
    }]);
    setChatSending(true);
    setChatError(null);
    setPendingApply(null); setApplyError(null); setApplyConflict(false);
    stopChatPolling();

    let jobId: string;
    let deadlineMs = Date.now() + CHAT_CLIENT_DEADLINE_MS;
    try {
      const res = await apiPost<SpecChatJobResponse>("/api/spec-chat", {
        specMarkdown: activeFile.content,
        messages: [],
        projectId: editProjectId,
        resolveGaps: true,
        filePath: sentFilePath,
        baseSha: sentBaseSha ?? undefined,
      });
      jobId = res.jobId;
      const d = res.deadlineAt ? Date.parse(res.deadlineAt) : NaN;
      if (Number.isFinite(d)) deadlineMs = d;
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Erro ao resolver os GAPs deste arquivo.");
      setChatSending(false);
      return;
    }
    if (seq !== chatSeqRef.current) { setChatSending(false); return; }

    // kind "file": o resultado é OFERECIDO para "Aplicar ao arquivo" (com If-Match no baseSha),
    // exatamente como uma revisão pedida por chat — nunca escrito por cima sem confirmação.
    startChatPolling({ jobId, seq, kind: "file", filePath: sentFilePath, baseSha: sentBaseSha, deadlineMs });
  }, [chatSending, editProjectId, activeFile, treeDirty, fileGapCount, stopChatPolling, startChatPolling]);

  // Evoluir E2 — pede ao arquiteto da Bancada os artefatos da evolução. Job assíncrono no
  // servidor (/invoke/raw); ao terminar, a árvore é recarregada e o resumo/pendências vão ao chat.
  const handleEvolvePlan = useCallback(async () => {
    if (chatSending || !editProjectId) return;
    const seq = (chatSeqRef.current += 1);
    // O texto do chat só vira pedido de evolução na spec INTEIRA — em modo por-arquivo o campo
    // é uma instrução ao editor do arquivo, não um pedido (evita mandar texto acidental).
    const override = activeFile ? "" : chatInput.trim();
    setChatMessages((prev) => [...prev, { role: "user", content: override ? `🧭 Gerar RFC / CHANGELOG — pedido: ${override}` : "🧭 Gerar RFC / CHANGELOG da evolução (pedido original)" }]);
    if (override) setChatInput("");
    setChatSending(true);
    setChatError(null);
    stopChatPolling();

    let jobId: string;
    try {
      const res = await apiPost<{ jobId: string }>(`/api/projects/${editProjectId}/evolution-plan`, override ? { request: override } : {});
      jobId = res.jobId;
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Erro ao iniciar o planejamento da evolução.");
      setChatSending(false);
      return;
    }
    if (seq !== chatSeqRef.current) { setChatSending(false); return; }

    type PlanPoll = {
      status: "pending" | "running" | "done" | "error" | "interrupted";
      error?: string | null;
      result?: {
        summary: string; compat: string; questions: string[]; warnings: string[];
        written: Array<{ path: string; action: string }>;
        rfcProblems: Array<{ path: string; problems: string[] }>;
      } | null;
    };
    const startTs = Date.now();
    let pollErrors = 0;
    chatPollRef.current = setInterval(async () => {
      if (seq !== chatSeqRef.current) { stopChatPolling(); return; }
      if (Date.now() - startTs > 8 * 60_000) {
        stopChatPolling(); setChatError("Tempo esgotado ao planejar a evolução. Tente novamente."); setChatSending(false); return;
      }
      try {
        const poll = await apiGet<PlanPoll>(`/api/projects/${editProjectId}/evolution-plan/${jobId}`);
        pollErrors = 0;
        if (seq !== chatSeqRef.current) { stopChatPolling(); return; }
        if (poll.status === "done" && poll.result) {
          stopChatPolling();
          const r = poll.result;
          // 🔴 GAP-60: "já existia — mantido" se lia como "nada a fazer", quando na verdade o conteúdo
          // que o arquiteto propôs foi DESCARTADO (o arquivo atual venceu). O aviso detalhado vem em
          // `warnings`; aqui o rótulo deixa de ser tranquilizador.
          const files = r.written.map((w) => `- \`${w.path}\` (${w.action === "created" ? "criado" : w.action === "updated" ? "atualizado" : "⚠️ já existia — proposta DESCARTADA"})`).join("\n");
          const problems = r.rfcProblems.length
            ? `\n\n⚠️ **Pendências para o gate de promoção:**\n${r.rfcProblems.map((p) => `- \`${p.path}\`: ${p.problems.join("; ")}`).join("\n")}`
            : "";
          const warns = r.warnings.length ? `\n\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "";
          const qs = r.questions.length ? `\n\n❓ **Perguntas do arquiteto** (responda editando o RFC ou pelo chat do arquivo):\n${r.questions.map((q) => `- ${q}`).join("\n")}` : "";
          setChatMessages((prev) => [...prev, {
            role: "assistant",
            content: `${r.summary || "Artefatos de evolução gerados."}\n\n**Compatibilidade:** ${r.compat.toUpperCase()}\n\n**Arquivos:**\n${files}${problems}${warns}${qs}\n\n➡️ Revise os arquivos na árvore (o \`## Impacto\` do RFC define o que a fábrica PODE tocar). Quando estiver satisfeito, **Validar** e promover à fábrica.`,
          }]);
          setTreeReloadSignal((n) => n + 1);
          setValidationReloadSignal((n) => n + 1);
          setStaleValidation(true);
          setChatSending(false);
        } else if (poll.status === "error" || poll.status === "interrupted") {
          // H3: 'interrupted' = reinício do servidor (job persistido, estado terminal com causa) — recuperável: clicar de novo.
          stopChatPolling();
          setChatError(poll.error ?? (poll.status === "interrupted" ? "Planejamento interrompido por reinício do servidor — clique de novo." : "Erro ao planejar a evolução."));
          setChatSending(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pollErrors += 1;
        // Job em memória: reinício da API → 404 "expirado". Não ficar 8 min em silêncio.
        if (/NOT_FOUND|404|expirado/i.test(msg) || pollErrors >= 5) {
          stopChatPolling();
          setChatError(/NOT_FOUND|404|expirado/i.test(msg)
            ? "O planejamento foi perdido (reinício do servidor). Clique de novo em \"Gerar RFC / CHANGELOG\"."
            : `Falha ao consultar o planejamento: ${msg}`);
          setChatSending(false);
          return;
        }
        console.warn("[EvolvePlan] poll error:", msg);
      }
    }, 5000);
  }, [chatSending, editProjectId, chatInput, activeFile, stopChatPolling]);

  // T4.3 — aplica a revisão pendente ao arquivo real (PUT com baseSha → If-Match).
  const applyRevision = useCallback(async (baseShaOverride?: string | null) => {
    if (!editProjectId || !pendingApply) return;
    setApplying(true); setApplyError(null);
    try {
      const r = await apiPut<{ ok: boolean; contentSha256: string }>(
        `/api/projects/${editProjectId}/spec-file?path=${encodeURIComponent(pendingApply.path)}`,
        { content: pendingApply.content, baseSha: baseShaOverride ?? pendingApply.baseSha ?? undefined },
      );
      // Aplicado: atualiza o arquivo ativo, limpa a revisão, recarrega a árvore (H2) e
      // marca a validação como possivelmente desatualizada + refetch (M3).
      const appliedPath = pendingApply.path;
      const appliedContent = pendingApply.content;
      setActiveFile((prev) => (prev && prev.path === appliedPath
        ? { ...prev, content: appliedContent, baseSha: r.contentSha256 } : prev));
      // UI/UX 2026-09-06 — o editor principal mostra `fileDraft`: sem isto a revisão da IA era
      // gravada no servidor e a tela continuava exibindo o texto anterior.
      if (activeFileRef.current?.path === appliedPath) { setFileDraft(appliedContent); setTreeDirty(false); }
      setPendingApply(null);
      setApplyConflict(false);
      setTreeReloadSignal((n) => n + 1);
      setValidationReloadSignal((n) => n + 1);
      setStaleValidation(true);
      setChatMessages((prev) => [...prev, { role: "assistant", content: `✓ Revisão aplicada a ${appliedPath}.` }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("mudou desde") || msg.toUpperCase().includes("CONFLICT")) setApplyConflict(true);
      else setApplyError(msg);
    } finally { setApplying(false); }
  }, [editProjectId, pendingApply]);

  const handleApplyFile = useCallback(() => { void applyRevision(); }, [applyRevision]);
  const handleDiscardApply = useCallback(() => {
    setPendingApply(null); setApplyError(null); setApplyConflict(false);
  }, []);
  // M1 — sobrescrever: lê o sha atual do arquivo e reaplica por cima (a outra edição é perdida, avisado na UI).
  const handleOverwriteApply = useCallback(async () => {
    if (!editProjectId || !pendingApply) return;
    setApplying(true); setApplyError(null);
    try {
      const cur = await apiGet<{ contentSha256: string }>(
        `/api/projects/${editProjectId}/spec-file?path=${encodeURIComponent(pendingApply.path)}`,
      );
      await applyRevision(cur.contentSha256);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  }, [editProjectId, pendingApply, applyRevision]);

  // Migração 089 — revisão da spec inteira recuperada de outra sessão. Só entra no editor por
  // clique: entre o fim do job e a volta do usuário a spec pode ter sido editada à mão, e
  // sobrescrever isso em silêncio seria trocar uma perda de trabalho por outra.
  const handleApplyRecovered = useCallback(() => {
    if (!recoveredSpec) return;
    setSpecMarkdown(recoveredSpec.content);
    setStaleValidation(true);
    setChatMessages((prev) => [...prev, {
      role: "assistant",
      content: recoveredSpec.truncated
        // T1: o humano escolheu aplicar um documento INCOMPLETO — o aviso vai com ele até o Salvar.
        ? `⚠️ Revisão **INCOMPLETA** aplicada ao editor (${recoveredSpec.content.length} caracteres) — ela foi cortada no limite de saída do modelo.\n\n🔴 **Antes de "Salvar rascunho", confira o fim do documento**: o que o modelo não chegou a reescrever será apagado da spec ao salvar.`
        : `✓ Revisão recuperada aplicada ao editor (${recoveredSpec.content.length} caracteres).\n\n➡️ Clique em **"Salvar rascunho"** para persistir e revalidar.`,
    }]);
    setRecoveredSpec(null);
  }, [recoveredSpec]);
  const handleDiscardRecovered = useCallback(() => setRecoveredSpec(null), []);

  /**
   * B9 — ÚNICO ponto de escrita da spec inteira (`PATCH /spec-content`). Havia duas cópias desta
   * chamada (salvar e promover) e elas podiam divergir em silêncio: a que promove GRAVA a spec antes
   * de admitir, porque a fábrica lê o disco, não o editor.
   * `startNow: false` é explícito — nunca inicia nada a partir da Bancada.
   */
  const persistSpecMarkdown = useCallback(async (baseShaOverride?: string | null) => {
    if (!editProjectId) throw new Error("Sem projeto em edição.");
    const base = baseShaOverride !== undefined ? baseShaOverride : specBaseSha;
    try {
      const r = await apiPatch<{ ok: boolean; contentSha256?: string }>(`/api/projects/${editProjectId}/spec-content`, {
        specMarkdown,
        title: projectTitle.trim() || undefined,
        startNow: false,
        ...(base ? { baseSha: base } : {}),
      });
      // H2 — a base avança para o que ACABOU de ser gravado; sem isto o segundo salvamento seguido
      // levaria o sha da carga inicial e tomaria 409 contra a própria escrita anterior.
      if (r.contentSha256) setSpecBaseSha(r.contentSha256);
      setSpecSaveConflict(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409 do If-Match: NADA foi gravado. O texto do humano segue no editor e ele escolhe o
      // desfecho no diálogo (recarregar ou sobrescrever) — falhar sem saída seria pior que o risco.
      if (msg.includes("mudou desde") || msg.toUpperCase().includes("CONFLICT")) setSpecSaveConflict(true);
      throw e;
    }
  }, [editProjectId, specMarkdown, projectTitle, specBaseSha]);

  /** H2 — desfecho 1: fica com a versão do servidor (o texto do editor é descartado). */
  const handleSpecConflictReload = useCallback(async () => {
    setSpecConflictBusy(true);
    await reloadSpecFromServer();
    setSpecSaveConflict(false);
    setApproveError(null);
    setValidationReloadSignal((n) => n + 1);
    setStaleValidation(true);
    setSpecConflictBusy(false);
  }, [reloadSpecFromServer]);

  /** H2 — desfecho 2: grava por cima. A versão do servidor NÃO se perde (snapshot → "Versões"). */
  const handleSpecConflictOverwrite = useCallback(async () => {
    if (!editProjectId) return;
    setSpecConflictBusy(true);
    try {
      const cur = await apiGet<{ contentSha256?: string }>(`/api/projects/${editProjectId}/spec-content`);
      await persistSpecMarkdown(cur.contentSha256 ?? null);
      setSpecSaveConflict(false);
      setApproveError(null);
      setTreeReloadSignal((n) => n + 1);
      setValidationReloadSignal((n) => n + 1);
      setStaleValidation(true);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e));
    } finally { setSpecConflictBusy(false); }
  }, [editProjectId, persistSpecMarkdown]);

  /**
   * B1 — escopo REAL da promoção, para o rótulo/tooltip/confirmação. `null` = ainda não sei quem é o
   * dono (rótulo genérico); `spec` = dono é o INBOX "Rascunhos" (que não é produto) ou não há dono;
   * `product` = produto real → o clique admite o produto INTEIRO.
   */
  const promoteScope = useMemo<PromoteScope | null>(() => {
    if (!editProjectId || !ownerProduct) return null;
    if (!ownerProduct.id) return "spec";
    const owner = products.find((p) => p.id === ownerProduct.id);
    if (!owner) return null;                       // lista ainda não carregou → não afirma escopo
    return owner.is_inbox === true ? "spec" : "product";
  }, [editProjectId, ownerProduct, products]);

  /** Projetos ainda na Bancada no mesmo produto — só para o humano dimensionar o escopo. */
  const promoteSiblings = useMemo(() => {
    if (promoteScope !== "product" || !ownerProduct?.id) return null;
    return allProjects.filter((p) => p.productId === ownerProduct.id && p.status === "draft").length || null;
  }, [promoteScope, ownerProduct, allProjects]);

  // ── Save spec (SEMPRE rascunho) ─────────────────────────────────────────────
  // Migração 097: o botão "Promover à fábrica" usa `promoteToFactory` (abaixo) — salva e ADMITE
  // sem iniciar. B5 da revisão adversarial (2026-09-06): o caminho `startNow: true` que existia
  // aqui e no upload NÃO tinha chamador nenhum (só `false` era passado) e ainda assim mantinha um
  // `POST /projects/:id/run` pronto para reabrir o "promover = iniciar" que a 097 fechou.
  // Foi removido: salvar na Bancada é SEMPRE rascunho; iniciar é decisão de outra tela.
  const handleSaveSpec = useCallback(async () => {
    if (!specMarkdown) return;
    // INTAKE-GATE (espelha o backend): título e tipo são obrigatórios; texto livre >=500 letras.
    if (!editProjectId) {
      if (!projectTitle.trim()) { setApproveError("Informe o Título do projeto."); return; }
      if (!projectType) { setApproveError("Selecione o Tipo do projeto."); return; }
      if (freeText.trim() && freeText.trim().length < MIN_FREE_TEXT_CHARS) {
        setApproveError(`A descrição em texto livre precisa de no mínimo ${MIN_FREE_TEXT_CHARS} caracteres.`); return;
      }
    }
    setApproving("save"); setApproveError(null);
    try {
      // Modo edição: PATCH spec existente sem criar novo projeto
      if (editProjectId) {
        await persistSpecMarkdown();
        projectsStore.loadProjects();
        // "Salvar rascunho" FICA na tela do editor: a spec foi persistida no disco, então
        // revalidamos para que a lista de GAPs reflita a spec nova (os GAPs resolvidos SOMEM; a run
        // antiga fica como histórico em spec_validation_runs). Trazemos o usuário à aba GAPs.
        setApproving(null);
        setStaleValidation(false);
        setChatMessages((prev) => [...prev, { role: "assistant", content: "💾 Rascunho salvo. Revalidando os GAPs na spec nova…" }]);
        setOpenGapsSignal((n) => n + 1);            // mostra a aba GAPs (monta o painel de validação)
        try { await apiPost(`/api/specs/${editProjectId}/validate`, {}); } catch { /* dedupe/rate-limit → o reload abaixo mostra o estado */ }
        setValidationReloadSignal((n) => n + 1);    // painel recarrega → vê "validando" → poll ao vivo → atualiza badge/lista
        return;
      }

      // Modo criação: POST nova spec
      const blob = new Blob([specMarkdown], { type: "text/markdown" });
      const filename = `${(projectTitle || "spec").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const file = new File([blob], filename, { type: "text/markdown" });
      const formData = new FormData();
      formData.append("title", projectTitle.trim());
      formData.append("intakeMode", "free_text");
      if (parentProjectId) formData.append("parentProjectId", parentProjectId);
      if (freeText.trim()) formData.append("freeDescription", freeText.trim());
      if (projectType) formData.append("projectType", projectType);
      // §5.3: SEMPRE envia productId. Normalmente é o INBOX (default effect) ou o produto
      // herdado do pai; vazio só no fallback raro → o backend resolve para o inbox do tenant.
      formData.append("productId", productId);
      if (projectType) {
        formData.append("deliveryMode", deliveryMode);
        if (isBackendType) {
          if (runtimeTarget) formData.append("runtimeTarget", runtimeTarget);
          if (dbMode) formData.append("dbMode", dbMode);
          if (domainMode) formData.append("domainMode", domainMode);
        }
      }
      // Item 2: pré-seleção de deploy na nuvem (conexão + formato + prazo demo) — default do cockpit.
      if (cloudConnId) {
        formData.append("cloudConnectionId", cloudConnId);
        if (deployFormat) formData.append("deployFormat", deployFormat);
        if (deliveryMode === "demo") formData.append("ttlDays", String(deployTtlDays));
      }
      // Item 3: Ferramentas UI/UX — conta + arquivos Figma escolhidos (fileKeys); o backend
      // extrai as definições de design e injeta um documento UI/UX no bundle da spec.
      if (uiuxConnId && uiuxProjectIds.length > 0) {
        formData.append("uiuxConnectionId", uiuxConnId);
        uiuxProjectIds.forEach((pid) => formData.append("uiuxProjectIds", pid));
      }
      // SPEC-APPROVED: CTO valida (Sub-modo C) em vez de regenerar.
      if (specApproved) {
        formData.append("specApproved", "true");
        const approver = authStore.user?.email || authStore.user?.name;
        if (approver) formData.append("approvedBy", approver);
      }
      formData.append("files", file);
      // RASCUNHO: a spec criada na Bancada nasce SEMPRE como 'draft' (aguardando promoção +
      // início manual), não 'spec_submitted' — o portal mostra "Rascunho" com ações, em vez de
      // "Em execução" sem nada rodando.
      formData.append("draft", "true");
      const data = await apiPostMultipart<SubmitResponse>("/api/specs", formData);
      projectsStore.loadProjects();

      // Add to product if selected
      if (productId && data.projectId) {
        try { await apiPost(`/api/products/${productId}/projects/${data.projectId}`, {}); } catch { /* non-critical */ }
      }
      // Create link to another project if selected
      if (linkProjectId && data.projectId) {
        try { await apiPost(`/api/projects/${data.projectId}/links`, { to_project_id: linkProjectId, relation_type: linkRelation }); } catch { /* non-critical */ }
      }

      setTimeout(() => router.push(`/projects/${data.projectId}`), 500);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Erro ao salvar spec.");
    } finally {
      setApproving(null);
    }
  }, [specMarkdown, projectTitle, parentProjectId, editProjectId, freeText, uiuxConnId, uiuxProjectIds,
      projectType, deliveryMode, cloudConnId, deployFormat, deployTtlDays, router, persistSpecMarkdown]);

  // ── Promoção à fábrica (migração 097) ───────────────────────────────────────
  // Requisito do Jean (2026-09-06): este botão promove o PRODUTO TODO, na ordem de
  // interdependência, e NÃO inicia nada. Duas rotas, escolhidas pelo dono da spec:
  //   • spec dentro de um produto real → POST /api/products/:id/promote → admite TODOS os
  //     projetos do produto em ondas (agente arquiteto decide a ordem) e abre o plano;
  //   • spec solta (dona é o INBOX "Rascunhos", que NÃO é produto) → POST /api/projects/:id/promote
  //     → admite só esta spec. Promover o INBOX inteiro seria empurrar rascunhos alheios à fábrica.
  // Em ambos os casos a spec é PERSISTIDA antes (`startNow: false`): a fábrica lê o disco, não o
  // editor — promover sem salvar admitiria a versão velha.
  const promoteToFactory = useCallback(async () => {
    if (!editProjectId || !specMarkdown) return;
    setApproving("start");
    setApproveError(null); setPlanError(null); setStartedNotice(null);
    try {
      await persistSpecMarkdown();

      // Dono da spec pela fonte autoritativa (o `?productId=` da URL é só navegação da árvore e
      // `allProjects` pode nem ter carregado — errar aqui promoveria o escopo errado).
      const detail = await apiGet<{ productId: string | null; productName?: string | null }>(
        `/api/projects/${editProjectId}`,
      );
      const ownerId = detail.productId ?? null;
      let owner = ownerId ? products.find((p) => p.id === ownerId) : undefined;
      if (ownerId && !owner) {
        // Sem a lista não dá para saber se o dono é o INBOX → cai no promote de UMA spec (escopo menor).
        const fresh = await reloadProducts();
        owner = fresh?.find((p) => p.id === ownerId);
      }
      const promoteWholeProduct = !!ownerId && owner !== undefined && owner.is_inbox !== true;

      if (promoteWholeProduct && ownerId) {
        const res = await apiPost<{
          promotionId?: string; promoted?: string[]; lifecycleStatus?: string; started?: boolean;
          waves?: number; plan?: PromotionPlanItem[]; notes?: string | null;
          warnings?: string[]; edgesSource?: string | null; modelUsed?: string | null;
        }>(`/api/products/${ownerId}/promote`, {});
        setPlanProduct({ id: ownerId, name: owner?.name ?? detail.productName ?? "Produto" });
        setPlanMeta({
          promotionId: res.promotionId ?? null,
          status: res.lifecycleStatus ?? "promoted",
          notes: res.notes ?? null,
          warnings: res.warnings ?? [],
          edgesSource: res.edgesSource ?? null,
          modelUsed: res.modelUsed ?? null,
        });
        setPlanItems(res.plan ?? []);
        setStartedNotice(promotedProductNotice((res.promoted ?? []).length, res.waves ?? 0));
        setPlanOpen(true);
        projectsStore.loadProjects();
        return;
      }

      await apiPost(`/api/projects/${editProjectId}/promote`, {});
      projectsStore.loadProjects();
      setChatMessages((prev) => [...prev, {
        role: "assistant",
        content: `🏭 ${PROMOTED_SPEC_NOTICE}`,
      }]);
      setTimeout(() => router.push(`/projects/${editProjectId}`), 400);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Erro ao promover à fábrica.");
    } finally {
      setApproving(null);
    }
  }, [editProjectId, specMarkdown, products, router, persistSpecMarkdown, reloadProducts]);

  /** GAPs abertos → confirmação N2 (digitada). Sem GAPs, o texto do diálogo é apenas informativo. */
  const promoteNeedsWord = (gapCount ?? 0) > 0;
  /**
   * Escada de guardas por CONSEQUÊNCIA (B7):
   *  • GAPs abertos → N2, digitar a palavra (risco de CONTEÚDO, independentemente do escopo);
   *  • escopo `product` (ou ainda desconhecido) → N1, confirmação simples: o clique admite N projetos
   *    e paga o planejador de ondas. Antes ia direto, com o rótulo de uma spec só;
   *  • escopo `spec` sem GAPs → direto: admite um projeto e é reversível pelo "Devolver à Bancada".
   */
  const handlePromote = useCallback(() => {
    if (promoteNeedsWord || promoteScope !== "spec") {
      setPromoteConfirmText("");
      setPromoteOpen(true);
      return;
    }
    void promoteToFactory();
  }, [promoteNeedsWord, promoteScope, promoteToFactory]);

  const confirmPromote = useCallback(() => {
    setPromoteOpen(false);
    void promoteToFactory();
  }, [promoteToFactory]);

  /** Inicia a onda pendente mais baixa do produto promovido (POST /:id/start) e recarrega o plano. */
  const startPromotedProduct = useCallback(async () => {
    if (!planProduct) return;
    setPlanStarting(true); setPlanError(null); setStartedNotice(null);
    try {
      const res = await apiPost<StartWaveResult>(`/api/products/${planProduct.id}/start`, {});
      // Motivo do SERVIDOR (medido em prod: `SPEC_NOT_VALIDATED` era escondido atrás de "ignorado(s)").
      const { message, severity } = describeStartResult(res);
      setStartedNotice(message);
      setStartedSeverity(severity);
      try {
        const plan = await apiGet<{ promotion?: PromotionPlanMeta; items?: PromotionPlanItem[] }>(
          `/api/products/${planProduct.id}/promotion`,
        );
        if (plan.promotion) setPlanMeta(plan.promotion);
        setPlanItems(plan.items ?? []);
      } catch { /* o aviso acima já conta o que aconteceu */ }
      projectsStore.loadProjects();
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : "Erro ao iniciar o produto.");
    } finally {
      setPlanStarting(false);
    }
  }, [planProduct]);

  // Publica o "salvar spec inteira" no ref lido por `handleSaveCurrent` (declarado antes daqui).
  useEffect(() => { handleSaveSpecRef.current = handleSaveSpec; }, [handleSaveSpec]);

  // ── Pivô Bancada (Opção 1): árvore "Pasta do produto" dirige o editor ───────
  // Clicar num arquivo da árvore navega o editor para o projeto dono. O editor, o chat "Melhorar
  // com IA" e a Validação/GAPs já são por-projeto; então trocar de PROJETO = trocar de
  // editProjectId (mesma página /spec).
  //
  // UI/UX 2026-09-06: quem trata o clique agora é `handleOpenTreeFile` — ele leva também o
  // CAMINHO do arquivo (na URL, `?file=`) e abre o arquivo no editor principal. O antigo
  // `openProductFile` descartava o caminho e, em spec dividida, abrir qualquer arquivo caía sempre
  // no primário — que é exatamente o motivo de existir a segunda lista que o Jean mandou matar.

  // ── Upload flow ─────────────────────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) { setFiles((p) => [...p, ...Array.from(e.target.files!)]); setUploadError(null); }
    e.target.value = "";
  };
  const removeFile = (i: number) => setFiles((p) => p.filter((_, idx) => idx !== i));
  // B5: o parâmetro `startNow` saiu daqui. Upload na Bancada cria SEMPRE rascunho — nenhum chamador
  // passava `true`, e o `POST /run` que ele guardava reabria o "promover = iniciar" fechado na 097.
  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // INTAKE-GATE (espelha o backend): título e tipo obrigatórios; pelo menos 1 anexo.
    if (!projectTitle.trim()) { setUploadError("Informe o Título do projeto."); return; }
    if (!projectType) { setUploadError("Selecione o Tipo do projeto."); return; }
    if (!files.length) { setUploadError("Selecione pelo menos um arquivo."); return; }
    // Tetos do multipart da API checados aqui (mensagem clara em vez de 413 opaco).
    if (files.length > MAX_UPLOAD_FILES) { setUploadError(`Envie no máximo ${MAX_UPLOAD_FILES} arquivos por vez.`); return; }
    const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (tooBig) { setUploadError(`“${tooBig.name}” excede ${formatFileSize(MAX_UPLOAD_BYTES)}.`); return; }
    setSubmitting(true); setUploadError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append("title", projectTitle.trim());
      fd.append("intakeMode", "attachments");
      if (parentProjectId) fd.append("parentProjectId", parentProjectId);
      if (projectType) fd.append("projectType", projectType);
      // §5.3: SEMPRE envia productId (ver handleSaveSpec). Vazio → backend resolve o inbox.
      fd.append("productId", productId);
      if (projectType) {
        fd.append("deliveryMode", deliveryMode);
        if (isBackendType) {
          if (runtimeTarget) fd.append("runtimeTarget", runtimeTarget);
          if (dbMode) fd.append("dbMode", dbMode);
          if (domainMode) fd.append("domainMode", domainMode);
        }
      }
      // Item 2: pré-seleção de deploy na nuvem (conexão + formato + prazo demo) — default do cockpit.
      if (cloudConnId) {
        fd.append("cloudConnectionId", cloudConnId);
        if (deployFormat) fd.append("deployFormat", deployFormat);
        if (deliveryMode === "demo") fd.append("ttlDays", String(deployTtlDays));
      }
      // Item 3: Ferramentas UI/UX — conta + projetos escolhidos; backend extrai e injeta doc UI/UX.
      if (uiuxConnId && uiuxProjectIds.length > 0) {
        fd.append("uiuxConnectionId", uiuxConnId);
        uiuxProjectIds.forEach((pid) => fd.append("uiuxProjectIds", pid));
      }
      // SPEC-APPROVED: sinaliza ao backend/runner que o CTO deve VALIDAR (Sub-modo C), não regenerar.
      if (specApproved) {
        fd.append("specApproved", "true");
        const approver = authStore.user?.email || authStore.user?.name;
        if (approver) fd.append("approvedBy", approver);
      }
      files.forEach((f) => fd.append("files", f));
      // RASCUNHO: o upload na Bancada nasce SEMPRE como 'draft' (promover é outro clique).
      fd.append("draft", "true");
      const data = await apiPostMultipart<SubmitResponse>("/api/specs", fd);
      setResult(data);
      projectsStore.loadProjects();
      // Onda 4: com o switch ligado, a spec fica salva como rascunho e o DecomposeDialog abre
      // por cima (modo spec, source 'upload') em vez de navegar. Fechar sem salvar → /projects/:id
      // (a spec segue no INBOX com "Decompor" disponível na Bancada); salvar → /products/:id.
      if (data.projectId && canDecomposeOnUpload && decomposeOnUpload) {
        setDecomposeTarget({ id: data.projectId, title: projectTitle.trim() || "Spec enviada" });
        return;
      }
      if (data.projectId) setTimeout(() => router.push(`/projects/${data.projectId}`), 800);
    } catch (err) { setUploadError(describeUploadError(err)); }
    finally { setSubmitting(false); }
  };

  // Migração 090 — os mesmos props do modo autônomo nos QUATRO pontos onde o SpecChatPanel é
  // renderizado (inline, tela cheia, mobile e modo criação). Um objeto só evita que um deles
  // fique para trás e o checkbox "desapareça" no mobile.
  const autonomyPanelProps = {
    autonomyOn,
    onAutonomyToggle: setAutonomyOn,
    autonomy,
    autonomyError,
    autonomyStarting,
    onStopAutonomy: handleStopAutonomy,
    onShowAutonomy: handleShowAutonomy,
    // UI/UX 2026-09-06 — inicia o laço a partir de QUALQUER arquivo (o laço é do projeto).
    onStartAutonomy: handleStartAutonomy,
  };

  // ── Árvore única (UI/UX 2026-09-06) ────────────────────────────────────────────────────────
  // A lista de arquivos existe sempre que há um projeto aberto — com ou sem `?productId=`. Antes
  // ela era gated em `treeProductId`: entrando pela /specs ou /projects/:id (sem produto na URL) a
  // Bancada ficava SEM lista nenhuma, e a spec dividida em 11 arquivos era ineditável arquivo a
  // arquivo. `productId=""` põe a árvore em modo projeto-único.
  // `|| treeProductId`: no fluxo de CRIAÇÃO com produto na URL a árvore continua sendo navegável
  // (só leitura) como já era antes desta mudança — lá não há projeto aberto para editar.
  const showTree = !!editProjectId || !!treeProductId;
  const specEditable = specFileMeta?.editable === true;

  // Estado da proposta de divisão lido pela PÁGINA (não só pelo diálogo): é o que decide se o
  // ícone aparece e se há decisão pendente. Sem isto o ícone teria que estar sempre visível — ou,
  // pior, uma proposta pronta ficaria invisível atrás de um diálogo fechado.
  useEffect(() => {
    if (!editProjectId || isEvolution) { setSplitState(null); return; }
    let alive = true;
    apiGet<{ enabled: boolean; proposal: { awaitingDecision: boolean; active: boolean } | null }>(
      `/api/spec-split?projectId=${encodeURIComponent(editProjectId)}`,
    )
      .then((s) => {
        if (!alive) return;
        setSplitState({
          enabled: s.enabled === true,
          awaitingDecision: s.proposal?.awaitingDecision === true,
          active: s.proposal?.active === true,
        });
      })
      .catch(() => { if (alive) setSplitState(null); });
    return () => { alive = false; };
  }, [editProjectId, isEvolution, treeReloadSignal]);

  // Ações da LISTA de arquivos: criar arquivo, criar RFC e dividir a spec. Jean: o gatilho da
  // divisão "pode também ser um botão ícone na lista de arquivos junto com outros (como: Excluir)".
  const treeHeaderActions = specEditable ? (
    <>
      <Tooltip title="Novo arquivo na spec">
        <IconButton size="small" aria-label="Novo arquivo na spec" onClick={() => void handleCreateSpecFile()}
          sx={{ p: 0.25, color: "#8B949E", "&:hover": { color: "#58A6FF" } }}>
          <NoteAddOutlinedIcon sx={{ fontSize: "0.95rem" }} />
        </IconButton>
      </Tooltip>
      {isEvolution && (
        <Tooltip title="Novo RFC a partir do modelo">
          <IconButton size="small" aria-label="Novo RFC a partir do modelo" onClick={() => void handleCreateRfc()}
            sx={{ p: 0.25, color: "#8B949E", "&:hover": { color: "#58A6FF" } }}>
            <PostAddOutlinedIcon sx={{ fontSize: "0.95rem" }} />
          </IconButton>
        </Tooltip>
      )}
      {/* Divisão: só faz sentido na spec base (em evolução os artefatos são RFC/CHANGELOG) e só
          quando o servidor tem o recurso ligado — ou quando existe proposta aguardando decisão. */}
      {!isEvolution && splitState && (splitState.enabled || splitState.awaitingDecision) && (
        <Tooltip title={splitState.awaitingDecision
          ? "Proposta de divisão pronta — aguardando a sua decisão"
          : splitState.active ? "Os agentes estão dividindo a spec…" : "Dividir a spec em arquivos por tema"}>
          <IconButton size="small" aria-label="Dividir a spec em arquivos" onClick={() => setSplitOpen(true)}
            sx={{ p: 0.25, color: splitState.awaitingDecision ? "#F59E0B" : "#8B949E", "&:hover": { color: "#58A6FF" } }}>
            <CallSplitIcon sx={{ fontSize: "0.95rem" }} />
          </IconButton>
        </Tooltip>
      )}
    </>
  ) : null;

  // Os MESMOS props nas três instâncias da árvore (rail ≥lg, painel "Arquivos" da tela cheia e
  // diálogo do mobile) — a lista tem que se comportar igual nos três lugares.
  const treeNavProps = {
    productId: treeProductId,
    currentProjectId: editProjectId,
    currentFilePath: activeFile?.path ?? null,
    onOpen: handleOpenTreeFile,
    onOpenFolder: handleOpenTreeFolder,
    gapsByPath,
    // UI/UX 2026-09-06 (item 2) — o que NÃO está nos badges, dito no cabeçalho da lista.
    gapsUnrouted: gapScope?.unrouted ?? null,
    editable: specEditable,
    onDeleteFile: handleDeleteSpecFile,
    headerActions: treeHeaderActions,
    onProjectMeta: handleTreeMeta,
    reloadSignal: treeReloadSignal,
  };

  const splitDialog = editProjectId ? (
    <Dialog open={splitOpen} onClose={() => setSplitOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: "1rem", display: "flex", alignItems: "center", gap: 1 }}>
        <CallSplitIcon sx={{ fontSize: "1.1rem", color: "primary.main" }} />
        Dividir a spec em arquivos
      </DialogTitle>
      <DialogContent dividers>
        <SpecSplitPanel
          key={editProjectId}
          projectId={editProjectId}
          editable={specEditable}
          embedded
          onStateChange={setSplitState}
          onApplied={() => {
            void reloadSpecFromServer();
            handleFileSelected(null); // o primário virou índice: o arquivo aberto pode não existir mais
            setOpenFile(null);
            setTreeReloadSignal((n) => n + 1);
            setValidationReloadSignal((n) => n + 1);
            setStaleValidation(true);
          }}
        />
      </DialogContent>
    </Dialog>
  ) : null;

  // ── Editor fullscreen dialog ────────────────────────────────────────────────
  const editorDialog = specMarkdown !== null && (
    <Dialog open={editorFullscreen} onClose={() => setEditorFullscreen(false)} fullScreen
      PaperProps={{ sx: { bgcolor: "background.default", m: 0 } }}>
      <DialogContent sx={{ p: 0, height: "100vh", display: "flex", flexDirection: "column" }}>
        {approveError && <Alert severity="error" sx={{ mx: 2, mt: 1 }} onClose={() => setApproveError(null)}>{approveError}</Alert>}
        {/* Toggle editor↔chat↔arquivos só no mobile (xs); no desktop os painéis ficam lado a lado.
            "Arquivos" existe só quando a spec foi aberta de um produto (?productId=…) — aqui um FAB
            fixo não serve (ficaria por baixo deste Dialog), então a árvore é um TERCEIRO painel. */}
        <Stack direction="row" spacing={1}
          sx={{ display: { xs: "flex", md: "none" }, p: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
          {showTree && (
            <Button fullWidth size="small" startIcon={<FolderOpenIcon />}
              variant={fsPane === "files" ? "contained" : "outlined"} onClick={() => setFsPane("files")}
              sx={{ minWidth: 0, px: 1 }}>Arquivos</Button>
          )}
          <Button fullWidth size="small" startIcon={<EditIcon />}
            variant={fsPane === "editor" ? "contained" : "outlined"} onClick={() => setFsPane("editor")}
            sx={{ minWidth: 0, px: 1 }}>Editor</Button>
          <Button fullWidth size="small" startIcon={<AutoFixHighIcon />}
            variant={fsPane === "chat" ? "contained" : "outlined"} onClick={() => setFsPane("chat")}
            sx={{ minWidth: 0, px: 1 }}>IA</Button>
        </Stack>
        <Box sx={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
          {/* Rail da árvore da PASTA DO PRODUTO também em tela cheia (≥md; no mobile o toggle
              editor↔chat já ocupa a tela). Traz o próprio cabeçalho "PASTA DO PRODUTO · N
              ARQUIVO(S)" e navega o editProjectId. Só quando aberto de um produto (?productId). */}
          {showTree && (
            <>
              <Box sx={{
                width: { xs: "100%", md: `${treeWidth}px` }, flexShrink: 0, minWidth: 0,
                display: { xs: fsPane === "files" ? "flex" : "none", md: "flex" },
                flexDirection: "column", borderRight: "1px solid", borderColor: "divider", overflow: "hidden",
              }}>
                {/* No mobile, escolher um arquivo troca o conteúdo do editor → volta ao painel
                    "Editor" (senão a navegação parece não ter efeito). */}
                <ProductFolderNav {...treeNavProps}
                  onOpen={(projId, specPath) => { setFsPane("editor"); handleOpenTreeFile(projId, specPath); }} height="100%" />
              </Box>
              {/* Divisória arrastável árvore↔editor (duplo-clique reseta a 240px). Invólucro FLEX
                  pelo mesmo motivo do rail normal: em `block` a barra ficava com altura zero. */}
              <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "stretch", alignSelf: "stretch" }}>
                <ResizeHandle ariaLabel="Redimensionar árvore e editor" onResize={growTree} onReset={() => setTreeWidth(240)} />
              </Box>
            </>
          )}
          {/* Editor: sempre visível no desktop; no mobile só quando o painel selecionado é 'editor'. */}
          <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", display: { xs: fsPane === "editor" ? "flex" : "none", md: "flex" } }}>
            <SpecEditor
              value={activeFile ? fileDraft : specMarkdown} onChange={handleEditorChange}
              fileExt={activeFile ? (activeFile.path.split(".").pop() || "md") : "md"}
              fullscreen={true} onToggleFullscreen={() => setEditorFullscreen(false)}
              onSave={handleSaveCurrent} approving={approving}
              saveLabel={activeFile ? "Salvar arquivo" : "Salvar rascunho"}
              onRegen={editProjectId ? undefined : () => { setEditorFullscreen(false); setSpecMarkdown(null); }}
              regenDisabled={editProjectId ? true : generating}
              projectId={editProjectId} isAdmin={authStore.isZentrizAdmin}
              validationReloadSignal={validationReloadSignal} gapCount={gapCount}
              onPromote={editProjectId ? handlePromote : undefined} promoteScope={promoteScope}
              onValidationChange={setGapCount} openGapsSignal={openGapsSignal}
              activeFilePath={activeFile?.path ?? null} onVersionRestored={handleVersionRestored}
              autonomy={autonomy} onStopAutonomy={handleStopAutonomy} openAutonomySignal={openAutonomySignal}
            />
          </Box>
          {/* Divisória arrastável editor↔chat (tela cheia). Só ≥md — no mobile os painéis alternam. */}
          <ResizeHandle ariaLabel="Redimensionar editor e chat" onResize={shrinkChat} onReset={() => setChatWidth(380)} />
          {/* Feature #63 — chat "Melhorar com IA" TAMBÉM em tela cheia: painel à direita no desktop;
              no mobile ocupa a tela quando selecionado. Antes o dialog só mostrava o editor (bug). */}
          <Box sx={{
            width: { xs: "100%", md: `${chatWidth}px` }, flexShrink: 0, minWidth: 0, overflow: "hidden",
            display: { xs: fsPane === "chat" ? "flex" : "none", md: "flex" },
          }}>
            <SpecChatPanel
              messages={chatMessages} input={chatInput} onInput={setChatInput}
              onSend={handleChatSend} sending={chatSending} error={chatError}
              activeFilePath={activeFile?.path ?? null} treeDirty={treeDirty}
              openFilePath={openFile?.path ?? null} openFileIsPrimary={openFile?.primary === true}
              historyLoading={historyLoading} historyError={historyError} onRetryHistory={retryChatHistory}
              pending={pendingApply} applying={applying} applyError={applyError} conflict={applyConflict}
              onApply={handleApplyFile} onDiscard={handleDiscardApply} onOverwrite={handleOverwriteApply}
              gapCount={gapCount} onResolveGaps={handleResolveGaps}
              fileGapCount={fileGapCount} onResolveFileGaps={handleResolveFileGaps} gapReconcile={gapReconcile}
              isEvolution={isEvolution} onEvolvePlan={handleEvolvePlan}
              recovered={recoveredSpec} onApplyRecovered={handleApplyRecovered} onDiscardRecovered={handleDiscardRecovered}
              {...autonomyPanelProps}
            />
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );

  // ── Chat de IA em tela cheia no mobile (FAB) ──────────────────────────────
  // No desktop o SpecChatPanel aparece ao lado do editor; no mobile não cabe,
  // então um FAB (só xs) abre o MESMO painel num Dialog fullScreen. Reutilizado
  // pelos dois modos (edição e criação) — só um render por vez (edição faz early return).
  const mobileChat = (
    <>
      <Fab
        color="primary" aria-label="Abrir assistente de IA"
        onClick={() => setMobileChatOpen(true)}
        sx={{ display: { xs: "flex", md: "none" }, position: "fixed", bottom: 24, right: 24, zIndex: (t) => t.zIndex.speedDial }}
      >
        <AutoFixHighIcon />
      </Fab>
      <Dialog open={mobileChatOpen} onClose={() => setMobileChatOpen(false)} fullScreen
        PaperProps={{ sx: { bgcolor: "background.default", m: 0 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between"
          sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <AutoFixHighIcon sx={{ color: "primary.main", fontSize: "1.2rem" }} />
            <Typography variant="subtitle1" fontWeight={700}>Assistente de spec (IA)</Typography>
          </Stack>
          <IconButton onClick={() => setMobileChatOpen(false)} aria-label="Fechar"><CloseIcon /></IconButton>
        </Stack>
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
          <SpecChatPanel
            messages={chatMessages} input={chatInput} onInput={setChatInput}
            onSend={handleChatSend} sending={chatSending} error={chatError}
              activeFilePath={activeFile?.path ?? null} treeDirty={treeDirty}
              openFilePath={openFile?.path ?? null} openFileIsPrimary={openFile?.primary === true}
              historyLoading={historyLoading} historyError={historyError} onRetryHistory={retryChatHistory}
              pending={pendingApply} applying={applying} applyError={applyError} conflict={applyConflict}
              onApply={handleApplyFile} onDiscard={handleDiscardApply} onOverwrite={handleOverwriteApply}
              gapCount={gapCount} onResolveGaps={handleResolveGaps}
              fileGapCount={fileGapCount} onResolveFileGaps={handleResolveFileGaps} gapReconcile={gapReconcile}
              isEvolution={isEvolution} onEvolvePlan={handleEvolvePlan}
              recovered={recoveredSpec} onApplyRecovered={handleApplyRecovered} onDiscardRecovered={handleDiscardRecovered}
              {...autonomyPanelProps}
          />
        </DialogContent>
      </Dialog>
    </>
  );

  // ── Árvore da pasta do produto em tela cheia no mobile (FAB) ───────────────
  // O rail da árvore só existe ≥lg; abaixo disso o usuário não alcançava os outros arquivos do
  // produto (era preciso voltar a /products/:id). Mesmo padrão do chat: FAB fixo + Dialog
  // fullScreen "por cima de tudo". O FAB sobe para bottom:96 no xs para não cobrir o FAB do chat
  // (entre md e lg o chat já é inline, então volta a bottom:24). Só quando há produto na URL.
  const mobileTree = showTree ? (
    <>
      <Fab
        color="default" aria-label={treeProductId ? "Abrir a pasta do produto" : "Abrir a lista de arquivos da spec"}
        onClick={() => setMobileTreeOpen(true)}
        sx={{
          display: { xs: "flex", lg: "none" }, position: "fixed",
          bottom: { xs: 96, md: 24 }, right: 24, zIndex: (t) => t.zIndex.speedDial,
        }}
      >
        <FolderOpenIcon />
      </Fab>
      <Dialog open={mobileTreeOpen} onClose={() => setMobileTreeOpen(false)} fullScreen
        PaperProps={{ sx: { bgcolor: "background.default", m: 0 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between"
          sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <FolderOpenIcon sx={{ color: "text.secondary", fontSize: "1.2rem" }} />
            <Typography variant="subtitle1" fontWeight={700}>{treeProductId ? "Pasta do produto" : "Arquivos da spec"}</Typography>
          </Stack>
          <IconButton onClick={() => setMobileTreeOpen(false)} aria-label="Fechar"><CloseIcon /></IconButton>
        </Stack>
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
          {/* Abrir um arquivo troca o conteúdo do editor → fecha o overlay, senão o usuário ficaria
              olhando a árvore sem ver que o editor trocou de arquivo. */}
          <ProductFolderNav {...treeNavProps}
            onOpen={(projId, specPath) => { setMobileTreeOpen(false); handleOpenTreeFile(projId, specPath); }}
            height="100%"
          />
        </DialogContent>
      </Dialog>
    </>
  ) : null;

  // ── Onda 3 (b) + B1/B2/B8: confirmação N2 (digitada) para promover COM GAPs em aberto ──────
  // Promover com GAPs vai para a fábrica mesmo assim (decisão do usuário — qualquer papel pode),
  // mas exige digitar a palavra. B1: o texto declara o ESCOPO REAL (spec vs. produto inteiro) em vez
  // de dizer "se esta spec pertence a um produto…" e deixar o usuário adivinhar. Componente padrão
  // (`ConfirmActionDialog`) para que as três telas confirmem do mesmo jeito.
  const promoteDialog = (
    <ConfirmActionDialog
      open={promoteOpen}
      title={promoteNeedsWord ? "Promover com GAPs em aberto?" : promoteButtonLabel(promoteScope) + "?"}
      message={
        (promoteNeedsWord
          ? `A validação aponta ${gapCount} GAP(s) nesta spec. A fábrica trabalhará com lacunas ` +
            "conhecidas e o resultado pode exigir retrabalho — resolver na aba GAPs é o caminho normal.\n\n"
          : "") +
        promoteConfirmBody(promoteScope, { productName: ownerProduct?.name, siblings: promoteSiblings })
      }
      severity={promoteNeedsWord ? "warning" : "info"}
      confirmLabel={promoteButtonLabel(promoteScope)}
      confirmWord={promoteNeedsWord ? PROMOTE_CONFIRM_WORD : undefined}
      busy={approving === "start"}
      typed={promoteConfirmText}
      onTypedChange={setPromoteConfirmText}
      onConfirm={confirmPromote}
      onClose={() => setPromoteOpen(false)}
    />
  );

  // ── H2 (adversarial Onda 2): conflito no "Salvar rascunho" da spec inteira ─────────────────────
  // Renderizado UMA vez: serve o editor normal, o fullscreen e o mobile (um Alert por tela não
  // apareceria no fullscreen, que é onde a Bancada é de fato usada). Nada foi gravado quando ele
  // abre — as duas saídas são explícitas e nenhuma delas perde trabalho em silêncio.
  const specConflictDialog = (
    <Dialog open={specSaveConflict} onClose={() => setSpecSaveConflict(false)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: "1rem" }}>A spec mudou desde a sua leitura</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ whiteSpace: "pre-line" }}>
          {"O arquivo no servidor não é mais o que você abriu — outra aba, o chat da Bancada ou o modo " +
           "autônomo gravaram antes de você. Nada foi salvo.\n\n" +
           "• Recarregar: fica com a versão do servidor e descarta o texto que está no editor.\n" +
           "• Sobrescrever: grava o seu texto por cima; a versão do servidor não se perde — ela vai " +
           "para o histórico em \"Versões\"."}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setSpecSaveConflict(false)} disabled={specConflictBusy}>Cancelar</Button>
        <Button onClick={() => void handleSpecConflictReload()} disabled={specConflictBusy}>
          Recarregar do servidor
        </Button>
        <Button color="warning" variant="contained" disabled={specConflictBusy}
          onClick={() => void handleSpecConflictOverwrite()}>
          Sobrescrever
        </Button>
      </DialogActions>
    </Dialog>
  );

  // ── Modo edição: renderiza editor diretamente sem tabs ────────────────────
  if (editProjectId) {
    return (
      <Box>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
          <EditIcon sx={{ color: "warning.main" }} />
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h5" fontWeight={700}>Editar Spec</Typography>
            <Typography variant="body2" color="text.secondary">
              {treeProductId
                ? "Edite a spec do produto — escolha o arquivo na lista da pasta, à esquerda."
                : "Edite a spec antes de iniciar o pipeline — os arquivos ficam na lista à esquerda."}
            </Typography>
          </Box>
          <Button size="small" color="inherit" onClick={() => router.push(`/projects/${editProjectId}`)}>
            ← Voltar ao projeto
          </Button>
        </Stack>

        {editLoadError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setEditLoadError(null)}>{editLoadError}</Alert>
        )}

        {/* Migração 089 — todo o corpo de edição (e com ele o painel de chat) é gated em
            `specMarkdown !== null`. Se o carregamento da spec falhou, o estado do job ficaria
            INVISÍVEL e o usuário concluiria que a revisão sumiu — exatamente a percepção que esta
            frente existe para eliminar. Este aviso vive FORA do gate. */}
        {editProjectId && specMarkdown === null && !editLoading && (chatSending || recoveredSpec) && (
          <Alert severity="info" sx={{ mb: 2 }} aria-live="polite"
            action={recoveredSpec
              ? <Button size="small" color="inherit" onClick={handleApplyRecovered}>Recuperar no editor</Button>
              : undefined}>
            {chatSending
              ? "Há uma revisão do CTO em andamento no servidor para este projeto — ela não será perdida, mesmo que você feche esta tela."
              : "Uma revisão do CTO concluída aguarda você neste projeto."}
          </Alert>
        )}

        {/* Pivô Bancada (Opção 1): quando aberto de um produto (?productId=…), a árvore da
            PASTA DO PRODUTO fica num rail ESTÁVEL à esquerda de TODO o corpo de edição —
            fora do gate de carregamento — para não desmontar/re-buscar (nem piscar) a cada
            troca de projeto pela navegação. Só ≥lg (no md a árvore roubaria largura do editor;
            no mobile o editor ocupa a tela). Reusa a árvore da aba "Código" da fábrica. */}
        <Box sx={{ display: "flex", gap: 0, alignItems: { xs: "flex-start", lg: "stretch" }, height: { lg: "calc(100vh - 168px)" }, minHeight: { lg: 560 } }}>
          {showTree && (
            <>
              <Box sx={{ width: `${treeWidth}px`, flexShrink: 0, display: { xs: "none", lg: "flex" }, flexDirection: "column", border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
                <ProductFolderNav {...treeNavProps} height="100%" />
              </Box>
              {/* Divisória arrastável árvore↔editor (só ≥lg; duplo-clique reseta a 240px).
                  ⚠️ O invólucro é FLEX com `alignItems: stretch`: a barra recebe altura do pai (ela
                  se estica por `alignSelf`). Com o invólucro em `display: block` a barra nascia com
                  ALTURA ZERO — existia no DOM, invisível e impossível de arrastar (era o que o Jean
                  via: nenhuma divisória entre "Pasta do produto · N arquivo(s)" e a área das abas). */}
              <Box sx={{ display: { xs: "none", lg: "flex" }, alignItems: "stretch", alignSelf: "stretch" }}>
                <ResizeHandle ariaLabel="Redimensionar árvore e editor" onResize={growTree} onReset={() => setTreeWidth(240)} />
              </Box>
            </>
          )}
          <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, pl: showTree ? { lg: 1.5 } : 0 }}>
        {editLoading && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 6, justifyContent: "center" }}>
            <CircularProgress size={24} />
            <Typography variant="body2" color="text.secondary">Carregando spec…</Typography>
          </Box>
        )}

        {/* RFC-0004 Onda 4: árvore multi-arquivo (só no modo edição; a árvore só quando a spec
            tem 2+ arquivos — D8). Onda 3 (a): a validação/GAPs NÃO fica mais aqui — virou a aba
            "GAPs" dentro do editor. Aqui sobra só o aviso de validação obsoleta + a árvore. */}
        {!editLoading && specMarkdown !== null && editProjectId && (
          <Box sx={{ mb: 2, "&:empty": { display: "none", mb: 0 } }}>
            {/* Migração 090 — o laço autônomo escreve na MESMA spec. Avisar é mais honesto que
                travar o editor: a guarda do servidor não sobrescreve edição humana, mas encerra o
                laço ("stalled") quando ela aparece no meio da rodada. */}
            {/* UI/UX 2026-09-06 — uma LINHA, com "ver detalhes" levando à aba "Autonomia" do editor.
                O relatório por rodada (que enchia a tela, sobretudo no mobile) mora lá agora. O texto
                sai de `autonomyHeadline`: dizia "rodada 12/5" em runs por arquivo, porque nesse modo
                `round` conta ARQUIVOS e quem respeita `maxRounds` é `passes`. */}
            {autonomy?.run?.active && (
              <Alert severity="info" sx={{ mb: 1 }} aria-live="polite"
                action={<Button size="small" color="inherit" onClick={handleShowAutonomy}>Ver detalhes</Button>}>
                <strong>{autonomyHeadline(autonomy.run)}</strong>
                {" "}— o CTO está resolvendo os GAPs, salvando e revalidando a spec no servidor.
                Evite editar ou salvar a spec agora: uma edição manual no meio da rodada interrompe o
                laço (o servidor não sobrescreve o seu texto).
              </Alert>
            )}
            {/* Uma proposta de divisão pronta não pode ficar escondida atrás de um diálogo fechado. */}
            {splitState?.awaitingDecision && (
              <Alert severity="warning" sx={{ mb: 1 }}
                action={<Button size="small" color="inherit" onClick={() => setSplitOpen(true)}>Ver proposta</Button>}>
                Os agentes propuseram dividir esta spec em arquivos — aguardando a sua decisão.
              </Alert>
            )}
            {staleValidation && (
              <Alert severity="warning" sx={{ mb: 1 }} onClose={() => setStaleValidation(false)}>
                O conteúdo da spec mudou (revisão da IA aplicada ou versão restaurada). A validação anterior pode estar desatualizada — revalide na aba GAPs antes de promover à fábrica.
              </Alert>
            )}
            {/* Item 2 — checklist Connect-ready (determinístico, do spec-tree): o que a spec já tem e o
                que falta para chegar à fábrica no padrão Genesis › Connect › Auto Care. */}
            <ConnectReadyChecklist projectId={editProjectId} reloadSignal={treeReloadSignal} isEvolution={isEvolution} />
            {/* UI/UX 2026-09-06 — aqui viviam DOIS blocos que saíram do corpo da página:
                • `SpecTreePanel` ("Árvore da especificação"), a segunda lista de arquivos → agora é
                  a lista única (`ProductFolderNav`), no rail/painel "Arquivos"/diálogo do mobile;
                • os cards de "Dividir a spec em arquivos" → viraram um ícone na lista, que abre
                  `splitDialog`. Ambos ocupavam o corpo permanentemente sem serem o foco da tela. */}
          </Box>
        )}

        {!editLoading && specMarkdown !== null && (
          <Card sx={{ flexGrow: { lg: 1 }, minHeight: { lg: 0 }, display: "flex", flexDirection: "column" }}>
            <CardContent sx={{ p: 0, "&:last-child": { pb: 0 }, flexGrow: { lg: 1 }, minHeight: { lg: 0 }, display: "flex", flexDirection: "column" }}>
              {approveError && <Alert severity="error" sx={{ m: 2 }} onClose={() => setApproveError(null)}>{approveError}</Alert>}
              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ px: 2, py: 1.5, rowGap: 1, borderBottom: "1px solid", borderColor: "divider" }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexGrow: 1, minWidth: 0 }}>
                  <CheckCircleIcon sx={{ color: "warning.main", fontSize: "1.1rem", flexShrink: 0 }} />
                  <TextField
                    size="small" variant="standard" value={projectTitle}
                    onChange={(e) => setProjectTitle(e.target.value)}
                    placeholder="Título do projeto"
                    InputProps={{ disableUnderline: false, sx: { fontWeight: 600, fontSize: "0.95rem" } }}
                    sx={{ minWidth: { xs: 140, sm: 260 }, flexGrow: { xs: 1, sm: 0 } }}
                  />
                </Stack>
                <Stack direction="row" spacing={1}>
                  {/* Relatórios de rastreabilidade do PRODUTO dono desta spec. Só aparece quando a
                      spec pertence a um produto de verdade (não ao inbox de rascunhos). */}
                  <TraceabilityReportsButton productId={ownerProduct?.id ?? null} productName={ownerProduct?.name ?? null} />
                  <Button size="small" color="inherit" onClick={() => router.push(`/projects/${editProjectId}`)}>
                    Descartar
                  </Button>
                  {/* UI/UX 2026-09-06 — o editor principal edita a spec inteira OU o arquivo
                      escolhido na lista; o botão salva o que está aberto (PUT com If-Match no caso
                      do arquivo, para não sobrescrever revisão da IA/laço autônomo). */}
                  <Button size="small" variant="outlined" disabled={!!approving}
                    startIcon={approving === "save" ? <CircularProgress size={14} color="inherit" /> : undefined}
                    onClick={handleSaveCurrent}>
                    {approving === "save" ? "Salvando…" : activeFile ? "Salvar arquivo" : "Salvar rascunho"}
                  </Button>
                  {/* Onda 3 (b): "Salvar e Iniciar" → promoção. A spec só é admitida na fábrica por
                      aqui; com GAPs em aberto exige confirmação por digitação. B1: o rótulo diz o
                      escopo real (produto inteiro vs. só esta spec) — fonte única em factoryActions. */}
                  <Tooltip title={promoteScope === "spec" ? FACTORY_TOOLTIP.promoteSpec : FACTORY_TOOLTIP.promoteProduct}>
                    <Button size="small" variant="contained" color="success" disabled={!!approving}
                      startIcon={approving === "start" ? <CircularProgress size={14} color="inherit" /> : <RocketLaunchIcon />}
                      onClick={handlePromote}>
                      {approving === "start" ? FACTORY_LABEL.promoting : promoteButtonLabel(promoteScope)}
                    </Button>
                  </Tooltip>
                </Stack>
              </Stack>
              {/* Altura preenche a viewport (plataforma profissional): em ≥lg o corpo cresce
                  (flexGrow) até o fundo do container de altura fixa — topos/fundos alinhados com o
                  rail da árvore por construção. Abaixo de lg cai no calc/altura fixa. */}
              <Box sx={{ flexGrow: { lg: 1 }, minHeight: { lg: 0 }, height: { xs: 520, md: "calc(100vh - 240px)", lg: "auto" }, overflow: "hidden", display: "flex" }}>
                <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
                  <SpecEditor
                    value={activeFile ? fileDraft : specMarkdown} onChange={handleEditorChange}
                    fileExt={activeFile ? (activeFile.path.split(".").pop() || "md") : "md"}
                    fullscreen={false} onToggleFullscreen={() => setEditorFullscreen(true)}
                    onSave={handleSaveCurrent} approving={approving}
                    saveLabel={activeFile ? "Salvar arquivo" : "Salvar rascunho"}
                    onRegen={undefined}
                    regenDisabled={true}
                    projectId={editProjectId} isAdmin={authStore.isZentrizAdmin}
                    validationReloadSignal={validationReloadSignal} gapCount={gapCount}
                    onValidationChange={setGapCount} openGapsSignal={openGapsSignal}
              activeFilePath={activeFile?.path ?? null} onVersionRestored={handleVersionRestored}
              autonomy={autonomy} onStopAutonomy={handleStopAutonomy} openAutonomySignal={openAutonomySignal}
                  />
                </Box>
                {/* Divisória arrastável editor↔chat (duplo-clique reseta a 380px). */}
                <ResizeHandle ariaLabel="Redimensionar editor e chat" onResize={shrinkChat} onReset={() => setChatWidth(380)} />
                {/* Feature #63 — painel de chat à direita do editor/preview (oculto no mobile: editor ocupa a tela; usar tela cheia p/ chat) */}
                <Box sx={{ width: { xs: 300, md: `${chatWidth}px` }, flexShrink: 0, display: { xs: "none", md: "block" } }}>
                  <SpecChatPanel
                    messages={chatMessages} input={chatInput} onInput={setChatInput}
                    onSend={handleChatSend} sending={chatSending} error={chatError}
              activeFilePath={activeFile?.path ?? null} treeDirty={treeDirty}
              openFilePath={openFile?.path ?? null} openFileIsPrimary={openFile?.primary === true}
              historyLoading={historyLoading} historyError={historyError} onRetryHistory={retryChatHistory}
              pending={pendingApply} applying={applying} applyError={applyError} conflict={applyConflict}
              onApply={handleApplyFile} onDiscard={handleDiscardApply} onOverwrite={handleOverwriteApply}
              gapCount={gapCount} onResolveGaps={handleResolveGaps}
              fileGapCount={fileGapCount} onResolveFileGaps={handleResolveFileGaps} gapReconcile={gapReconcile}
              isEvolution={isEvolution} onEvolvePlan={handleEvolvePlan}
              recovered={recoveredSpec} onApplyRecovered={handleApplyRecovered} onDiscardRecovered={handleDiscardRecovered}
              {...autonomyPanelProps}
                  />
                </Box>
              </Box>
            </CardContent>
          </Card>
        )}
          </Box>
        </Box>

        {editorDialog}
        {promoteDialog}
        {specConflictDialog}
        {/* Migração 097 — ordem de entrada na fábrica do produto promovido. `onStart` só existe
            porque o produto foi admitido AQUI: iniciar é decisão explícita do humano. */}
        <PromotionPlanDialog
          open={planOpen}
          onClose={() => { setPlanOpen(false); setPlanError(null); setStartedNotice(null); }}
          productName={planProduct?.name ?? null}
          meta={planMeta}
          items={planItems}
          onStart={planProduct ? () => { void startPromotedProduct(); } : undefined}
          starting={planStarting}
          startError={planError}
          startedNotice={startedNotice}
          startedSeverity={startedSeverity}
        />
        {/* Divisão da spec: diálogo (não card no corpo) aberto pelo ícone da lista de arquivos.
            Fica fora do gate de `specMarkdown` de propósito — a proposta vive no servidor. */}
        {splitDialog}
        {specMarkdown !== null && !editLoading && mobileChat}
        {/* Árvore da pasta do produto: acessível no mobile/tablet mesmo com a spec ainda
            carregando (é navegação, não depende do conteúdo do editor). */}
        {!editorFullscreen && mobileTree}
      </Box>
    );
  }

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
          variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
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
                    <ProjectTypeSelect value={projectType} onChange={setProjectType} />
                    <DeliverySection visible={!!projectType} isBackend={isBackendType} mode={deliveryMode} onMode={setDeliveryMode}
                      advancedOpen={advancedOpen} onAdvancedOpen={setAdvancedOpen}
                      dbMode={dbMode} onDbMode={setDbMode}
                      runtimeTarget={runtimeTarget} onRuntimeTarget={setRuntimeTarget}
                      domainMode={domainMode} onDomainMode={setDomainMode}
                      projectType={projectType}
                      cloudConnections={cloudConnections} cloudConnId={cloudConnId} onCloudConn={setCloudConnId}
                      deployFormat={deployFormat} onDeployFormat={setDeployFormat}
                      deployTtlDays={deployTtlDays} onDeployTtlDays={setDeployTtlDays}
                      uiuxConnections={uiuxConnections} uiuxConnId={uiuxConnId} onUiuxConn={setUiuxConnId}
                      uiuxSelectedProvider={uiuxSelectedProvider}
                      uiuxProjects={uiuxProjects} uiuxProjectIds={uiuxProjectIds} onUiuxProjectIds={setUiuxProjectIds}
                      uiuxLoadingProjects={uiuxLoadingProjects} uiuxProjectsError={uiuxProjectsError}
                      onUiuxAddFigma={addFigmaFile} onUiuxRemoveFigma={removeFigmaFile} />
                    <ProductLinkSection
                      products={products} productId={productId} onProductId={setProductId}
                      onProductsReload={() => { void reloadProducts(); }}
                      allProjects={allProjects} linkProjectId={linkProjectId} onLinkProjectId={setLinkProjectId}
                      linkRelation={linkRelation} onLinkRelation={setLinkRelation}
                    />
                    <TextField
                      fullWidth multiline rows={8} required
                      label="Descreva o produto que você quer construir"
                      value={freeText} onChange={(e) => setFreeText(e.target.value)}
                      error={freeText.trim().length > 0 && freeText.trim().length < MIN_FREE_TEXT_CHARS}
                      helperText={`${freeText.trim().length}/${MIN_FREE_TEXT_CHARS} caracteres mínimos — descreva o produto (o que faz, para quem, requisitos).`}
                      placeholder={"Exemplo:\n\nQuero um sistema de agendamento para barbearia. Precisa ter:\n- Cadastro de barbeiros e clientes\n- Agendamento online pelo cliente\n- Notificações por WhatsApp\n- Painel admin para os barbeiros\n- Relatório de atendimentos\n\nTecnologia: Node.js, MySQL, sem frontend por enquanto."}
                      sx={{ mb: 2, "& textarea": { fontFamily: "Inter, sans-serif", fontSize: "0.85rem", lineHeight: 1.7 } }}
                    />
                    {genError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setGenError(null)}>{genError}</Alert>}

                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Button
                        variant="contained" size="large"
                        startIcon={generating ? <CircularProgress size={18} color="inherit" /> : <AutoFixHighIcon />}
                        disabled={generating || freeText.trim().length < MIN_FREE_TEXT_CHARS}
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
                    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap sx={{ mb: 1.5, rowGap: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ rowGap: 0.5 }}>
                        <CheckCircleIcon sx={{ color: "success.main", fontSize: "1.1rem" }} />
                        <Typography variant="subtitle2" fontWeight={600}>Spec gerada pelo CTO</Typography>
                        <Chip label="Revise e edite antes de aprovar" size="small" color="warning" sx={{ fontSize: "0.65rem" }} />
                      </Stack>
                      <Button size="small" startIcon={<AutoFixHighIcon />} onClick={() => setSpecMarkdown(null)}>
                        Recomeçar
                      </Button>
                    </Stack>

                    {approveError && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setApproveError(null)}>{approveError}</Alert>}

                    {/* Editor inline + chat de edição (Feature #63) */}
                    <Box sx={{ height: { xs: 520, sm: 600 }, border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden", display: "flex" }}>
                      <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
                        <SpecEditor
                          value={specMarkdown} onChange={setSpecMarkdown}
                          fullscreen={false} onToggleFullscreen={() => setEditorFullscreen(true)}
                          onSave={() => { void handleSaveSpec(); }} approving={approving}
                          onRegen={() => setSpecMarkdown(null)}
                          regenDisabled={generating}
                        />
                      </Box>
                      <Box sx={{ width: { xs: 280, md: 360 }, flexShrink: 0, borderLeft: "1px solid", borderColor: "divider", display: { xs: "none", md: "block" } }}>
                        <SpecChatPanel
                          messages={chatMessages} input={chatInput} onInput={setChatInput}
                          onSend={handleChatSend} sending={chatSending} error={chatError}
              activeFilePath={activeFile?.path ?? null} treeDirty={treeDirty}
              openFilePath={openFile?.path ?? null} openFileIsPrimary={openFile?.primary === true}
              historyLoading={historyLoading} historyError={historyError} onRetryHistory={retryChatHistory}
              pending={pendingApply} applying={applying} applyError={applyError} conflict={applyConflict}
              onApply={handleApplyFile} onDiscard={handleDiscardApply} onOverwrite={handleOverwriteApply}
              gapCount={gapCount} onResolveGaps={handleResolveGaps}
              fileGapCount={fileGapCount} onResolveFileGaps={handleResolveFileGaps} gapReconcile={gapReconcile}
              isEvolution={isEvolution} onEvolvePlan={handleEvolvePlan}
              recovered={recoveredSpec} onApplyRecovered={handleApplyRecovered} onDiscardRecovered={handleDiscardRecovered}
              {...autonomyPanelProps}
                        />
                      </Box>
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
                  <ProjectTypeSelect value={projectType} onChange={setProjectType} />
                  <DeliverySection visible={!!projectType} isBackend={isBackendType} mode={deliveryMode} onMode={setDeliveryMode}
                    advancedOpen={advancedOpen} onAdvancedOpen={setAdvancedOpen}
                    dbMode={dbMode} onDbMode={setDbMode}
                    runtimeTarget={runtimeTarget} onRuntimeTarget={setRuntimeTarget}
                    domainMode={domainMode} onDomainMode={setDomainMode}
                    projectType={projectType}
                    cloudConnections={cloudConnections} cloudConnId={cloudConnId} onCloudConn={setCloudConnId}
                    deployFormat={deployFormat} onDeployFormat={setDeployFormat}
                    deployTtlDays={deployTtlDays} onDeployTtlDays={setDeployTtlDays}
                    uiuxConnections={uiuxConnections} uiuxConnId={uiuxConnId} onUiuxConn={setUiuxConnId}
                    uiuxSelectedProvider={uiuxSelectedProvider}
                    uiuxProjects={uiuxProjects} uiuxProjectIds={uiuxProjectIds} onUiuxProjectIds={setUiuxProjectIds}
                    uiuxLoadingProjects={uiuxLoadingProjects} uiuxProjectsError={uiuxProjectsError}
                    onUiuxAddFigma={addFigmaFile} onUiuxRemoveFigma={removeFigmaFile} />
                  <ProductLinkSection
                    products={products} productId={productId} onProductId={setProductId}
                    onProductsReload={() => { void reloadProducts(); }}
                    allProjects={allProjects} linkProjectId={linkProjectId} onLinkProjectId={setLinkProjectId}
                    linkRelation={linkRelation} onLinkRelation={setLinkRelation}
                  />

                  {/* SPEC-APPROVED: quando o arquivo enviado já é uma spec completa validada por humano,
                      o CTO deve VALIDAR (Sub-modo C) em vez de regenerá-la. */}
                  <Box sx={{ mb: 2, p: 1.5, border: "1px solid", borderColor: specApproved ? "success.main" : "divider", borderRadius: 1, bgcolor: specApproved ? "success.main" + "08" : "transparent", transition: "all .15s" }}>
                    <FormControlLabel
                      control={<Checkbox checked={specApproved} onChange={(e) => setSpecApproved(e.target.checked)} size="small" color="success" />}
                      label={
                        <Box>
                          <Typography variant="body2" fontWeight={600}>✅ Especificações aprovadas por humanos</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.5 }}>
                            A spec já foi revisada e está completa. O CTO irá <strong>validar</strong> a estrutura (não regenerar),
                            preservando suas decisões. Engineer, Charter e PM seguem normalmente.
                          </Typography>
                        </Box>
                      }
                      sx={{ alignItems: "flex-start", m: 0 }}
                    />
                  </Box>

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
                    <Typography variant="caption" color="text.secondary">.md .txt .doc .docx .pdf .zip — máx 10MB · ZIP com múltiplos arquivos é descompactado automaticamente</Typography>
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

                  {/* Onda 4 — "Decompor em produto após salvar": só com a flag da API ligada e
                      para contas de autoria. A spec fica salva como rascunho e o Product Architect
                      propõe N specs para revisão (nada é executado). */}
                  {canDecomposeOnUpload && (
                    <Box sx={{ mb: 2, p: 1.5, border: "1px solid", borderColor: decomposeOnUpload ? "secondary.main" : "divider", borderRadius: 1,
                      bgcolor: decomposeOnUpload ? "secondary.main" + "0D" : "transparent", transition: "all .15s" }}>
                      <FormControlLabel
                        control={<Switch checked={decomposeOnUpload} onChange={(e) => toggleDecomposeOnUpload(e.target.checked)} size="small" color="secondary"
                          inputProps={{ "aria-label": "Decompor em produto após salvar" }} />}
                        label={
                          <Box>
                            <Stack direction="row" spacing={0.75} alignItems="center">
                              <CallSplitIcon sx={{ fontSize: "1rem", color: "secondary.main" }} />
                              <Typography variant="body2" fontWeight={600}>Decompor em produto após salvar</Typography>
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.5 }}>
                              A spec fica salva como <strong>rascunho</strong>; o Product Architect propõe a divisão em
                              vários projetos (specs) para a sua revisão — nada é executado.
                            </Typography>
                            {decomposeOnUpload && uploadEstimate && (
                              <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "text.secondary" }}>
                                Prévia: <strong>{describeEstimate(uploadEstimate)}</strong> no modelo padrão — estimativa local (±30 %),
                                calculada pelo tamanho dos anexos; o custo real aparece ao fim.
                              </Typography>
                            )}
                          </Box>
                        }
                        sx={{ alignItems: "flex-start", m: 0, gap: 0.5 }}
                      />
                    </Box>
                  )}

                  {uploadError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setUploadError(null)}>{uploadError}</Alert>}

                  <Divider sx={{ my: 2 }} />
                  {/* Onda 3 (b): o upload APENAS salva a spec como rascunho. A ida à fábrica passou a
                      ser exclusiva do botão de promoção na edição da spec — não há mais
                      "Salvar e iniciar pipeline" aqui. */}
                  <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Tooltip title={canDecomposeOnUpload && decomposeOnUpload
                      ? "Salva a spec como rascunho e abre a proposta de decomposição em produto para revisão"
                      : "Guardar a spec como rascunho — promova à fábrica na edição quando estiver pronta"}>
                      <span>
                        <Button type="submit" variant="contained" size="large"
                          color={canDecomposeOnUpload && decomposeOnUpload ? "secondary" : "primary"}
                          startIcon={submitting ? <CircularProgress size={18} color="inherit" />
                            : canDecomposeOnUpload && decomposeOnUpload ? <CallSplitIcon /> : <span style={{ fontSize: "1rem" }}>💾</span>}
                          disabled={submitting || !files.length}
                          onClick={(e) => { e.preventDefault(); handleUploadSubmit(e as unknown as React.FormEvent); }}>
                          {submitting ? "Salvando…" : canDecomposeOnUpload && decomposeOnUpload ? "Salvar e decompor" : "Salvar rascunho"}
                        </Button>
                      </span>
                    </Tooltip>
                  </Stack>
                </form>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {editorDialog}
      {tab === 0 && specMarkdown !== null && mobileChat}

      {/* Onda 4 — decomposição da spec recém-enviada (aba Upload, switch ligado). Fechar sem
          salvar → cockpit da spec (segue rascunho no INBOX; "Decompor" da Bancada cobre a
          retomada). Salvar → pasta do produto criado. */}
      <DecomposeDialog
        open={!!decomposeTarget}
        spec={decomposeTarget}
        source="upload"
        onClose={() => {
          // O diálogo chama onSaved() e DEPOIS onClose(): se já navegamos ao produto, não
          // sobrescrever com o cockpit da spec (ref evita a corrida entre os dois pushes).
          const id = decomposeTarget?.id;
          setDecomposeTarget(null);
          if (decomposeSavedRef.current) { decomposeSavedRef.current = false; return; }
          if (id) router.push(`/projects/${id}`);
        }}
        onSaved={({ productId }) => {
          const id = decomposeTarget?.id;
          decomposeSavedRef.current = true;
          projectsStore.loadProjects();
          router.push(productId ? `/products/${productId}` : id ? `/projects/${id}` : "/specs");
        }}
      />
    </Box>
  );
}
