"use client";

// Tela "SPECs" (Feature #64 + Feature #65 parte 1).
// - Aba "Minhas SPECs": lista as SPECs (rascunhos) do tenant. Uma SPEC é apenas uma IDEIA;
//   pode ser promovida a projeto solo (POST /api/projects/:id/run) ou vinculada a um produto
//   (PATCH /api/projects/:id/product). Editar leva à tela de edição de spec existente.
// - Aba "Catálogo": SPECs pré-prontas categorizadas (GET /api/catalog); "Usar" cria uma SPEC
//   a partir do template (POST /api/catalog/:slug/use) e abre a edição.

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
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
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import LinkIcon from "@mui/icons-material/Link";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import SearchIcon from "@mui/icons-material/Search";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import { apiGet, apiPatch, apiPost, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { authStore } from "@/stores/authStore";

interface SpecItem {
  id: string;
  title: string;
  status: string;
  product_id: string | null;
  product_name: string | null;
  version_number?: number | null;
  extra?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
interface CatalogItem {
  slug: string;
  title: string;
  category: string;
  description: string;
  tags: string[];
}
interface ProductOption { id: string; name: string }

function formatDate(s: string): string {
  try { return new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return s; }
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

function SpecsPageInner() {
  const router = useRouter();
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <LightbulbOutlinedIcon sx={{ color: "#0EA5E9" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>SPECs</Typography>
          <Typography variant="body2" color="text.secondary">
            Uma SPEC é uma ideia. Guarde, refine e promova a projeto quando quiser — ou comece a partir do catálogo.
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<SpecItem | null>(null);
  const [linkProductId, setLinkProductId] = useState("");

  // Master: escopa a listagem pelo tenant selecionado no topo (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;
  // Conta de gestão (zentriz_admin) só VISUALIZA specs do tenant — sem CTAs de escrita
  // (o backend também bloqueia a autoria via 403 — managementGuard.ts).
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
    apiGet<ProductOption[]>("/api/products").then(setProducts).catch(() => {});
  }, [load]);

  const promote = async (id: string) => {
    setBusyId(id);
    try {
      await apiPost(`/api/projects/${id}/run`, {});
      router.push(`/projects/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao promover a projeto");
      setBusyId(null);
    }
  };

  const confirmLink = async () => {
    if (!linkTarget) return;
    setBusyId(linkTarget.id);
    try {
      await apiPatch(`/api/projects/${linkTarget.id}/product`, { productId: linkProductId || null });
      setLinkTarget(null); setLinkProductId("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao vincular a produto");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}><CircularProgress size={28} /></Box>;
  }

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {specs.length === 0 ? (
        <Box sx={{ textAlign: "center", py: 6 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {isMaster
              ? "Este tenant ainda não possui SPECs."
              : "Nenhuma SPEC ainda. Crie uma ideia do zero ou parta de um template do catálogo."}
          </Typography>
          {!isMaster && (
            <Button variant="contained" startIcon={<AddCircleOutlineIcon />} onClick={() => router.push("/spec")}>
              Nova SPEC
            </Button>
          )}
        </Box>
      ) : (
        <Stack spacing={1.5}>
          {specs.map((s) => {
            const busy = busyId === s.id;
            return (
              <Card key={s.id} variant="outlined" sx={{ p: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, p: 2, flexWrap: "wrap" }}>
                  <Box sx={{ flexGrow: 1, minWidth: 220 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle2" fontWeight={600}>{s.title}</Typography>
                      <Chip label={specStatusLabel(s.status)} size="small" color="default" sx={{ fontSize: "0.62rem", height: 18 }} />
                      {s.product_name && (
                        <Chip label={s.product_name} size="small" color="info" variant="outlined"
                          sx={{ fontSize: "0.62rem", height: 18 }} />
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Atualizada em {formatDate(s.updated_at)}
                    </Typography>
                  </Box>
                  {!isMaster && (
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="outlined" startIcon={<EditIcon sx={{ fontSize: "0.9rem" }} />}
                        disabled={busy} onClick={() => router.push(`/spec?editProjectId=${s.id}`)}>
                        Editar
                      </Button>
                      <Button size="small" variant="outlined" startIcon={<LinkIcon sx={{ fontSize: "0.9rem" }} />}
                        disabled={busy} onClick={() => { setLinkTarget(s); setLinkProductId(s.product_id ?? ""); }}>
                        Vincular a produto
                      </Button>
                      <Button size="small" variant="contained" color="success"
                        startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon sx={{ fontSize: "0.9rem" }} />}
                        disabled={busy} onClick={() => promote(s.id)}>
                        Promover a projeto
                      </Button>
                    </Stack>
                  )}
                </Box>
              </Card>
            );
          })}
        </Stack>
      )}

      {/* Dialog: vincular a produto */}
      <Dialog open={!!linkTarget} onClose={() => setLinkTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem" }}>Vincular SPEC a um produto</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>
            Um produto agrupa projetos relacionados. Deixe em branco para manter a SPEC standalone.
          </Typography>
          <FormControl fullWidth size="small">
            <InputLabel>Produto</InputLabel>
            <Select value={linkProductId} label="Produto" onChange={(e) => setLinkProductId(e.target.value)}>
              <MenuItem value=""><em>Nenhum / standalone</em></MenuItem>
              {products.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLinkTarget(null)}>Cancelar</Button>
          <Button variant="contained" onClick={confirmLink} disabled={busyId === linkTarget?.id}>Salvar</Button>
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
                {!isMaster && (
                  <Box sx={{ px: 2, pb: 2, pt: 0.5 }}>
                    <Button size="small" variant="contained" fullWidth
                      startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <AddCircleOutlineIcon sx={{ fontSize: "0.9rem" }} />}
                      disabled={!!usingSlug} onClick={() => use(it.slug)}>
                      {busy ? "Criando…" : "Usar este modelo"}
                    </Button>
                  </Box>
                )}
              </Card>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export default observer(SpecsPageInner);
