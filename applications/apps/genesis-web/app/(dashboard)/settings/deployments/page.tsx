"use client";

import { useEffect, useState, useCallback } from "react";
import { observer } from "mobx-react-lite";
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
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import { apiGet, apiDelete, withQuery } from "@/lib/api";
import { authStore } from "@/stores/authStore";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

interface Deployment {
  kind:            "ephemeral" | "backend";
  id:              string;
  projectId:       string;
  projectTitle:    string | null;
  tenantId:        string | null;
  status:          string;
  appUrl:          string | null;
  healthUrl:       string | null;
  bucketName:      string | null;
  provider:        string;
  runtimeTarget:   string | null;
  deploymentClass: string | null;
  logGroup:        string | null;
  createdAt:       string | null;
  expiresAt:       string | null;
  errorMsg:        string | null;
}

const STATUS_COLORS: Record<string, string> = {
  running:          "#10B981",
  running_degraded: "#F59E0B",
  provisioning:     "#3B82F6",
  building:         "#3B82F6",
  pushing:          "#3B82F6",
  migrating:        "#3B82F6",
  creating_service: "#3B82F6",
  waiting_cert_dns: "#3B82F6",
  failed:           "#EF4444",
  destroying:       "#F59E0B",
  destroy_failed:   "#EF4444",
  destroyed:        "#6B7280",
};

// Deploy durável (backend) usa expires_at NULL = sem TTL. Efêmero mostra a contagem regressiva.
function relativeExpiry(d: Deployment): string {
  if (d.kind === "backend") return d.expiresAt ? "" : "sem expiração (durável)";
  if (!d.expiresAt) return "permanente";
  const ms = new Date(d.expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "expirado";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `expira em ${days}d ${hours}h`;
  return `expira em ${hours}h`;
}

export default observer(function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalAlert, setGlobalAlert] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [confirm, setConfirm] = useState<{ dep: Deployment; typed: string; deleting: boolean } | null>(null);

  const isZentrizAdmin = authStore.isZentrizAdmin;
  // Master: com tenant selecionado no topo, filtra os deploys a esse tenant (null = todos).
  const tenantId = tenantScopeStore.effectiveTenantId;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ deployments: Deployment[] }>(withQuery("/api/deployments", { tenantId }));
      setDeployments(data.deployments ?? []);
    } catch {
      setGlobalAlert({ type: "error", msg: "Erro ao carregar deployments." });
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async () => {
    if (!confirm) return;
    setConfirm({ ...confirm, deleting: true });
    try {
      await apiDelete(`/api/deployments/${confirm.dep.id}`);
      setGlobalAlert({ type: "success", msg: `Deploy de "${confirm.dep.projectTitle ?? confirm.dep.projectId}" excluído.` });
      setConfirm(null);
      await load();
    } catch (err) {
      setGlobalAlert({ type: "error", msg: `Falha ao excluir: ${err instanceof Error ? err.message : String(err)}` });
      setConfirm({ ...confirm, deleting: false });
    }
  };

  return (
    <Box sx={{ maxWidth: 960, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap mb={3}>
        <RocketLaunchIcon sx={{ color: "#0EA5E9", fontSize: 28 }} />
        <Typography variant="h5" fontWeight={700}>Deployments</Typography>
        <Chip
          label={isZentrizAdmin ? "Todos os tenants (zentriz_admin)" : "Deploys do seu tenant"}
          size="small"
          sx={{ bgcolor: isZentrizAdmin ? "#0EA5E9" : "#6366F1", color: "#fff" }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Recarregar">
          <IconButton onClick={() => void load()}><RefreshIcon /></IconButton>
        </Tooltip>
      </Stack>

      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>Preview S3</strong>: sites estáticos efêmeros publicados pelo Genesis — expiram por TTL
        e podem ser excluídos aqui para liberar espaço (exclusão irreversível).{" "}
        <strong>Backend durável</strong>: serviços de runtime provisionados/onboarded que o Auto Care
        monitora — mostrados para referência (sem exclusão por esta tela).
      </Alert>

      {globalAlert && (
        <Alert severity={globalAlert.type} sx={{ mb: 2 }} onClose={() => setGlobalAlert(null)}>
          {globalAlert.msg}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress />
        </Box>
      ) : deployments.length === 0 ? (
        <Card variant="outlined"><CardContent>
          <Typography color="text.secondary">Nenhum deploy ativo.</Typography>
        </CardContent></Card>
      ) : (
        <Stack spacing={2}>
          {deployments.map((d) => (
            <Card key={d.id} variant="outlined">
              <CardContent>
                <Stack direction="row" alignItems="flex-start" spacing={2}>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Stack direction="row" alignItems="center" spacing={1} mb={0.5} flexWrap="wrap" useFlexGap>
                      <Typography variant="subtitle1" fontWeight={700} noWrap>
                        {d.projectTitle ?? d.projectId}
                      </Typography>
                      <Chip
                        label={d.kind === "backend" ? "Backend durável" : "Preview S3"}
                        size="small"
                        sx={{
                          bgcolor: d.kind === "backend" ? "#6366F122" : "#0EA5E922",
                          color:   d.kind === "backend" ? "#6366F1" : "#0EA5E9",
                          fontWeight: 600,
                        }}
                      />
                      <Chip
                        label={d.status}
                        size="small"
                        sx={{ bgcolor: (STATUS_COLORS[d.status] ?? "#6B7280") + "22", color: STATUS_COLORS[d.status] ?? "#6B7280", fontWeight: 600 }}
                      />
                    </Stack>
                    {d.appUrl && (
                      <Link href={d.appUrl} target="_blank" rel="noopener" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.85rem", wordBreak: "break-all" }}>
                        {d.appUrl} <OpenInNewIcon sx={{ fontSize: "0.85rem" }} />
                      </Link>
                    )}
                    {d.kind === "backend" && d.healthUrl && (
                      <Link href={d.healthUrl} target="_blank" rel="noopener" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontSize: "0.8rem", wordBreak: "break-all" }}>
                        health: {d.healthUrl} <OpenInNewIcon sx={{ fontSize: "0.8rem" }} />
                      </Link>
                    )}
                    <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                      {[
                        relativeExpiry(d),
                        d.kind === "backend"
                          ? [d.provider, d.runtimeTarget].filter(Boolean).join("/")
                          : null,
                        isZentrizAdmin && d.tenantId ? `tenant ${d.tenantId.slice(0, 8)}` : null,
                        d.projectId,
                      ].filter(Boolean).join(" · ")}
                    </Typography>
                    {d.errorMsg && d.status !== "running" && (
                      <Typography variant="caption" color="error" display="block" mt={0.5} noWrap>
                        {d.errorMsg}
                      </Typography>
                    )}
                  </Box>
                  {d.kind === "ephemeral" ? (
                    <Tooltip title="Excluir deploy">
                      <IconButton
                        color="error"
                        onClick={() => setConfirm({ dep: d, typed: "", deleting: false })}
                      >
                        <DeleteOutlineIcon />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Deploy durável de runtime — gerenciado fora desta tela (não excluível aqui)">
                      <span>
                        <IconButton disabled>
                          <DeleteOutlineIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      {/* Confirmação type-to-confirm: digitar o ID do projeto */}
      <Dialog open={!!confirm} onClose={() => confirm && !confirm.deleting && setConfirm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Excluir deploy</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Isto remove permanentemente o site publicado de{" "}
            <strong>{confirm?.dep.projectTitle ?? confirm?.dep.projectId}</strong>.
            Para confirmar, digite o ID do projeto abaixo:
          </DialogContentText>
          <Typography variant="caption" sx={{ fontFamily: "monospace", bgcolor: "action.hover", px: 1, py: 0.5, borderRadius: 1, display: "block", mb: 1.5 }}>
            {confirm?.dep.projectId}
          </Typography>
          <TextField
            fullWidth
            size="small"
            placeholder="Cole o ID do projeto aqui"
            value={confirm?.typed ?? ""}
            onChange={(e) => confirm && setConfirm({ ...confirm, typed: e.target.value })}
            disabled={confirm?.deleting}
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={confirm?.deleting}>Cancelar</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={!confirm || confirm.typed !== confirm.dep.projectId || confirm.deleting}
            startIcon={confirm?.deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            Excluir permanentemente
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
});
