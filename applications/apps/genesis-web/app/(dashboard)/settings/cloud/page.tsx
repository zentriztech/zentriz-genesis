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
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudIcon from "@mui/icons-material/Cloud";
import DeleteIcon from "@mui/icons-material/Delete";
import VerifiedIcon from "@mui/icons-material/Verified";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

type Provider = "aws" | "azure" | "gcp";

interface CloudConnection {
  id: string; tenantId: string; provider: Provider;
  region: string | null; serviceType: string;
  githubSecretsSyncedAt: string | null; status: string; createdAt: string;
}

// ── Provider labels & colours ─────────────────────────────────────────────────
const PROVIDER_META = {
  aws:   { label: "AWS",         color: "#FF9900", icon: "🟠", hint: "ECS Fargate / ECR" },
  azure: { label: "Azure",       color: "#0078D4", icon: "🔵", hint: "Container Apps / ACR" },
  gcp:   { label: "GCP",         color: "#4285F4", icon: "🔷", hint: "Cloud Run / GCR" },
} as const;

// ── AWS form ──────────────────────────────────────────────────────────────────
function AWSForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ accessKeyId: "", secretAccessKey: "", region: "us-east-1", ecrRegistry: "", ecsCluster: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await apiPost("/api/tenant/cloud-connection", { provider: "aws", credentials: form, region: form.region });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Erro ao salvar"); }
    finally { setSaving(false); }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Crie um IAM User com permissões para ECR + ECS e cole as credenciais abaixo.
        Elas são encriptadas com AES-256 antes de serem armazenadas.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField label="Access Key ID" value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} required size="small" />
      <TextField label="Secret Access Key" type="password" value={form.secretAccessKey} onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} required size="small" />
      <TextField label="Região" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} size="small" helperText="ex: us-east-1, sa-east-1" />
      <TextField label="ECR Registry (opcional)" value={form.ecrRegistry} onChange={(e) => setForm({ ...form, ecrRegistry: e.target.value })} size="small" helperText="ex: 123456789.dkr.ecr.us-east-1.amazonaws.com" />
      <TextField label="ECS Cluster (opcional)" value={form.ecsCluster} onChange={(e) => setForm({ ...form, ecsCluster: e.target.value })} size="small" helperText="ex: zentriz-production" />
      <Button variant="contained" onClick={save} disabled={saving || !form.accessKeyId || !form.secretAccessKey}>
        {saving ? <CircularProgress size={18} /> : "Salvar credenciais AWS"}
      </Button>
    </Stack>
  );
}

// ── Azure form ────────────────────────────────────────────────────────────────
function AzureForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ clientId: "", clientSecret: "", subscriptionId: "", tenantId: "", resourceGroup: "", containerAppName: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await apiPost("/api/tenant/cloud-connection", { provider: "azure", credentials: form });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Erro ao salvar"); }
    finally { setSaving(false); }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Crie um Service Principal no Azure AD com permissões de Contributor no seu Resource Group.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField label="Client ID (App ID)" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required size="small" />
      <TextField label="Client Secret" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} required size="small" />
      <TextField label="Subscription ID" value={form.subscriptionId} onChange={(e) => setForm({ ...form, subscriptionId: e.target.value })} required size="small" />
      <TextField label="Tenant ID" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} required size="small" />
      <TextField label="Resource Group (opcional)" value={form.resourceGroup} onChange={(e) => setForm({ ...form, resourceGroup: e.target.value })} size="small" />
      <TextField label="Container App Name (opcional)" value={form.containerAppName} onChange={(e) => setForm({ ...form, containerAppName: e.target.value })} size="small" />
      <Button variant="contained" onClick={save} disabled={saving || !form.clientId || !form.clientSecret}>
        {saving ? <CircularProgress size={18} /> : "Salvar credenciais Azure"}
      </Button>
    </Stack>
  );
}

// ── GCP form ──────────────────────────────────────────────────────────────────
function GCPForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ serviceAccountKey: "", projectId: "", region: "us-central1", serviceName: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      JSON.parse(form.serviceAccountKey); // validate JSON
      await apiPost("/api/tenant/cloud-connection", { provider: "gcp", credentials: form, region: form.region });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? (e.message.includes("JSON") ? "Service Account Key deve ser JSON válido" : e.message) : "Erro ao salvar");
    } finally { setSaving(false); }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Crie uma Service Account com roles: Cloud Run Admin, Storage Admin, Artifact Registry Writer.
        Gere uma chave JSON e cole abaixo.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <TextField label="Service Account Key (JSON)" value={form.serviceAccountKey}
        onChange={(e) => setForm({ ...form, serviceAccountKey: e.target.value })}
        required multiline rows={6} size="small"
        placeholder='{"type":"service_account","project_id":"...","private_key":"..."}'
        inputProps={{ style: { fontFamily: "monospace", fontSize: "0.72rem" } }}
      />
      <TextField label="Project ID" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} required size="small" />
      <TextField label="Região" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} size="small" helperText="ex: us-central1, southamerica-east1" />
      <TextField label="Cloud Run Service Name (opcional)" value={form.serviceName} onChange={(e) => setForm({ ...form, serviceName: e.target.value })} size="small" />
      <Button variant="contained" onClick={save} disabled={saving || !form.serviceAccountKey || !form.projectId}>
        {saving ? <CircularProgress size={18} /> : "Salvar credenciais GCP"}
      </Button>
    </Stack>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function CloudSettingsPageInner() {
  const [tab, setTab]               = useState<number>(0);
  const [connection, setConnection] = useState<CloudConnection | null | undefined>(undefined);
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [removing, setRemoving]     = useState(false);
  const providers: Provider[]       = ["aws", "azure", "gcp"];
  const selectedProvider            = providers[tab];

  const load = async () => {
    try {
      const res = await apiGet<{ connection: CloudConnection | null }>("/api/tenant/cloud-connection");
      setConnection(res.connection);
      if (res.connection) {
        const idx = providers.indexOf(res.connection.provider);
        if (idx >= 0) setTab(idx);
      }
    } catch { setConnection(null); }
  };

  useEffect(() => { load(); }, []);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await apiPost<{ ok: boolean; message: string }>("/api/tenant/cloud-connection/test", {});
      setTestResult(res);
    } catch (e) { setTestResult({ ok: false, message: e instanceof Error ? e.message : "Erro" }); }
    finally { setTesting(false); }
  };

  const handleRemove = async () => {
    if (!connection) return;
    setRemoving(true);
    try {
      await apiDelete(`/api/tenant/cloud-connection/${connection.provider}`);
      setConnection(null); setTestResult(null);
    } catch { /* */ }
    finally { setRemoving(false); }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <CloudIcon sx={{ color: "primary.main" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Conectar Cloud</Typography>
          <Typography variant="body2" color="text.secondary">
            Quando um projeto é aceito, o Genesis injeta suas credenciais como GitHub Secrets
            e gera o workflow de deploy automaticamente.
          </Typography>
        </Box>
      </Stack>

      {/* Active connection status */}
      {connection && (
        <Alert
          severity="success" sx={{ mb: 3 }}
          icon={<CheckCircleIcon />}
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" startIcon={testing ? <CircularProgress size={12} /> : <VerifiedIcon />}
                onClick={handleTest} disabled={testing}>
                Testar
              </Button>
              <Button size="small" color="error" startIcon={<DeleteIcon />}
                onClick={handleRemove} disabled={removing}>
                Remover
              </Button>
            </Stack>
          }
        >
          <Typography variant="body2" fontWeight={500}>
            {PROVIDER_META[connection.provider].icon} {PROVIDER_META[connection.provider].label} conectado
            {connection.region && ` — ${connection.region}`}
          </Typography>
          {connection.githubSecretsSyncedAt && (
            <Typography variant="caption" color="text.secondary">
              Secrets sincronizados em {new Date(connection.githubSecretsSyncedAt).toLocaleString("pt-BR")}
            </Typography>
          )}
        </Alert>
      )}

      {testResult && (
        <Alert severity={testResult.ok ? "success" : "error"} sx={{ mb: 2 }} onClose={() => setTestResult(null)}>
          {testResult.message}
        </Alert>
      )}

      {/* Tabs */}
      <Card>
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          sx={{ borderBottom: "1px solid", borderColor: "divider", px: 2 }}>
          {providers.map((p) => (
            <Tab key={p}
              label={
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <span>{PROVIDER_META[p].icon}</span>
                  <span>{PROVIDER_META[p].label}</span>
                  <Typography variant="caption" color="text.secondary">({PROVIDER_META[p].hint})</Typography>
                  {connection?.provider === p && connection.status === "active" && (
                    <Chip size="small" label="Ativo" color="success" sx={{ height: 16, fontSize: "0.6rem" }} />
                  )}
                </Stack>
              }
            />
          ))}
        </Tabs>

        <CardContent>
          {selectedProvider === "aws"   && <AWSForm   onSaved={() => { load(); }} />}
          {selectedProvider === "azure" && <AzureForm onSaved={() => { load(); }} />}
          {selectedProvider === "gcp"   && <GCPForm   onSaved={() => { load(); }} />}

          <Divider sx={{ my: 3 }} />

          <Box sx={{ bgcolor: "action.hover", borderRadius: 1, p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>Como funciona</Typography>
            <Stack spacing={0.5}>
              {[
                "1. Você configura as credenciais aqui (encriptadas AES-256)",
                "2. Ao aceitar um projeto, o Genesis cria o repositório GitHub",
                "3. As credenciais são injetadas como GitHub Actions Secrets no repo",
                "4. O workflow .github/workflows/deploy.yml é gerado automaticamente",
                "5. A cada push para main → GitHub Actions faz o deploy na sua cloud",
              ].map((s) => (
                <Typography key={s} variant="caption" color="text.secondary">{s}</Typography>
              ))}
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}

export default observer(CloudSettingsPageInner);
