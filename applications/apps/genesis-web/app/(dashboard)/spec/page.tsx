"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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
import DialogContent from "@mui/material/DialogContent";
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
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import PreviewIcon from "@mui/icons-material/Preview";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SendIcon from "@mui/icons-material/Send";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { motion, AnimatePresence } from "framer-motion";
import { apiGet, apiPatch, apiPost, apiPostMultipart } from "@/lib/api";
import { projectsStore } from "@/stores/projectsStore";
import { authStore } from "@/stores/authStore";

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
        <TextField {...params} label="Tipo do projeto (opcional)"
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
  // Item 3: Ferramentas UI/UX — conta conectada + projetos escolhidos da conta.
  uiuxConnections: Array<{ id: string; provider: string; label: string | null }>;
  uiuxConnId: string; onUiuxConn: (v: string) => void;
  uiuxSelectedProvider: string;
  uiuxProjects: Array<{ id: string; name: string }>;
  uiuxProjectIds: string[]; onUiuxProjectIds: (v: string[]) => void;
  uiuxLoadingProjects: boolean;
  uiuxProjectsError: string | null;
}
function DeliverySection(p: DeliverySectionProps) {
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
            <FormControl size="small" fullWidth sx={{ mb: 1 }}
              disabled={p.uiuxLoadingProjects || p.uiuxProjects.length === 0}>
              <InputLabel>Projetos da conta</InputLabel>
              <Select multiple value={p.uiuxProjectIds} label="Projetos da conta"
                onChange={(e) => p.onUiuxProjectIds(
                  typeof e.target.value === "string" ? e.target.value.split(",") : (e.target.value as string[]),
                )}
                renderValue={(sel) => {
                  const ids = sel as string[];
                  const names = ids.map((id) => p.uiuxProjects.find((x) => x.id === id)?.name ?? id);
                  return names.join(", ");
                }}>
                {p.uiuxProjects.map((proj) => (
                  <MenuItem key={proj.id} value={proj.id}>{proj.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {p.uiuxConnId && p.uiuxSelectedProvider === "figma" && p.uiuxLoadingProjects && (
            <Typography sx={{ fontSize: "0.72rem", color: "#8B949E", mb: 1 }}>Carregando projetos…</Typography>
          )}
          {p.uiuxConnId && p.uiuxSelectedProvider === "figma" && p.uiuxProjectsError && (
            <Typography sx={{ fontSize: "0.72rem", color: "#F85149", mb: 1 }}>{p.uiuxProjectsError}</Typography>
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
  products: { id: string; name: string }[];
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
            <MenuItem value=""><em>Nenhum / Projeto standalone</em></MenuItem>
            {products.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
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
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5, fontSize: "0.68rem", lineHeight: 1.5 }}>
        Um produto agrupa projetos relacionados (backend + frontend + mobile do mesmo sistema).
      </Typography>

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
type ChatMessage = { role: "user" | "assistant"; content: string };
type SpecChatJobResponse = { jobId: string; status: "pending" | "running" | "done" | "error"; specMarkdown?: string; reply?: string; error?: string; elapsed?: number };

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
  onRegen?: () => void;
  regenDisabled: boolean;
}) {
  const [editorTab, setEditorTab] = useState<"edit" | "preview" | "split">("split");

  const toolbar = (
    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap
      sx={{ px: 1.5, py: 0.75, rowGap: 0.75, borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper", flexShrink: 0 }}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
        <Tabs value={editorTab} onChange={(_e, v) => setEditorTab(v as typeof editorTab)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ minHeight: 32 }}>
          <Tab value="edit"    icon={<EditIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Editar"    sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="split"   icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Lado a lado" sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
          <Tab value="preview" icon={<PreviewIcon sx={{ fontSize: "0.85rem" }} />} iconPosition="start" label="Preview"  sx={{ minHeight: 32, py: 0.5, fontSize: "0.78rem", textTransform: "none" }} />
        </Tabs>
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

  // Highlighted editor: transparent textarea over syntax-highlighted pre
  const editorArea = (h: string) => (
    <Box sx={{ position: "relative", height: h, overflow: "hidden", display: "flex", bgcolor: "#0D0F14" }}>
      {/* Line numbers */}
      <Box
        component="pre"
        sx={{
          flexShrink: 0, userSelect: "none", textAlign: "right",
          px: 1.5, py: 2, m: 0,
          color: "#484F58", fontSize: "0.73rem", fontFamily: "'JetBrains Mono','Fira Code',monospace",
          lineHeight: 1.7, borderRight: "1px solid #21262D", bgcolor: "#0D1117",
          overflow: "hidden", pointerEvents: "none",
          whiteSpace: "pre",
        }}
      >
        {value.split("\n").map((_, i) => i + 1).join("\n")}
      </Box>
      {/* Transparent textarea for input */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          position: "absolute", left: 44, top: 0,
          width: "calc(100% - 44px)", height: "100%",
          resize: "none", border: "none", outline: "none",
          background: "transparent",
          color: "#E6EDF3",
          fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
          fontSize: "0.75rem", lineHeight: 1.7,
          padding: "16px 16px 16px 12px",
          boxSizing: "border-box",
          overflowY: "auto",
          caretColor: "#6366F1",
          tabSize: 2,
          zIndex: 2,
        }}
      />
    </Box>
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

// ── Chat de edição de spec (Feature #63) ──────────────────────────────────────
// Painel lateral onde o usuário conversa com a IA para refinar a spec. A cada turno,
// a IA devolve a spec revisada (aplicada no editor/preview) + uma resposta curta.
function SpecChatPanel({
  messages, input, onInput, onSend, sending, error,
}: {
  messages: ChatMessage[];
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", bgcolor: "background.paper" }}>
      <Stack direction="row" spacing={1} alignItems="center"
        sx={{ px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
        <AutoFixHighIcon sx={{ fontSize: "1rem", color: PRIMARY }} />
        <Typography variant="subtitle2" fontWeight={600} sx={{ fontSize: "0.8rem" }}>Melhorar com IA</Typography>
      </Stack>

      <Box ref={scrollRef} sx={{ flexGrow: 1, overflowY: "auto", p: 1.5 }}>
        {messages.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.6 }}>
            Peça ajustes em linguagem natural — ex.: &quot;adicione autenticação por Google&quot;,
            &quot;detalhe melhor o modelo de dados&quot;, &quot;remova o módulo de relatórios&quot;.
            A spec é revisada no preview a cada resposta.
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
            <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 0.5, py: 0.5 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">CTO revisando a spec…</Typography>
            </Stack>
          )}
        </Stack>
      </Box>

      {error && <Alert severity="error" sx={{ mx: 1, mb: 1, fontSize: "0.72rem" }}>{error}</Alert>}

      <Box sx={{ p: 1, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}>
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

  // Item 3: Ferramentas UI/UX — conta conectada + projetos escolhidos da conta.
  // uiuxConnId "" = nenhuma; ao escolher uma conta, buscamos os projetos dela sob demanda.
  const [uiuxConnId, setUiuxConnId] = useState<string>("");
  const [uiuxConnections, setUiuxConnections] = useState<Array<{ id: string; provider: string; label: string | null }>>([]);
  const [uiuxProjects, setUiuxProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [uiuxProjectIds, setUiuxProjectIds] = useState<string[]>([]);
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
  // Ao trocar de conta, zera a seleção de projetos e (se for Figma) busca os projetos dela.
  // Canva: extração ainda indisponível (requer app OAuth) → não buscamos projetos.
  useEffect(() => {
    setUiuxProjectIds([]);
    setUiuxProjects([]);
    setUiuxProjectsError(null);
    if (!uiuxConnId || uiuxSelectedProvider !== "figma") return;
    let alive = true;
    setUiuxLoadingProjects(true);
    apiGet<Array<{ id: string; name: string }>>(`/api/tenant/uiux-connections/${uiuxConnId}/projects`)
      .then((r) => { if (alive) setUiuxProjects(Array.isArray(r) ? r : []); })
      .catch((e) => {
        if (!alive) return;
        setUiuxProjects([]);
        setUiuxProjectsError(e instanceof Error ? e.message : "Não foi possível listar os projetos desta conta.");
      })
      .finally(() => { if (alive) setUiuxLoadingProjects(false); });
    return () => { alive = false; };
  }, [uiuxConnId, uiuxSelectedProvider]);

  // Produto e links
  const [products, setProducts]       = useState<{ id: string; name: string }[]>([]);
  const [productId, setProductId]     = useState("");
  const [linkProjectId, setLinkProjectId] = useState("");
  const [linkRelation, setLinkRelation]   = useState("uses_backend");
  const [allProjects, setAllProjects]     = useState<{ id: string; title: string; status: string; project_type?: string }[]>([]);

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
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  // Em tela cheia, no mobile não cabem editor e chat lado a lado → alterna o painel visível.
  // No desktop os dois aparecem juntos (o toggle fica oculto).
  const [fsPane, setFsPane] = useState<"editor" | "chat">("editor");
  const [approving, setApproving]       = useState<"save" | "start" | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Chat de edição de spec (Feature #63)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [chatSending, setChatSending]   = useState(false);
  const [chatError, setChatError]       = useState<string | null>(null);
  const chatPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // No mobile o chat não cabe ao lado do editor → abre em tela cheia via FAB.
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  // Ao cruzar para o desktop (≥md), o chat volta a ser inline → fecha o dialog fullScreen
  // (senão ele ficaria aberto sobre o layout desktop após um resize/rotação).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width:900px)");
    const onChange = () => { if (mq.matches) setMobileChatOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Upload flow
  const [files, setFiles]         = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult]       = useState<SubmitResponse | null>(null);

  useEffect(() => {
    const pp = searchParams?.get("parentProjectId");
    const pt = searchParams?.get("parentTitle");
    const ep = searchParams?.get("editProjectId");
    if (pp) setParentProjectId(pp);
    if (pt) setParentTitle(decodeURIComponent(pt));
    if (ep) setEditProjectId(ep);
  }, [searchParams]);

  // Quando editProjectId estiver presente, carrega a spec existente do servidor
  useEffect(() => {
    if (!editProjectId) return;
    setEditLoading(true);
    setEditLoadError(null);
    apiGet<{ specMarkdown: string; title: string }>(`/api/projects/${editProjectId}/spec-content`)
      .then((data) => {
        setSpecMarkdown(data.specMarkdown);
        if (data.title) setProjectTitle(data.title);
      })
      .catch((e) => setEditLoadError(e instanceof Error ? e.message : "Erro ao carregar spec"))
      .finally(() => setEditLoading(false));
  }, [editProjectId]);

  // Load products + projects for linking
  useEffect(() => {
    apiGet<{ id: string; name: string }[]>("/api/products").then(setProducts).catch(() => {});
    apiGet<{ id: string; title: string; status: string; project_type?: string }[]>("/api/projects").then(setAllProjects).catch(() => {});
  }, []);

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
  }, []);
  useEffect(() => () => stopChatPolling(), [stopChatPolling]);

  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || !specMarkdown || chatSending) return;
    const nextMessages: ChatMessage[] = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatSending(true);
    setChatError(null);
    stopChatPolling();

    let jobId: string;
    try {
      const res = await apiPost<SpecChatJobResponse>("/api/spec-chat", {
        specMarkdown,
        messages: nextMessages,
        projectId: editProjectId ?? undefined,
      });
      jobId = res.jobId;
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Erro ao enviar mensagem.");
      setChatSending(false);
      return;
    }

    const startTs = Date.now();
    chatPollRef.current = setInterval(async () => {
      if (Date.now() - startTs > 11 * 60_000) {
        stopChatPolling();
        setChatError("Tempo esgotado. Tente novamente.");
        setChatSending(false);
        return;
      }
      try {
        const poll = await apiGet<SpecChatJobResponse>(`/api/spec-chat/${jobId}`);
        if (poll.status === "done") {
          stopChatPolling();
          if (poll.specMarkdown) setSpecMarkdown(poll.specMarkdown);
          setChatMessages((prev) => [...prev, { role: "assistant", content: poll.reply || "Spec atualizada." }]);
          setChatSending(false);
        } else if (poll.status === "error") {
          stopChatPolling();
          setChatError(poll.error ?? "O CTO encontrou um erro. Tente novamente.");
          setChatSending(false);
        }
      } catch (e) {
        console.warn("[SpecChat] poll error:", e instanceof Error ? e.message : e);
      }
    }, 8000);
  }, [chatInput, specMarkdown, chatMessages, chatSending, editProjectId, stopChatPolling]);

  // ── Save spec (draft or start) ──────────────────────────────────────────────
  const handleSaveSpec = useCallback(async (startNow: boolean) => {
    if (!specMarkdown) return;
    setApproving(startNow ? "start" : "save"); setApproveError(null);
    try {
      // Modo edição: PATCH spec existente sem criar novo projeto
      if (editProjectId) {
        await apiPatch<{ ok: boolean }>(`/api/projects/${editProjectId}/spec-content`, {
          specMarkdown,
          title: projectTitle.trim() || undefined,
          startNow,
        });
        projectsStore.loadProjects();
        setTimeout(() => router.push(`/projects/${editProjectId}`), 300);
        return;
      }

      // Modo criação: POST nova spec
      const blob = new Blob([specMarkdown], { type: "text/markdown" });
      const filename = `${(projectTitle || "spec").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const file = new File([blob], filename, { type: "text/markdown" });
      const formData = new FormData();
      formData.append("title", projectTitle.trim() || "Spec sem título");
      if (parentProjectId) formData.append("parentProjectId", parentProjectId);
      if (freeText.trim()) formData.append("freeDescription", freeText.trim());
      if (projectType) formData.append("projectType", projectType);
      if (productId) formData.append("productId", productId);
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
      // Item 3: Ferramentas UI/UX — conta + projetos escolhidos; o backend extrai as
      // definições de design e injeta um documento UI/UX no bundle da spec.
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
      // RASCUNHO: quando não é "iniciar agora", nasce como 'draft' (aguardando início manual),
      // não 'spec_submitted' — assim o portal mostra "Rascunho" + botão Iniciar, em vez de
      // "Em execução" sem ação.
      if (!startNow) formData.append("draft", "true");
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

      if (startNow) {
        try { await apiPost(`/api/projects/${data.projectId}/run`, {}); } catch { /* ok */ }
      }
      setTimeout(() => router.push(`/projects/${data.projectId}`), 500);
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : "Erro ao salvar spec.");
    } finally {
      setApproving(null);
    }
  }, [specMarkdown, projectTitle, parentProjectId, editProjectId, freeText, uiuxConnId, uiuxProjectIds,
      projectType, deliveryMode, cloudConnId, deployFormat, deployTtlDays, router]);

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
      if (projectType) fd.append("projectType", projectType);
      if (productId) fd.append("productId", productId);
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
      // RASCUNHO: upload sem "iniciar agora" nasce como 'draft'.
      if (!startNow) fd.append("draft", "true");
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
        {/* Toggle editor↔chat só no mobile (xs); no desktop os dois painéis ficam lado a lado. */}
        <Stack direction="row" spacing={1}
          sx={{ display: { xs: "flex", md: "none" }, p: 1, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}>
          <Button fullWidth size="small" startIcon={<EditIcon />}
            variant={fsPane === "editor" ? "contained" : "outlined"} onClick={() => setFsPane("editor")}>Editor</Button>
          <Button fullWidth size="small" startIcon={<AutoFixHighIcon />}
            variant={fsPane === "chat" ? "contained" : "outlined"} onClick={() => setFsPane("chat")}>Melhorar com IA</Button>
        </Stack>
        <Box sx={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
          {/* Editor: sempre visível no desktop; no mobile só quando o painel selecionado é 'editor'. */}
          <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", display: { xs: fsPane === "editor" ? "flex" : "none", md: "flex" } }}>
            <SpecEditor
              value={specMarkdown} onChange={setSpecMarkdown}
              fullscreen={true} onToggleFullscreen={() => setEditorFullscreen(false)}
              onSave={() => handleSaveSpec(false)} onSaveAndStart={() => handleSaveSpec(true)} approving={approving}
              onRegen={editProjectId ? undefined : () => { setEditorFullscreen(false); setSpecMarkdown(null); }}
              regenDisabled={editProjectId ? true : generating}
            />
          </Box>
          {/* Feature #63 — chat "Melhorar com IA" TAMBÉM em tela cheia: painel à direita no desktop;
              no mobile ocupa a tela quando selecionado. Antes o dialog só mostrava o editor (bug). */}
          <Box sx={{
            width: { xs: "100%", md: 380 }, flexShrink: 0, minWidth: 0, overflow: "hidden",
            borderLeft: { md: "1px solid" }, borderColor: { md: "divider" },
            display: { xs: fsPane === "chat" ? "flex" : "none", md: "flex" },
          }}>
            <SpecChatPanel
              messages={chatMessages} input={chatInput} onInput={setChatInput}
              onSend={handleChatSend} sending={chatSending} error={chatError}
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
          />
        </DialogContent>
      </Dialog>
    </>
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
              Edite a spec antes de iniciar o pipeline.
            </Typography>
          </Box>
          <Button size="small" color="inherit" onClick={() => router.push(`/projects/${editProjectId}`)}>
            ← Voltar ao projeto
          </Button>
        </Stack>

        {editLoadError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setEditLoadError(null)}>{editLoadError}</Alert>
        )}

        {editLoading && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 6, justifyContent: "center" }}>
            <CircularProgress size={24} />
            <Typography variant="body2" color="text.secondary">Carregando spec…</Typography>
          </Box>
        )}

        {!editLoading && specMarkdown !== null && (
          <Card>
            <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
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
                  <Button size="small" color="inherit" onClick={() => router.push(`/projects/${editProjectId}`)}>
                    Descartar
                  </Button>
                  <Button size="small" variant="outlined" disabled={!!approving}
                    startIcon={approving === "save" ? <CircularProgress size={14} color="inherit" /> : undefined}
                    onClick={() => handleSaveSpec(false)}>
                    {approving === "save" ? "Salvando…" : "Salvar"}
                  </Button>
                  <Button size="small" variant="contained" disabled={!!approving}
                    startIcon={approving === "start" ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon />}
                    onClick={() => handleSaveSpec(true)}>
                    {approving === "start" ? "Iniciando…" : "Salvar e Iniciar"}
                  </Button>
                </Stack>
              </Stack>
              <Box sx={{ height: { xs: 520, sm: 600 }, overflow: "hidden", display: "flex" }}>
                <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
                  <SpecEditor
                    value={specMarkdown} onChange={setSpecMarkdown}
                    fullscreen={false} onToggleFullscreen={() => setEditorFullscreen(true)}
                    onSave={() => handleSaveSpec(false)} onSaveAndStart={() => handleSaveSpec(true)} approving={approving}
                    onRegen={undefined}
                    regenDisabled={true}
                  />
                </Box>
                {/* Feature #63 — painel de chat à direita do editor/preview (oculto no mobile: editor ocupa a tela; usar tela cheia p/ chat) */}
                <Box sx={{ width: { xs: 300, md: 380 }, flexShrink: 0, borderLeft: "1px solid", borderColor: "divider", display: { xs: "none", md: "block" } }}>
                  <SpecChatPanel
                    messages={chatMessages} input={chatInput} onInput={setChatInput}
                    onSend={handleChatSend} sending={chatSending} error={chatError}
                  />
                </Box>
              </Box>
            </CardContent>
          </Card>
        )}

        {editorDialog}
        {specMarkdown !== null && !editLoading && mobileChat}
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
                      uiuxLoadingProjects={uiuxLoadingProjects} uiuxProjectsError={uiuxProjectsError} />
                    <ProductLinkSection
                      products={products} productId={productId} onProductId={setProductId}
                      onProductsReload={() => apiGet<{ id: string; name: string }[]>("/api/products").then(setProducts).catch(() => {})}
                      allProjects={allProjects} linkProjectId={linkProjectId} onLinkProjectId={setLinkProjectId}
                      linkRelation={linkRelation} onLinkRelation={setLinkRelation}
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
                          onSave={() => handleSaveSpec(false)} onSaveAndStart={() => handleSaveSpec(true)} approving={approving}
                          onRegen={() => setSpecMarkdown(null)}
                          regenDisabled={generating}
                        />
                      </Box>
                      <Box sx={{ width: { xs: 280, md: 360 }, flexShrink: 0, borderLeft: "1px solid", borderColor: "divider", display: { xs: "none", md: "block" } }}>
                        <SpecChatPanel
                          messages={chatMessages} input={chatInput} onInput={setChatInput}
                          onSend={handleChatSend} sending={chatSending} error={chatError}
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
                    uiuxLoadingProjects={uiuxLoadingProjects} uiuxProjectsError={uiuxProjectsError} />
                  <ProductLinkSection
                    products={products} productId={productId} onProductId={setProductId}
                    onProductsReload={() => apiGet<{ id: string; name: string }[]>("/api/products").then(setProducts).catch(() => {})}
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
      {tab === 0 && specMarkdown !== null && mobileChat}
    </Box>
  );
}
