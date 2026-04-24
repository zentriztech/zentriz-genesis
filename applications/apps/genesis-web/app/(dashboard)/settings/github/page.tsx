"use client";

import { useEffect, useState } from "react";
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
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import GitHubIcon from "@mui/icons-material/GitHub";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

type InstallationStatus =
  | { connected: false }
  | {
      connected: true;
      installationId: number;
      githubLogin: string;
      installationType: string;
      reposAuthorized: "all" | "selected";
      selectedRepos: string[];
      scopeGenesis: boolean;
      scopeDeadpool: boolean;
      installedAt: string;
      revokedAt: string | null;
    };

function ConnectDialog({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => void }) {
  const [installationId, setInstallationId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    const id = parseInt(installationId, 10);
    if (!id || isNaN(id)) {
      setError("Installation ID deve ser um número inteiro.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/github/installation", { installationId: id });
      onConnected();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao conectar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Conectar GitHub App</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2 }}>
        <Alert severity="info">
          Instale a GitHub App da Zentriz no seu org ou conta e cole aqui o Installation ID fornecido pelo GitHub.
        </Alert>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Installation ID"
          type="number"
          value={installationId}
          onChange={(e) => setInstallationId(e.target.value)}
          placeholder="Ex: 12345678"
          fullWidth
        />
        <Typography variant="caption" color="text.secondary">
          O Installation ID aparece na URL ao instalar a app: github.com/apps/zentriz/installations/<strong>ID</strong>
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={handleConnect} variant="contained" disabled={saving} startIcon={<GitHubIcon />}>
          {saving ? <CircularProgress size={18} /> : "Conectar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const GitHubSettingsPage = observer(function GitHubSettingsPage() {
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<InstallationStatus>("/api/github/installation");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleRevoke() {
    setRevoking(true);
    setError(null);
    try {
      await apiDelete("/api/github/installation");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao revogar acesso");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Integração GitHub
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Conecte sua conta GitHub para que Genesis e Deadpool possam criar repositórios,
        fazer commits e abrir Pull Requests no seu org.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : status?.connected ? (
        <Card variant="outlined">
          <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CheckCircleIcon color="success" />
              <Typography variant="h6">Conectado</Typography>
            </Box>

            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              <Chip icon={<GitHubIcon />} label={status.githubLogin} variant="outlined" />
              <Chip label={status.installationType} size="small" />
              <Chip
                label={status.reposAuthorized === "all" ? "Todos os repos" : `${status.selectedRepos.length} repos selecionados`}
                size="small"
                color={status.reposAuthorized === "all" ? "warning" : "default"}
              />
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary" display="block">Escopos autorizados</Typography>
              <Box sx={{ display: "flex", gap: 1, mt: 0.5 }}>
                <Chip label="Genesis" color={status.scopeGenesis ? "success" : "default"} size="small" />
                <Chip label="Deadpool" color={status.scopeDeadpool ? "success" : "default"} size="small" />
              </Box>
            </Box>

            <Typography variant="caption" color="text.secondary">
              Instalação: {new Date(status.installedAt).toLocaleString("pt-BR")}
            </Typography>

            <Button
              variant="outlined"
              color="error"
              startIcon={revoking ? <CircularProgress size={16} /> : <LinkOffIcon />}
              onClick={handleRevoke}
              disabled={revoking}
              sx={{ alignSelf: "flex-start" }}
            >
              Revogar acesso
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card variant="outlined" sx={{ p: 3, textAlign: "center" }}>
          <GitHubIcon sx={{ fontSize: 48, color: "text.secondary", mb: 2 }} />
          <Typography variant="h6" gutterBottom>GitHub não conectado</Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Conecte sua conta para habilitar criação automática de repositórios e commits.
          </Typography>
          <Button
            variant="contained"
            startIcon={<GitHubIcon />}
            onClick={() => setShowConnect(true)}
          >
            Conectar GitHub App
          </Button>
        </Card>
      )}

      <ConnectDialog
        open={showConnect}
        onClose={() => setShowConnect(false)}
        onConnected={loadStatus}
      />
    </Box>
  );
});

export default GitHubSettingsPage;
