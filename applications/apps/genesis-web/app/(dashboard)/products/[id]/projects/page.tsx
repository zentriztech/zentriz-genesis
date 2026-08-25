"use client";

// Detalhe de um produto → seus projetos (RFC-0003 F3 / drilldown U#6).
// GET /api/products/:id devolve o produto + seus projetos em ordem topológica
// (execution_order = profundidade no grafo de dependências). Cada projeto linka para
// /projects/:id. Se o produto ainda está na Bancada (lifecycle draft), oferece promover.

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import { apiGet, apiPost } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

interface ProductProject {
  id: string;
  title: string | null;
  status: string;
  version_number: number | null;
  project_type: string | null;
  complexity_hint: string | null;
  execution_order: number;
  repo_url: string | null;
  deploy_url: string | null;
  deploy_status: string | null;
}
interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  lifecycle_status: string | null;
  projects: ProductProject[];
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho", spec_submitted: "Spec enviada", pending_conversion: "Convertendo",
  cto_charter: "Charter CTO", pm_backlog: "Backlog PM", dev_qa: "Dev/QA",
  devops: "DevOps", running: "Em execução", stopped: "Parado",
  completed: "Concluído", failed: "Falhou", accepted: "Aceito",
  pending_cyborg: "Validando (Cyborg)", blocked_cyborg: "Bloqueado (Cyborg)",
};
function statusColor(s: string): "default" | "success" | "error" | "info" | "warning" {
  if (s === "completed" || s === "accepted") return "success";
  if (s === "failed" || s === "stopped" || s === "blocked_cyborg") return "error";
  if (s === "running") return "info";
  if (["spec_submitted", "cto_charter", "pm_backlog", "dev_qa", "devops", "pending_cyborg"].includes(s)) return "warning";
  return "default";
}
function lifecycleLabel(ls: string | null): { label: string; color: "default" | "info" | "success" | "warning" } {
  switch (ls) {
    case "draft": return { label: "Na Bancada", color: "warning" };
    case "running": return { label: "Em fábrica", color: "info" };
    case "completed":
    case "accepted": return { label: "Concluído", color: "success" };
    default: return { label: ls ?? "—", color: "default" };
  }
}

// RFC-0003 E5 — classificação de fase para o rollup do portfólio.
const PRE_FACTORY_STATUSES = new Set(["draft", "spec_submitted", "pending_conversion"]);
const DONE_STATUSES = new Set(["completed", "accepted"]);
function isDone(s: string): boolean { return DONE_STATUSES.has(s); }
function isPreFactory(s: string): boolean { return PRE_FACTORY_STATUSES.has(s); }

function ProductProjectsInner() {
  const router = useRouter();
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id as string | undefined);

  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);

  // Master pode trocar de tenant no topo; se o produto sair de escopo, recarrega (→ 404 tratado).
  const scopeTenantId = tenantScopeStore.selectedTenantId;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true); setError(null);
    try {
      const data = await apiGet<ProductDetail>(`/api/products/${id}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Produto não encontrado");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load, scopeTenantId]);

  const promote = async () => {
    if (!id) return;
    setPromoting(true);
    try {
      const res = await apiPost<{ promoted?: string[] }>(`/api/products/${id}/promote`, {});
      setNotice(`Produto promovido — ${res.promoted?.length ?? 0} raiz(es) em execução.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao promover o produto");
    } finally {
      setPromoting(false);
    }
  };

  const projects = detail?.projects ?? [];
  const lc = lifecycleLabel(detail?.lifecycle_status ?? null);

  // E5 · roadmap por ondas — agrupa os projetos por execution_order (profundidade no grafo
  // de dependências). A onda 0 são as raízes; ondas seguintes só disparam quando a anterior
  // conclui. Cada onda mostra seu próprio progresso (concluídos / total).
  const waves = useMemo(() => {
    const map = new Map<number, ProductProject[]>();
    for (const p of projects) {
      const w = p.execution_order ?? 0;
      const arr = map.get(w);
      if (arr) arr.push(p); else map.set(w, [p]);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([order, ps]) => ({ order, ps, done: ps.filter((p) => isDone(p.status)).length }));
  }, [projects]);

  // Rollup do portfólio: quantos já concluídos, em fábrica e ainda na Bancada.
  const summary = useMemo(() => {
    const total = projects.length;
    const done = projects.filter((p) => isDone(p.status)).length;
    const bancada = projects.filter((p) => isPreFactory(p.status)).length;
    const factory = total - done - bancada;
    return { total, done, bancada, factory, pct: total ? Math.round((done / total) * 100) : 0 };
  }, [projects]);

  const renderProjectRow = (p: ProductProject) => (
    <Box
      key={p.id}
      onClick={() => router.push(`/projects/${p.id}`)}
      sx={{
        display: "flex", alignItems: "center", gap: 2, px: 2, py: 1.5,
        borderBottom: "1px solid", borderColor: "divider", cursor: "pointer",
        transition: "background 0.15s", "&:hover": { bgcolor: "action.hover" },
        "&:last-child": { borderBottom: "none" },
      }}
    >
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} noWrap>
          {p.title ?? "Sem título"}
          {(p.version_number ?? 1) > 1 ? ` · v${p.version_number}` : ""}
        </Typography>
        {p.project_type && (
          <Typography variant="caption" color="text.secondary">{p.project_type.replace(/_/g, " ")}</Typography>
        )}
      </Box>
      <Chip label={STATUS_LABELS[p.status] ?? p.status} size="small" color={statusColor(p.status)} sx={{ flexShrink: 0 }} />
      <IconButton size="small" onClick={(e) => { e.stopPropagation(); router.push(`/projects/${p.id}`); }}>
        <ArrowForwardIcon fontSize="small" />
      </IconButton>
    </Box>
  );

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3, flexWrap: "wrap", gap: 1 }}>
        <IconButton size="small" onClick={() => router.push("/products")}><ArrowBackIcon fontSize="small" /></IconButton>
        <Inventory2OutlinedIcon sx={{ color: "#8B5CF6" }} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Typography variant="h5" fontWeight={700}>{detail?.name ?? "Produto"}</Typography>
            {detail && <Chip label={lc.label} size="small" color={lc.color} sx={{ fontSize: "0.62rem", height: 20 }} />}
          </Stack>
          {detail?.description && (
            <Typography variant="body2" color="text.secondary">{detail.description}</Typography>
          )}
        </Box>
        {detail?.lifecycle_status === "draft" && projects.length > 0 && (
          <Button
            variant="contained" color="success"
            startIcon={promoting ? <CircularProgress size={16} color="inherit" /> : <RocketLaunchIcon />}
            disabled={promoting}
            onClick={promote}
          >
            Promover à fábrica
          </Button>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <LinearProgress sx={{ borderRadius: 1 }} />
      ) : !detail ? null : projects.length === 0 ? (
        <Card sx={{ textAlign: "center", py: 6 }}>
          <Typography variant="body2" color="text.secondary">Este produto ainda não tem projetos.</Typography>
        </Card>
      ) : (
        <Stack spacing={2}>
          {/* E5 · rollup do portfólio — progresso + composição por fase. */}
          <Card sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle2" fontWeight={700}>Progresso do produto</Typography>
              <Typography variant="h6" fontWeight={800} color="success.main">{summary.pct}%</Typography>
            </Stack>
            <LinearProgress variant="determinate" value={summary.pct} color="success"
              sx={{ height: 8, borderRadius: 4, mb: 1.5 }} />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip label={`${summary.total} projeto(s)`} size="small" variant="outlined" />
              <Chip label={`${summary.done} concluído(s)`} size="small" color="success" variant={summary.done ? "filled" : "outlined"} />
              <Chip label={`${summary.factory} em fábrica`} size="small" color="info" variant={summary.factory ? "filled" : "outlined"} />
              <Chip label={`${summary.bancada} na Bancada`} size="small" color="warning" variant={summary.bancada ? "filled" : "outlined"} />
              <Chip label={`${waves.length} onda(s)`} size="small" variant="outlined" />
            </Stack>
          </Card>

          {/* Roadmap por ondas de execução. */}
          {waves.map((w) => (
            <Box key={w.order}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: "wrap", gap: 1 }}>
                <Chip label={w.order === 0 ? "Onda 0 · raízes" : `Onda ${w.order}`} size="small"
                  color={w.order === 0 ? "primary" : "default"} variant={w.order === 0 ? "filled" : "outlined"}
                  sx={{ height: 22, fontSize: "0.64rem", fontWeight: 700 }} />
                <Typography variant="caption" color="text.secondary">
                  {w.done}/{w.ps.length} concluído(s)
                  {w.order > 0 && " · dispara quando a onda anterior conclui"}
                </Typography>
              </Stack>
              <Card>
                {w.ps.map(renderProjectRow)}
              </Card>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default observer(ProductProjectsInner);
