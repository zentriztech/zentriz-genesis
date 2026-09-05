"use client";

// "Meus produtos" (RFC-0003 F3). Um PRODUTO agrupa projetos relacionados. Aqui só
// aparecem produtos ativos (GET /api/products) — os projetos-rascunho e o desenho ficam
// na Bancada (/specs). Clicar num produto abre /products/:id/projects (drilldown). O
// lifecycle_status distingue produto ainda na Bancada (draft) de já em fábrica (running).
// Promover produto inteiro é OPERAÇÃO → o master (zentriz_admin) também pode (C6).
//
// Excluir: com confirmação por reescrita do ID. Sem projetos → apaga de verdade. Com
// projetos → arquiva (oculta do portal), preservando tudo no banco (apagar é arriscado).

import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { apiGet, apiPost, apiDeleteJson, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";
import { authStore } from "@/stores/authStore";
import { ProductCertificateChip, type ProductFactoryCertificate } from "@/components/FactoryCertificate";

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lifecycle_status: string | null;
  created_at: string;
  project_count: number;
  /** §4.15: true = INBOX "Rascunhos" (a API já o oculta aqui por padrão; defesa extra client-side). */
  is_inbox?: boolean;
  /** §4.15: true = produto homônimo de um App solo (auto-criado ao promover do inbox ou na migração 064). */
  solo_app?: boolean;
  /** Certificado Genesis Factory agregado (AND dos projetos na Bancada). Ausente com a flag off. */
  factoryCertificate?: ProductFactoryCertificate | null;
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

  // Estado do diálogo de exclusão.
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [ack, setAck] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Master escopa por tenant selecionado no topo (null = todos).
  const scopeTenantId = tenantScopeStore.selectedTenantId;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiGet<ProductRow[]>(withQuery("/api/products", { tenantId: scopeTenantId }));
      // A API já exclui o INBOX aqui (sem ?includeInbox), mas filtramos por garantia (§5.9).
      setProducts(Array.isArray(data) ? data.filter((p) => p.is_inbox !== true) : []);
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

  const copyId = async (id: string) => {
    try { await navigator.clipboard.writeText(id); setNotice("ID copiado para a área de transferência."); }
    catch { setError("Não foi possível copiar automaticamente — selecione e copie manualmente."); }
  };

  const openDelete = (p: ProductRow) => {
    setDeleteTarget(p);
    setConfirmText("");
    setAck(false);
    setError(null);
  };
  const closeDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setConfirmText("");
    setAck(false);
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiDeleteJson<{ mode: string; message?: string }>(`/api/products/${deleteTarget.id}`, {
        confirmId: confirmText.trim(),
        acknowledge: ack,
      });
      setNotice(res.message ?? "Produto excluído.");
      setDeleteTarget(null);
      setConfirmText("");
      setAck(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao excluir o produto");
    } finally {
      setDeleting(false);
    }
  };

  const hasProjects = (deleteTarget?.project_count ?? 0) > 0;
  const idMatches = !!deleteTarget && confirmText.trim() === deleteTarget.id;
  const canDelete = idMatches && (!hasProjects || ack);

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
            // Homônimos (mesmo name no tenant) recebem sufixo curto client-side p/ desambiguar —
            // sem mexer no name do banco (§5.9).
            const nameClash = products.filter((o) => o.name === p.name).length > 1;
            const displayName = nameClash ? `${p.name} ·${p.id.slice(0, 8)}` : p.name;
            return (
              <Card key={p.id} variant="outlined" sx={{ display: "flex", flexDirection: "column" }}>
                <CardActionArea onClick={() => router.push(`/products/${p.id}/projects`)} sx={{ flexGrow: 1 }}>
                  <CardContent>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 0.25 }}>
                      <Typography variant="subtitle1" fontWeight={700} sx={{ lineHeight: 1.3, minWidth: 0, flexGrow: 1 }}>{displayName}</Typography>
                      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0 }}>
                        {p.solo_app && (
                          <Tooltip title="Produto criado automaticamente para um App que roda sozinho (ao promover do inbox ou na migração 064).">
                            <Chip label="App solo (auto-criado)" size="small" variant="outlined" color="secondary" sx={{ fontSize: "0.62rem", height: 20 }} />
                          </Tooltip>
                        )}
                        <Chip label={lc.label} size="small" color={lc.color} sx={{ fontSize: "0.62rem", height: 20 }} />
                        {/* Excluir — só o ícone, canto superior direito, na mesma linha do título. */}
                        <Tooltip title="Excluir produto">
                          <IconButton
                            size="small" color="error" aria-label="Excluir produto"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDelete(p); }}
                            sx={{ p: 0.25 }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: "1rem" }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </Stack>
                    {/* ID do produto (letra pequena) — copiável para colar na confirmação de exclusão. */}
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1 }}>
                      <Typography variant="caption" color="text.secondary" fontFamily="monospace" sx={{ fontSize: "0.65rem", wordBreak: "break-all" }}>
                        {p.id}
                      </Typography>
                      <Tooltip title="Copiar ID">
                        <IconButton
                          size="small"
                          aria-label="Copiar ID do produto"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void copyId(p.id); }}
                          sx={{ p: 0.25 }}
                        >
                          <ContentCopyIcon sx={{ fontSize: "0.8rem" }} />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    {p.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, lineHeight: 1.5 }}>
                        {p.description}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Chip
                        label={`${p.project_count} projeto${p.project_count !== 1 ? "s" : ""}`}
                        size="small" variant="outlined" sx={{ fontSize: "0.62rem", height: 20 }}
                      />
                      {/* A6: agregado em AND, sempre com n/m explícito (nunca porcentagem). */}
                      {p.factoryCertificate && p.factoryCertificate.total > 0 && (
                        <ProductCertificateChip certificate={p.factoryCertificate} />
                      )}
                    </Stack>
                  </CardContent>
                </CardActionArea>
                {/* Promover produto inteiro — só quando ainda na Bancada (draft). Operação: master OK.
                    Excluir virou ícone no topo do card (canto superior direito, junto ao título). */}
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

      {/* Diálogo de exclusão — reescrever o ID + (se houver projetos) marcar a caixa. */}
      <Dialog open={!!deleteTarget} onClose={closeDelete} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <DeleteOutlineIcon color="error" /> Excluir produto
        </DialogTitle>
        <DialogContent>
          {deleteTarget && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Alert severity={hasProjects ? "warning" : "error"}>
                {hasProjects
                  ? `Este produto tem ${deleteTarget.project_count} projeto(s). Por segurança ele NÃO será apagado — apenas ocultado do portal (arquivado). Os projetos e o histórico permanecem no banco e a ação é reversível.`
                  : "Este produto não tem projetos e será REMOVIDO definitivamente do banco. Esta ação não pode ser desfeita."}
              </Alert>

              <Box>
                <Typography variant="caption" color="text.secondary">Produto</Typography>
                <Typography variant="body2" fontWeight={700}>{deleteTarget.name}</Typography>
              </Box>

              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  ID (copie e cole abaixo para confirmar)
                </Typography>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="caption" fontFamily="monospace" sx={{ wordBreak: "break-all" }}>
                    {deleteTarget.id}
                  </Typography>
                  <Tooltip title="Copiar ID">
                    <IconButton size="small" aria-label="Copiar ID" onClick={() => void copyId(deleteTarget.id)} sx={{ p: 0.25 }}>
                      <ContentCopyIcon sx={{ fontSize: "0.9rem" }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Box>

              <TextField
                label="Reescreva o ID para confirmar"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                fullWidth size="small" autoComplete="off"
                error={confirmText.trim().length > 0 && !idMatches}
                helperText={confirmText.trim().length > 0 && !idMatches ? "O ID não confere." : " "}
                inputProps={{ style: { fontFamily: "monospace", fontSize: "0.78rem" } }}
              />

              {hasProjects && (
                <FormControlLabel
                  control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} color="warning" />}
                  label={
                    <Typography variant="body2">
                      Entendo o que estou fazendo: o produto será arquivado (oculto no portal), com os projetos preservados.
                    </Typography>
                  }
                />
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDelete} disabled={deleting}>Cancelar</Button>
          <Button
            color="error" variant="contained"
            startIcon={deleting ? <CircularProgress size={14} color="inherit" /> : <DeleteOutlineIcon />}
            disabled={deleting || !canDelete}
            onClick={doDelete}
          >
            {hasProjects ? "Arquivar" : "Excluir definitivamente"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default observer(ProductsPageInner);
