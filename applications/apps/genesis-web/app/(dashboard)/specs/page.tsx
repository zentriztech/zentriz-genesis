"use client";

// Tela "SPECs" (Feature #64 + Feature #65 parte 1).
// - Aba "Minhas SPECs": lista as SPECs (rascunhos) do tenant. Uma SPEC é apenas uma IDEIA;
//   pode ser promovida a projeto solo (POST /api/projects/:id/run) ou vinculada a um produto
//   (PATCH /api/projects/:id/product). Editar leva à tela de edição de spec existente.
// - Aba "Catálogo": SPECs pré-prontas categorizadas (GET /api/catalog); "Usar" cria uma SPEC
//   a partir do template (POST /api/catalog/:slug/use) e abre a edição.

import { useCallback, useEffect, useState } from "react";
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
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import LinkIcon from "@mui/icons-material/Link";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

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

export default function SpecsPage() {
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
function MySpecs({ router }: { router: ReturnType<typeof useRouter> }) {
  const [specs, setSpecs] = useState<SpecItem[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<SpecItem | null>(null);
  const [linkProductId, setLinkProductId] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiGet<SpecItem[]>("/api/specs");
      setSpecs(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar SPECs");
    } finally {
      setLoading(false);
    }
  }, []);

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
            Nenhuma SPEC ainda. Crie uma ideia do zero ou parta de um template do catálogo.
          </Typography>
          <Button variant="contained" startIcon={<AddCircleOutlineIcon />} onClick={() => router.push("/spec")}>
            Nova SPEC
          </Button>
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
}

// ── Aba: Catálogo ───────────────────────────────────────────────────────────
function Catalog({ router }: { router: ReturnType<typeof useRouter> }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("");
  const [usingSlug, setUsingSlug] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<CatalogItem[]>("/api/catalog")
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar catálogo"))
      .finally(() => setLoading(false));
  }, []);

  const categories = Array.from(new Set(items.map((i) => i.category))).sort();
  const filtered = category ? items.filter((i) => i.category === category) : items;

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
        Modelos prontos para começar rápido. Ao usar, uma SPEC editável é criada a partir do template.
      </Typography>

      {/* Filtros por categoria */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}>
        <Chip label="Todas" size="small" color={category === "" ? "primary" : "default"}
          onClick={() => setCategory("")} />
        {categories.map((c) => (
          <Chip key={c} label={c} size="small" color={category === c ? "primary" : "default"}
            onClick={() => setCategory(c)} />
        ))}
      </Stack>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "1fr 1fr 1fr" }, gap: 1.5 }}>
        {filtered.map((it) => (
          <Card key={it.slug} variant="outlined" sx={{ display: "flex", flexDirection: "column" }}>
            <CardContent sx={{ flexGrow: 1 }}>
              <Chip label={it.category} size="small" sx={{ fontSize: "0.6rem", height: 18, mb: 1 }} />
              <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 0.5 }}>{it.title}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.5 }}>
                {it.description}
              </Typography>
            </CardContent>
            <Box sx={{ px: 2, pb: 2 }}>
              <Button size="small" variant="contained" fullWidth
                startIcon={usingSlug === it.slug ? <CircularProgress size={14} color="inherit" /> : <AddCircleOutlineIcon sx={{ fontSize: "0.9rem" }} />}
                disabled={!!usingSlug} onClick={() => use(it.slug)}>
                {usingSlug === it.slug ? "Criando…" : "Usar este modelo"}
              </Button>
            </Box>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
