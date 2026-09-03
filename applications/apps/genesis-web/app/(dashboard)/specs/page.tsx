"use client";

// Tela "Bancada" (RFC-0003 F1 — antes "SPECs", Feature #64/#65).
// A Bancada é o espaço de DESENHO anterior à fábrica: especifica-se à vontade e de graça;
// só o que é viável é promovido. Uma SPEC/rascunho vive AQUI (nunca em "Meus projetos").
// - Aba "Minhas SPECs": lista rascunhos do tenant, AGRUPADOS por produto. Cada SPEC pode:
//   Editar; Vincular a produto (PATCH /api/projects/:id/product); Decompor em vários projetos
//   (DecomposeDialog → /decompose, salva rascunhos na Bancada, dispatch:false); ou
//   Promover à fábrica (POST /api/projects/:id/run). Um produto inteiro promove pelas raízes
//   (POST /api/products/:id/promote). "Decompor uma ideia" abre o mesmo diálogo em modo cru.
// - Aba "Catálogo": SPECs pré-prontas (GET /api/catalog); "Usar" cria uma SPEC do template.

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputAdornment from "@mui/material/InputAdornment";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import LinkIcon from "@mui/icons-material/Link";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import HandymanIcon from "@mui/icons-material/Handyman";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import SearchIcon from "@mui/icons-material/Search";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import ViewListIcon from "@mui/icons-material/ViewList";
import ViewKanbanIcon from "@mui/icons-material/ViewKanban";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import CloseIcon from "@mui/icons-material/Close";
import IconButton from "@mui/material/IconButton";
import { apiGet, apiPatch, apiPost, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";
import { DecomposeDialog, type DecomposeSpecRef } from "@/components/DecomposeDialog";
import { ReadinessBadge, EstimateChip, type Readiness, type Estimate } from "@/components/SpecEnrichment";
import { ResourceBadges } from "@/components/ResourceBadges";

interface SpecItem {
  id: string;
  title: string;
  status: string;
  product_id: string | null;
  product_name: string | null;
  /** §5.4: true quando a SPEC ainda mora no INBOX "Rascunhos" do tenant (pré-fábrica, re-alocável). */
  product_is_inbox?: boolean | null;
  version_number?: number | null;
  extra?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // RFC-0003 E2/E3 — anexados por /api/specs (determinístico). Opcionais: ambientes
  // antigos ou falha de enriquecimento degradam para specs sem esses campos.
  readiness?: Readiness | null;
  estimate?: Estimate | null;
}
interface CatalogItem {
  slug: string;
  title: string;
  category: string;
  description: string;
  tags: string[];
}
// Detalhe do catálogo (GET /api/catalog/:slug) — inclui o markdown para o preview "Ver/Ler".
interface CatalogDetail extends CatalogItem {
  template_markdown: string;
}

// react-markdown + GFM carregados sob demanda (mesmo padrão do DocViewerModal): só quando o
// usuário abre o preview de um template, sem pesar o bundle da Bancada.
const CatalogMarkdown = dynamic(
  () => Promise.all([import("react-markdown"), import("remark-gfm")])
    .then(([md, gfm]) => {
      const Comp = ({ children }: { children: string }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (md.default as any)({ remarkPlugins: [gfm.default], children });
      Comp.displayName = "CatalogMarkdownGFM";
      return { default: Comp };
    }),
  { ssr: false },
);
interface ProductOption { id: string; name: string; is_inbox?: boolean }

function formatDate(s: string): string {
  try { return new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return s; }
}

// §5.4: rascunho "esquecido" no inbox = sem atualização há mais de STALE_DAYS dias.
// Alimenta o badge de higiene da caixa de entrada (organize ou descarte).
const STALE_DAYS = 14;
function isStale(updatedAt: string): boolean {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_DAYS * 24 * 60 * 60 * 1000;
}

// Rótulo do chip por status da SPEC. /api/specs lista projetos ainda não promovidos ao
// pipeline: 'draft' (rascunho), 'spec_submitted' (enviada) e 'pending_conversion' (anexos
// em conversão). Antes o chip era fixo em "Rascunho" — enganoso para specs enviadas.
function specStatusLabel(status: string): string {
  switch (status) {
    case "draft": return "Rascunho";
    case "spec_submitted": return "Enviada";
    case "pending_conversion": return "Em conversão";
    default: return "SPEC";
  }
}

// Status pré-fábrica: rascunhos que vivem na Bancada. Tudo além disso já foi promovido
// (fábrica/concluído) → alimenta a coluna "Promovido" do board de triagem (E1).
const PRE_FACTORY_STATUSES = new Set(["draft", "spec_submitted", "pending_conversion", "spec_validation_failed"]);

function SpecsPageInner() {
  const router = useRouter();
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <HandymanIcon sx={{ color: "#0EA5E9" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Bancada</Typography>
          <Typography variant="body2" color="text.secondary">
            Desenhe à vontade antes da fábrica: especifique, decomponha em projetos e refine.
            Só o que for viável você promove — e só aí a fábrica roda.
          </Typography>
        </Box>
      </Stack>

      <Card>
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
          sx={{ borderBottom: "1px solid", borderColor: "divider", px: 2 }}>
          <Tab label="Minhas SPECs" sx={{ textTransform: "none", minHeight: 48 }} />
          <Tab label="Catálogo" sx={{ textTransform: "none", minHeight: 48 }} />
        </Tabs>
        <CardContent>
          {tab === 0 ? <MySpecs router={router} /> : <Catalog router={router} />}
        </CardContent>
      </Card>
    </Box>
  );
}

// ── Aba: Minhas SPECs ─────────────────────────────────────────────────────────
// observer: lê tenantScopeStore.selectedTenantId; sem isso a troca de tenant no
// seletor do topo não recarregaria a listagem (o pai é observer, mas não observa
// o escopo por si só, e este componente não re-renderiza sozinho).
const MySpecs = observer(function MySpecs({ router }: { router: ReturnType<typeof useRouter> }) {
  const [specs, setSpecs] = useState<SpecItem[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<SpecItem | null>(null);
  const [linkProductId, setLinkProductId] = useState("");
  // Decompor: alvo é uma SPEC salva (modo spec). ideaOpen abre o mesmo diálogo em modo cru.
  const [decomposeSpec, setDecomposeSpec] = useState<DecomposeSpecRef | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  // E1: alterna entre lista agrupada e board de triagem (rascunho · pronto · promovido).
  const [view, setView] = useState<"list" | "triage">("list");
  // E3: confirmação de promoção mostra estimativa + pré-flight antes de queimar fábrica.
  const [promoteTarget, setPromoteTarget] = useState<SpecItem | null>(null);

  // Master: escopa a listagem pelo tenant selecionado no topo (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;
  // Conta de gestão (zentriz_admin) só VISUALIZA specs do tenant — sem CTAs de AUTORIA
  // (Editar/Vincular/Decompor/Promover à fábrica; backend bloqueia via 403). Promover o
  // PRODUTO inteiro é operação (C6) — permitida ao master, tratada à parte.
  const isMaster = authStore.isZentrizAdmin;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiGet<SpecItem[]>(withQuery("/api/specs", { tenantId: scopeTenantId }));
      setSpecs(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar SPECs");
    } finally {
      setLoading(false);
    }
  }, [scopeTenantId]);

  useEffect(() => {
    load();
    // includeInbox=1: o diálogo "Vincular" precisa oferecer o INBOX como destino (devolver à caixa).
    apiGet<ProductOption[]>(withQuery("/api/products", { tenantId: scopeTenantId, includeInbox: "1" })).then(setProducts).catch(() => {});
    // Projetos já promovidos alimentam a coluna "Promovido" do board de triagem (E1).
    projectsStore.loadProjects();
  }, [load, scopeTenantId]);

  // Promover à FÁBRICA (spec individual). POST /run — o backend barra dependência não-pronta.
  const promoteToFactory = async (id: string) => {
    setBusyId(id);
    try {
      await apiPost(`/api/projects/${id}/run`, {});
      router.push(`/projects/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao promover à fábrica");
      setBusyId(null);
    }
  };

  // Promover PRODUTO inteiro (raízes disparadas em cascata pela fábrica). Operação: master OK.
  const promoteProduct = async (productId: string) => {
    setBusyId(`prod:${productId}`);
    try {
      const res = await apiPost<{ promoted?: string[] }>(`/api/products/${productId}/promote`, {});
      const n = res.promoted?.length ?? 0;
      setNotice(`Produto promovido à fábrica — ${n} raiz(es) em execução. As ondas seguintes disparam automaticamente.`);
      router.push("/projects");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao promover o produto");
      setBusyId(null);
    }
  };

  const confirmLink = async () => {
    if (!linkTarget) return;
    setBusyId(linkTarget.id);
    try {
      // §5.4: product_id é NOT NULL pós-064. "Sem produto" não existe mais — vazio devolve
      // a SPEC ao INBOX (nunca null). O backend também resolve null→inbox, mas mandamos o id.
      const inboxId = products.find((p) => p.is_inbox)?.id ?? null;
      await apiPatch(`/api/projects/${linkTarget.id}/product`, { productId: linkProductId || inboxId });
      setLinkTarget(null); setLinkProductId("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao vincular a produto");
    } finally {
      setBusyId(null);
    }
  };

  // §5.4: agrupa specs por produto (product_id, NOT NULL pós-064). O INBOX "Rascunhos" é um
  // grupo como outro qualquer, mas rotulado e ordenado à parte (sempre primeiro) — é a caixa
  // de entrada pré-fábrica, o único lugar onde rascunhos ainda não organizados vivem.
  const groups = useMemo(() => {
    const byProduct = new Map<string, { name: string; isInbox: boolean; specs: SpecItem[] }>();
    for (const s of specs) {
      const pid = s.product_id;
      if (!pid) continue; // pós-064 não deve ocorrer; ignora órfã defensivamente.
      const g = byProduct.get(pid) ?? { name: s.product_name ?? "Produto", isInbox: s.product_is_inbox === true, specs: [] };
      if (s.product_name) g.name = s.product_name;
      if (s.product_is_inbox === true) g.isInbox = true;
      g.specs.push(s);
      byProduct.set(pid, g);
    }
    return Array.from(byProduct.entries())
      .map(([id, g]) => ({ productId: id, name: g.isInbox ? "Rascunhos (inbox)" : g.name, isInbox: g.isInbox, specs: g.specs }))
      .sort((a, b) => {
        if (a.isInbox !== b.isInbox) return a.isInbox ? -1 : 1; // inbox primeiro
        return a.name.localeCompare(b.name, "pt-BR");
      });
  }, [specs]);

  // E1 · Board de triagem — duas colunas de Bancada por prontidão + uma coluna do que já
  // foi promovido. "Pronto para promover" = readiness.level === "ready" (título+tech+deps ok).
  // "Rascunho" = todo o resto (incompleta/quase, ou sem enriquecimento). "Promovido" vem do
  // projectsStore (já escopado por tenant) filtrando fora os status pré-fábrica.
  const triage = useMemo(() => {
    const rascunho: SpecItem[] = [];
    const pronto: SpecItem[] = [];
    for (const s of specs) {
      if (s.readiness?.level === "ready") pronto.push(s);
      else rascunho.push(s);
    }
    return { rascunho, pronto };
  }, [specs]);
  const promoted = projectsStore.list.filter((p) => !PRE_FACTORY_STATUSES.has(p.status));

  // Card de uma SPEC (reusado em cada grupo).
  const renderSpec = (s: SpecItem) => {
    const busy = busyId === s.id;
    return (
      <Card key={s.id} variant="outlined" sx={{ p: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, p: 2, flexWrap: "wrap" }}>
          <Box sx={{ flexGrow: 1, minWidth: 220 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle2" fontWeight={600}>{s.title}</Typography>
              <Chip label={specStatusLabel(s.status)} size="small" color="default" sx={{ fontSize: "0.62rem", height: 18 }} />
              {s.readiness && <ReadinessBadge readiness={s.readiness} />}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Atualizada em {formatDate(s.updated_at)}
              </Typography>
              {s.estimate && <EstimateChip estimate={s.estimate} />}
            </Stack>
          </Box>
          {!isMaster && (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button size="small" variant="outlined" startIcon={<EditIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={busy} onClick={() => router.push(`/spec?editProjectId=${s.id}`)}>
                Editar
              </Button>
              <Button size="small" variant="outlined" startIcon={<LinkIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={busy} onClick={() => { setLinkTarget(s); setLinkProductId(s.product_id ?? ""); }}>
                Vincular
              </Button>
              {/* §5.4: Decompor só faz sentido para spec AINDA no INBOX (não organizada num produto).
                  Uma vez alocada a um produto real, o vínculo é definitivo (backend: 409 se já em produto). */}
              {s.product_is_inbox === true && (
                <Button size="small" variant="outlined" color="secondary" startIcon={<CallSplitIcon sx={{ fontSize: "0.9rem" }} />}
                  disabled={busy} onClick={() => setDecomposeSpec({ id: s.id, title: s.title })}>
                  Decompor
                </Button>
              )}
              <Button size="small" variant="contained" color="success"
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <RocketLaunchIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={busy} onClick={() => setPromoteTarget(s)}>
                Promover à fábrica
              </Button>
            </Stack>
          )}
        </Box>
      </Card>
    );
  };

  // Card compacto de um projeto já promovido (coluna "Promovido" do board).
  const renderPromoted = (p: (typeof promoted)[number]) => (
    <Card key={p.id} variant="outlined" sx={{ p: 0, cursor: "pointer" }}
      onClick={() => router.push(`/projects/${p.id}`)}>
      <Box sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" fontWeight={600} noWrap>{p.title}</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
          <Chip label={p.status} size="small" variant="outlined" sx={{ fontSize: "0.6rem", height: 18 }} />
          {p.productName && (
            <Typography variant="caption" color="text.secondary" noWrap>{p.productName}</Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <ResourceBadges
            repoUrl={p.repoUrl} repoFullName={p.repoFullName}
            deployUrl={p.deployUrl} deployStatus={p.deployStatus}
            backendDeployStatus={p.backendDeployStatus}
          />
        </Stack>
      </Box>
    </Card>
  );

  // Uma coluna do board de triagem (E1). accent tinge o cabeçalho.
  const triageColumn = (title: string, accent: string, hint: string, count: number, children: ReactNode) => (
    <Box sx={{ flex: 1, minWidth: 260, bgcolor: alpha(accent, 0.04), border: "1px solid", borderColor: alpha(accent, 0.25), borderRadius: 2, p: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: accent }} />
        <Typography variant="subtitle2" fontWeight={700}>{title}</Typography>
        <Chip label={count} size="small" sx={{ fontSize: "0.6rem", height: 18, bgcolor: alpha(accent, 0.18), color: accent, fontWeight: 700 }} />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5, lineHeight: 1.4 }}>{hint}</Typography>
      {count === 0
        ? <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>Nada aqui ainda.</Typography>
        : <Stack spacing={1.5}>{children}</Stack>}
    </Box>
  );

  if (loading) {
    return <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}><CircularProgress size={28} /></Box>;
  }

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {/* Barra de ações da Bancada (autoria) */}
      {!isMaster && (
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}>
          <Button variant="contained" startIcon={<AddCircleOutlineIcon />} onClick={() => router.push("/spec")}>
            Nova SPEC
          </Button>
          <Button variant="outlined" color="secondary" startIcon={<CallSplitIcon />} onClick={() => setIdeaOpen(true)}>
            Decompor uma ideia
          </Button>
        </Stack>
      )}

      {specs.length === 0 ? (
        <Box sx={{ textAlign: "center", py: 6 }}>
          <Typography variant="body2" color="text.secondary">
            {isMaster
              ? "Este tenant ainda não possui SPECs na Bancada."
              : "Bancada vazia. Crie uma SPEC do zero, decomponha uma ideia, ou parta de um template do catálogo."}
          </Typography>
        </Box>
      ) : (
        <>
          {/* E1 · alterna entre a lista agrupada por produto e o board de triagem por prontidão. */}
          <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
            <ToggleButtonGroup size="small" exclusive value={view}
              onChange={(_e, v) => { if (v) setView(v); }}>
              <ToggleButton value="list" sx={{ textTransform: "none", px: 1.5 }}>
                <ViewListIcon sx={{ fontSize: "1rem", mr: 0.5 }} /> Por produto
              </ToggleButton>
              <ToggleButton value="triage" sx={{ textTransform: "none", px: 1.5 }}>
                <ViewKanbanIcon sx={{ fontSize: "1rem", mr: 0.5 }} /> Triagem
              </ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          {view === "triage" ? (
            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems="stretch">
              {triageColumn(
                "Rascunho", "#94A3B8",
                "Ainda incompletas — falta título, tecnologia ou dependência. Refine antes de promover.",
                triage.rascunho.length,
                triage.rascunho.map(renderSpec),
              )}
              {triageColumn(
                "Pronto para promover", "#22C55E",
                "Passaram no pré-flight (título · tecnologia · dependências). É só promover à fábrica.",
                triage.pronto.length,
                triage.pronto.map(renderSpec),
              )}
              {triageColumn(
                "Promovido", "#6366F1",
                "Já saíram da Bancada e estão em fábrica ou concluídos. Clique para abrir o cockpit.",
                promoted.length,
                promoted.map(renderPromoted),
              )}
            </Stack>
          ) : (
        <Stack spacing={3}>
          {/* Produtos reais → CARDS de hierarquia navegáveis. Clicar abre a PASTA do produto
              (editor estilo VSCode, produto inteiro — /products/:id/spec). As ações por-arquivo
              (editar/validar/chat) vivem lá dentro; "Promover produto inteiro" fica no card. */}
          {groups.some((g) => !g.isInbox) && (
            <Box>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Inventory2OutlinedIcon sx={{ fontSize: "1rem", color: "#8B5CF6" }} />
                <Typography variant="subtitle2" fontWeight={700} sx={{ color: "#8B5CF6" }}>Produtos</Typography>
              </Stack>
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "1fr 1fr 1fr" }, gap: 1.5 }}>
                {groups.filter((g) => !g.isInbox).map((g) => (
                  <Card key={g.productId} variant="outlined"
                    sx={{ display: "flex", flexDirection: "column", borderTop: "3px solid #8B5CF6",
                      transition: "box-shadow 0.15s, transform 0.15s", "&:hover": { boxShadow: 3, transform: "translateY(-2px)" } }}>
                    <CardActionArea onClick={() => router.push(`/products/${g.productId}/spec`)} sx={{ flexGrow: 1 }}>
                      <CardContent sx={{ pb: 1 }}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                          <FolderOpenOutlinedIcon sx={{ fontSize: "1.1rem", color: "#8B5CF6" }} />
                          <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ flexGrow: 1 }}>{g.name}</Typography>
                        </Stack>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip label={`${g.specs.length} spec(s)`} size="small" variant="outlined" sx={{ fontSize: "0.6rem", height: 18 }} />
                          <Typography variant="caption" color="text.secondary">Abrir pasta do produto</Typography>
                        </Stack>
                      </CardContent>
                    </CardActionArea>
                    {/* Promover produto inteiro — operação; master também pode (C6). */}
                    <Box sx={{ px: 2, pb: 1.5, pt: 0.25 }}>
                      <Button fullWidth size="small" variant="contained" color="success"
                        startIcon={busyId === `prod:${g.productId}` ? <CircularProgress size={14} color="inherit" /> : <RocketLaunchIcon sx={{ fontSize: "0.9rem" }} />}
                        disabled={busyId === `prod:${g.productId}`}
                        onClick={(e) => { e.stopPropagation(); promoteProduct(g.productId); }}>
                        Promover produto inteiro
                      </Button>
                    </Box>
                  </Card>
                ))}
              </Box>
            </Box>
          )}

          {/* INBOX "Rascunhos" — permanece como linhas de spec com ações (Editar/Vincular/Decompor/Promover);
              cada rascunho ainda não pertence a um produto, então não há "pasta de produto" para abrir. */}
          {groups.filter((g) => g.isInbox).map((g) => {
            const staleCount = g.specs.filter((s) => isStale(s.updated_at)).length;
            return (
            <Box key={g.productId}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: "wrap", gap: 1 }}>
                <HandymanIcon sx={{ fontSize: "1rem", color: "#F59E0B" }} />
                <Typography variant="subtitle2" fontWeight={700} sx={{ color: "#F59E0B" }}>{g.name}</Typography>
                <Chip label={`${g.specs.length} spec(s)`} size="small" variant="outlined" sx={{ fontSize: "0.6rem", height: 18 }} />
                {staleCount > 0 && (
                  <Chip label={`${staleCount} parada(s) há +${STALE_DAYS}d`} size="small" color="warning" variant="outlined"
                    sx={{ fontSize: "0.6rem", height: 18 }} />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, ml: 0.25 }}>
                Caixa de entrada pré-fábrica: rascunhos ainda não organizados. Decomponha, vincule a um produto
                ou promova cada um. Ao promover, um rascunho solo vira produto próprio.
              </Typography>
              <Stack spacing={1.5}>
                {g.specs.map(renderSpec)}
              </Stack>
            </Box>
            );
          })}
        </Stack>
          )}
        </>
      )}

      {/* Diálogo de decomposição — modo SPEC (a partir de uma spec salva) */}
      <DecomposeDialog
        open={!!decomposeSpec}
        spec={decomposeSpec}
        onClose={() => setDecomposeSpec(null)}
        onSaved={() => { setNotice("Projetos salvos na Bancada como rascunhos. Promova quando quiser."); load(); }}
      />
      {/* Diálogo de decomposição — modo IDEIA (texto cru) */}
      <DecomposeDialog
        open={ideaOpen}
        spec={null}
        onClose={() => setIdeaOpen(false)}
        onSaved={() => { setNotice("Ideia decomposta e salva na Bancada como rascunhos."); load(); }}
      />

      {/* Dialog: vincular a produto */}
      <Dialog open={!!linkTarget} onClose={() => setLinkTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem" }}>Vincular SPEC a um produto</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>
            Um produto agrupa projetos relacionados. Escolha “Rascunhos (inbox)” para devolver a SPEC
            à caixa de entrada pré-fábrica (toda SPEC pertence a um produto — não existe mais “sem produto”).
          </Typography>
          <FormControl fullWidth size="small">
            <InputLabel>Produto</InputLabel>
            <Select value={linkProductId} label="Produto" onChange={(e) => setLinkProductId(e.target.value)}>
              {products.map((p) => (
                <MenuItem key={p.id} value={p.id}>{p.is_inbox ? <em>Rascunhos (inbox)</em> : p.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLinkTarget(null)}>Cancelar</Button>
          <Button variant="contained" onClick={confirmLink} disabled={busyId === linkTarget?.id}>Salvar</Button>
        </DialogActions>
      </Dialog>

      {/* E3 · Confirmação de promoção — mostra estimativa (tempo/custo) + pré-flight ANTES de
          queimar fábrica. Promover é irreversível (roda o pipeline), então nunca é 1-clique. */}
      <Dialog open={!!promoteTarget} onClose={() => busyId ? undefined : setPromoteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem", display: "flex", alignItems: "center", gap: 1 }}>
          <RocketLaunchIcon sx={{ fontSize: "1.1rem", color: "success.main" }} /> Promover à fábrica
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            A SPEC <b>{promoteTarget?.title}</b> sairá da Bancada e a fábrica começará a executá-la.
            Esta ação dispara o pipeline — confira a prontidão e a estimativa antes.
          </Typography>

          {promoteTarget?.readiness && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
              <Typography variant="caption" color="text.secondary">Prontidão:</Typography>
              <ReadinessBadge readiness={promoteTarget.readiness} />
            </Stack>
          )}
          {promoteTarget?.estimate && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="caption" color="text.secondary">Estimativa:</Typography>
              <EstimateChip estimate={promoteTarget.estimate} />
            </Stack>
          )}

          {promoteTarget?.readiness && promoteTarget.readiness.level !== "ready" && (
            <Alert severity="warning" sx={{ mt: 1.5, py: 0.5 }}>
              Esta SPEC ainda não passou no pré-flight. Você pode promover mesmo assim, mas a fábrica
              pode barrar dependências não concluídas. Abra a prontidão acima para ver o que falta.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPromoteTarget(null)} disabled={!!busyId}>Cancelar</Button>
          <Button variant="contained" color="success"
            startIcon={busyId === promoteTarget?.id ? <CircularProgress size={14} color="inherit" /> : <RocketLaunchIcon sx={{ fontSize: "0.9rem" }} />}
            disabled={!!busyId}
            onClick={() => { if (promoteTarget) promoteToFactory(promoteTarget.id); }}>
            Promover agora
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
});

// Cor estável por categoria: deriva um índice do nome (hash simples) e mapeia numa
// paleta fixa. Categorias novas ganham cor consistente sem manutenção manual.
const CATEGORY_PALETTE = [
  "#0EA5E9", "#22C55E", "#F59E0B", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
  "#06B6D4", "#D946EF", "#3B82F6", "#10B981",
];
// Chave canônica de categoria: remove acentos + caixa baixa + trim.
// Usada para AGRUPAR variantes de escrita (ex.: "Logística" e "Logistica" → mesma chave),
// deduplicando os filtros/chips independentemente do estado do dado no banco.
function normCategoryKey(category: string): string {
  return category.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
// Cor derivada da CHAVE canônica → variantes de escrita compartilham a mesma cor.
function categoryColor(category: string): string {
  const key = normCategoryKey(category);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length];
}
// Escolhe o melhor rótulo de exibição entre variantes de uma mesma chave:
// prefere a que TEM acento (difere do próprio ASCII), depois a mais longa, depois alfabética.
function pickCanonicalLabel(a: string, b: string): string {
  const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const aAcc = a !== strip(a);
  const bAcc = b !== strip(b);
  if (aAcc !== bAcc) return aAcc ? a : b;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a.localeCompare(b, "pt-BR") <= 0 ? a : b;
}

// ── Aba: Catálogo ───────────────────────────────────────────────────────────
function Catalog({ router }: { router: ReturnType<typeof useRouter> }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("");
  const [query, setQuery] = useState("");
  const [usingSlug, setUsingSlug] = useState<string | null>(null);
  // Preview "Ver/Ler": guarda o slug aberto, o detalhe carregado e o estado de carga.
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<CatalogDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Conta de gestão só navega o catálogo (visualização); "Usar" é autoria (403 no backend).
  const isMaster = authStore.isZentrizAdmin;

  useEffect(() => {
    setLoading(true);
    apiGet<CatalogItem[]>("/api/catalog")
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar catálogo"))
      .finally(() => setLoading(false));
  }, []);

  // Categorias agrupadas por CHAVE canônica (dedup por acento/caixa) com contagem e rótulo
  // canônico. `key` é usado no estado do filtro; `name` é o rótulo exibido.
  const categories = useMemo(() => {
    const byKey = new Map<string, { name: string; count: number }>();
    for (const it of items) {
      const key = normCategoryKey(it.category);
      const prev = byKey.get(key);
      if (prev) byKey.set(key, { name: pickCanonicalLabel(prev.name, it.category), count: prev.count + 1 });
      else byKey.set(key, { name: it.category, count: 1 });
    }
    return Array.from(byKey.entries())
      .map(([key, v]) => ({ key, name: v.name, count: v.count }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [items]);

  // Mapa chave-canônica → rótulo exibido (para normalizar o chip de cada card também).
  const canonLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.key, c.name);
    return m;
  }, [categories]);

  // Filtra por categoria (comparando a CHAVE canônica) + busca textual.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (category && normCategoryKey(it.category) !== category) return false;
      if (!q) return true;
      const haystack = `${it.title} ${it.description} ${it.category} ${(it.tags ?? []).join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [items, category, query]);

  // Abre o preview do template e busca o markdown completo (GET /api/catalog/:slug).
  // Disponível a TODOS (inclusive gestão) — é leitura, não autoria.
  const openPreview = async (slug: string) => {
    setPreviewSlug(slug);
    setPreviewData(null);
    setPreviewLoading(true);
    try {
      const d = await apiGet<CatalogDetail>(`/api/catalog/${slug}`);
      setPreviewData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar o modelo");
      setPreviewSlug(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const use = async (slug: string) => {
    setUsingSlug(slug);
    try {
      const res = await apiPost<{ projectId: string }>(`/api/catalog/${slug}/use`, {});
      router.push(`/spec?editProjectId=${res.projectId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao usar template");
      setUsingSlug(null);
    }
  };

  if (loading) {
    return <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}><CircularProgress size={28} /></Box>;
  }

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
        {items.length} modelos prontos para começar rápido. Ao usar, uma SPEC editável é criada a partir do template.
      </Typography>

      {/* Busca textual */}
      <TextField
        fullWidth
        size="small"
        placeholder="Buscar por nome, descrição, categoria ou tag…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 2 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" sx={{ color: "text.disabled" }} />
            </InputAdornment>
          ),
        }}
      />

      {/* Filtros por categoria (com contagem e cor) */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}>
        <Chip
          label={`Todas · ${items.length}`}
          size="small"
          variant={category === "" ? "filled" : "outlined"}
          color={category === "" ? "primary" : "default"}
          onClick={() => setCategory("")}
        />
        {categories.map((c) => {
          const color = categoryColor(c.name);
          const active = category === c.key;
          return (
            <Chip
              key={c.key}
              label={`${c.name} · ${c.count}`}
              size="small"
              onClick={() => setCategory(active ? "" : c.key)}
              variant={active ? "filled" : "outlined"}
              sx={{
                fontWeight: 600,
                ...(active
                  ? { bgcolor: color, color: "#fff", "&:hover": { bgcolor: color } }
                  : { borderColor: alpha(color, 0.5), color }),
              }}
            />
          );
        })}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
        {filtered.length} {filtered.length === 1 ? "modelo encontrado" : "modelos encontrados"}
        {category ? ` em ${canonLabelByKey.get(category) ?? category}` : ""}{query.trim() ? ` para “${query.trim()}”` : ""}
      </Typography>

      {filtered.length === 0 ? (
        <Box sx={{ textAlign: "center", py: 6 }}>
          <SearchOffIcon sx={{ fontSize: 40, color: "text.disabled", mb: 1 }} />
          <Typography variant="body2" color="text.secondary">
            Nenhum modelo corresponde ao filtro. Tente outra busca ou categoria.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "1fr 1fr 1fr" }, gap: 1.5 }}>
          {filtered.map((it) => {
            const color = categoryColor(it.category);
            const busy = usingSlug === it.slug;
            return (
              <Card
                key={it.slug}
                variant="outlined"
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  borderTop: `3px solid ${color}`,
                  transition: "box-shadow 0.15s, transform 0.15s",
                  "&:hover": { boxShadow: 3, transform: "translateY(-2px)" },
                }}
              >
                <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                  <Chip
                    label={canonLabelByKey.get(normCategoryKey(it.category)) ?? it.category}
                    size="small"
                    sx={{ fontSize: "0.6rem", height: 18, mb: 1, fontWeight: 700, bgcolor: alpha(color, 0.15), color }}
                  />
                  <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>{it.title}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.5 }}>
                    {it.description}
                  </Typography>
                  {it.tags && it.tags.length > 0 && (
                    <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: "wrap", gap: 0.5 }}>
                      {it.tags.slice(0, 4).map((t) => (
                        <Chip
                          key={t}
                          label={t}
                          size="small"
                          variant="outlined"
                          sx={{ fontSize: "0.58rem", height: 18, color: "text.secondary" }}
                        />
                      ))}
                    </Stack>
                  )}
                </CardContent>
                <Box sx={{ px: 2, pb: 2, pt: 0.5, display: "flex", gap: 1 }}>
                  {/* Ver/Ler: preview do conteúdo do template — disponível a TODOS (leitura) */}
                  <Button size="small" variant="outlined"
                    sx={{ flex: isMaster ? 1 : "0 0 auto", minWidth: 0 }}
                    startIcon={<MenuBookOutlinedIcon sx={{ fontSize: "0.9rem" }} />}
                    onClick={() => openPreview(it.slug)}>
                    Ver/Ler
                  </Button>
                  {!isMaster && (
                    <Button size="small" variant="contained" sx={{ flex: 1 }}
                      startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <AddCircleOutlineIcon sx={{ fontSize: "0.9rem" }} />}
                      disabled={!!usingSlug} onClick={() => use(it.slug)}>
                      {busy ? "Criando…" : "Usar este modelo"}
                    </Button>
                  )}
                </Box>
              </Card>
            );
          })}
        </Box>
      )}

      {/* Preview "Ver/Ler" — renderiza o template_markdown completo (read-only). */}
      <Dialog open={!!previewSlug} onClose={() => setPreviewSlug(null)} maxWidth="md" fullWidth
        scroll="paper" PaperProps={{ sx: { maxHeight: "88vh" } }}>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 6 }}>
          <MenuBookOutlinedIcon color="primary" />
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} noWrap>
              {previewData?.title ?? "Carregando modelo…"}
            </Typography>
            {previewData && (
              <Typography variant="caption" color="text.secondary">
                {previewData.category} · modelo do catálogo (somente leitura)
              </Typography>
            )}
          </Box>
          <IconButton onClick={() => setPreviewSlug(null)} size="small"
            sx={{ position: "absolute", right: 8, top: 8 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {previewLoading || !previewData ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}><CircularProgress size={26} /></Box>
          ) : (
            <Box
              sx={{
                fontSize: 14,
                lineHeight: 1.65,
                "& h1": { fontSize: "1.3rem", fontWeight: 700, mt: 2, mb: 1 },
                "& h2": { fontSize: "1.12rem", fontWeight: 700, mt: 2, mb: 1 },
                "& h3": { fontSize: "1rem", fontWeight: 700, mt: 1.5, mb: 0.75 },
                "& p": { my: 1 },
                "& ul, & ol": { pl: 3, my: 1 },
                "& li": { mb: 0.5 },
                "& code": { bgcolor: "action.hover", px: 0.5, borderRadius: 0.5, fontSize: "0.85em" },
                "& pre": { bgcolor: "action.hover", p: 1.5, borderRadius: 1, overflowX: "auto" },
                "& pre code": { bgcolor: "transparent", p: 0 },
                "& table": { borderCollapse: "collapse", width: "100%", my: 1 },
                "& th, & td": { border: "1px solid", borderColor: "divider", px: 1, py: 0.5, textAlign: "left" },
                "& blockquote": { borderLeft: "3px solid", borderColor: "divider", pl: 1.5, ml: 0, color: "text.secondary" },
              }}
            >
              <CatalogMarkdown>{previewData.template_markdown ?? ""}</CatalogMarkdown>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button onClick={() => setPreviewSlug(null)}>Fechar</Button>
          {!isMaster && previewData && (
            <Button variant="contained"
              startIcon={<AddCircleOutlineIcon sx={{ fontSize: "0.9rem" }} />}
              disabled={!!usingSlug}
              onClick={() => { const s = previewData.slug; setPreviewSlug(null); use(s); }}>
              Usar este modelo
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default observer(SpecsPageInner);
