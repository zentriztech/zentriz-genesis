"use client";

// "Meus produtos" (RFC-0003 F3). Um PRODUTO agrupa projetos relacionados. Aqui só
// aparecem produtos ativos (GET /api/products) — os projetos-rascunho e o desenho ficam
// na Bancada (/specs). Clicar num produto abre /products/:id/projects (drilldown). O
// lifecycle_status distingue produto ainda na Bancada (draft) de já em fábrica (running).
// Promover produto inteiro é OPERAÇÃO → o master (zentriz_admin) também pode (C6).

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import { apiGet, apiPost, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { authStore } from "@/stores/authStore";

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lifecycle_status: string | null;
  created_at: string;
  project_count: number;
}

// Rótulo + cor do ciclo de vida do produto (Bancada vs fábrica vs terminal).
function lifecycleChip(ls: string | null): { label: string; color: "default" | "info" | "success" | "warning" } {
  switch (ls) {
    case "draft": return { label: "Na Bancada", color: "warning" };
    case "running": return { label: "Em fábrica", color: "info" };
    case "completed":
    case "accepted": return { label: "Concluído", color: "success" };
    default: return { label: ls ?? "—", color: "default" };
  }
}

function ProductsPageInner() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Master escopa por tenant selecionado no topo (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiGet<ProductRow[]>(withQuery("/api/products", { tenantId: scopeTenantId }));
      setProducts(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar produtos");
    } finally {
      setLoading(false);
    }
  }, [scopeTenantId]);

  useEffect(() => { load(); }, [load]);

  // Promover produto inteiro à fábrica (dispara as raízes; ondas seguintes em cascata).
  const promote = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiPost<{ promoted?: string[] }>(`/api/products/${id}/promote`, {});
      setNotice(`Produto promovido — ${res.promoted?.length ?? 0} raiz(es) em execução.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao promover o produto");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <Inventory2OutlinedIcon sx={{ color: "#8B5CF6" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Meus produtos</Typography>
          <Typography variant="body2" color="text.secondary">
            Um produto agrupa projetos relacionados. Abra um produto para ver seus projetos e o grafo de execução.
          </Typography>
        </Box>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <LinearProgress sx={{ borderRadius: 1 }} />
      ) : products.length === 0 ? (
        <Card sx={{ textAlign: "center", py: 6 }}>
          <CardContent>
            <Typography variant="body2" color="text.secondary">
              {authStore.isZentrizAdmin
                ? "Este tenant ainda não possui produtos."
                : "Nenhum produto ainda. Decomponha uma spec ou ideia na Bancada para criar um produto."}
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "1fr 1fr 1fr" }, gap: 2 }}>
          {products.map((p) => {
            const lc = lifecycleChip(p.lifecycle_status);
            const busy = busyId === p.id;
            return (
              <Card key={p.id} variant="outlined" sx={{ display: "flex", flexDirection: "column" }}>
                <CardActionArea onClick={() => router.push(`/products/${p.id}/projects`)} sx={{ flexGrow: 1 }}>
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
                      <Typography variant="subtitle1" fontWeight={700} sx={{ lineHeight: 1.3 }}>{p.name}</Typography>
                      <Chip label={lc.label} size="small" color={lc.color} sx={{ fontSize: "0.62rem", height: 20, flexShrink: 0 }} />
                    </Stack>
                    {p.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, lineHeight: 1.5 }}>
                        {p.description}
                      </Typography>
                    )}
                    <Chip
                      label={`${p.project_count} projeto${p.project_count !== 1 ? "s" : ""}`}
                      size="small" variant="outlined" sx={{ fontSize: "0.62rem", height: 20 }}
                    />
                  </CardContent>
                </CardActionArea>
                {/* Promover produto inteiro — só quando ainda na Bancada (draft). Operação: master OK. */}
                {p.lifecycle_status === "draft" && (
                  <Box sx={{ px: 2, pb: 2, pt: 0 }}>
                    <Button
                      size="small" fullWidth variant="contained" color="success"
                      startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <RocketLaunchIcon sx={{ fontSize: "0.9rem" }} />}
                      disabled={busy}
                      onClick={() => promote(p.id)}
                    >
                      Promover à fábrica
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

export default observer(ProductsPageInner);
