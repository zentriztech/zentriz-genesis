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
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PsychologyIcon from "@mui/icons-material/Psychology";
import SaveIcon from "@mui/icons-material/Save";
import { apiGet, apiPut, apiDelete } from "@/lib/api";

type Provider = "bedrock" | "openai" | "anthropic" | "azure_openai";

interface LlmConfig {
  configured: boolean;
  provider?: Provider;
  model_id?: string;
  credentials_masked?: Record<string, string>;
  max_concurrent_projects?: number;
  daily_token_quota?: number | null;
  deadpool_token_reserve?: number;
  is_active?: boolean;
  default?: { provider: string; model_id: string };
}

const PROVIDER_META: Record<Provider, { label: string; icon: string; models: string[]; fields: { key: string; label: string; placeholder: string; secret?: boolean }[] }> = {
  bedrock: {
    label: "AWS Bedrock", icon: "☁️",
    models: ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-opus-4-7", "us.anthropic.claude-haiku-4-5-20251001"],
    fields: [
      { key: "aws_access_key_id",     label: "AWS Access Key ID",     placeholder: "AKIA...",           secret: false },
      { key: "aws_secret_access_key", label: "AWS Secret Access Key", placeholder: "wJalrXUt...",       secret: true  },
      { key: "aws_region",            label: "AWS Region",            placeholder: "us-east-1",          secret: false },
    ],
  },
  openai: {
    label: "OpenAI", icon: "🤖",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    fields: [
      { key: "api_key", label: "API Key", placeholder: "sk-...", secret: true },
    ],
  },
  anthropic: {
    label: "Anthropic (direto)", icon: "🧠",
    models: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5-20251001"],
    fields: [
      { key: "api_key", label: "API Key", placeholder: "sk-ant-...", secret: true },
    ],
  },
  azure_openai: {
    label: "Azure OpenAI", icon: "🔷",
    models: ["gpt-4o", "gpt-4-turbo", "gpt-35-turbo"],
    fields: [
      { key: "api_key",         label: "API Key",          placeholder: "...",                      secret: true  },
      { key: "endpoint",        label: "Endpoint",         placeholder: "https://xxx.openai.azure.com", secret: false },
      { key: "deployment_name", label: "Deployment Name",  placeholder: "my-gpt4o",                 secret: false },
      { key: "api_version",     label: "API Version",      placeholder: "2024-02-01",               secret: false },
    ],
  },
};

const PROVIDERS = Object.keys(PROVIDER_META) as Provider[];

function LlmSettingsInner() {
  const [config, setConfig]       = useState<LlmConfig | null>(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const [success, setSuccess]     = useState("");
  const [error, setError]         = useState("");

  // Form state
  const [tab, setTab]             = useState(0);
  const [modelId, setModelId]     = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [dailyQuota, setDailyQuota]       = useState<string>("");
  const [dpReserve, setDpReserve]         = useState(0);

  const provider = PROVIDERS[tab];
  const meta     = PROVIDER_META[provider];

  useEffect(() => {
    apiGet<LlmConfig>("/api/tenant/llm-config")
      .then((d) => {
        setConfig(d);
        if (d.configured && d.provider) {
          const idx = PROVIDERS.indexOf(d.provider);
          if (idx >= 0) setTab(idx);
          setModelId(d.model_id ?? "");
          setMaxConcurrent(d.max_concurrent_projects ?? 3);
          setDailyQuota(d.daily_token_quota != null ? String(d.daily_token_quota) : "");
          setDpReserve(d.deadpool_token_reserve ?? 0);
        }
      })
      .catch(() => setError("Não foi possível carregar a configuração."))
      .finally(() => setLoading(false));
  }, []);

  // Reset credentials when changing provider tab
  useEffect(() => {
    setCredentials({});
    setModelId(meta.models[0] ?? "");
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true); setError(""); setSuccess("");
    try {
      await apiPut("/api/tenant/llm-config", {
        provider,
        model_id: modelId || meta.models[0],
        credentials,
        max_concurrent_projects: maxConcurrent,
        daily_token_quota: dailyQuota ? Number(dailyQuota) : null,
        deadpool_token_reserve: dpReserve,
      });
      setSuccess(`Configuração ${meta.label} salva com sucesso.`);
      // Reload
      const fresh = await apiGet<LlmConfig>("/api/tenant/llm-config");
      setConfig(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm("Remover config? O sistema voltará a usar o provider padrão da Zentriz.")) return;
    setDeleting(true);
    try {
      await apiDelete("/api/tenant/llm-config");
      setSuccess("Config removida. Usando provider padrão do sistema.");
      setConfig({ configured: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao remover.");
    } finally { setDeleting(false); }
  };

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
      <CircularProgress />
    </Box>
  );

  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 3 }}>
        <PsychologyIcon sx={{ color: "primary.main" }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Configuração de LLM</Typography>
          <Typography variant="body2" color="text.secondary">
            Configure o provider de IA que seus projetos usarão. Cada tenant controla seu próprio uso e custos.
          </Typography>
        </Box>
      </Stack>

      {/* Status atual */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack direction="row" spacing={2} alignItems="center">
            {config?.configured ? (
              <>
                <CheckCircleIcon color="success" />
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="body2" fontWeight={600}>
                    {PROVIDER_META[config.provider!]?.icon} {PROVIDER_META[config.provider!]?.label ?? config.provider} configurado
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Modelo: {config.model_id} · Máx. {config.max_concurrent_projects} projetos simultâneos
                  </Typography>
                </Box>
                <Chip label="Ativo" color="success" size="small" />
              </>
            ) : (
              <>
                <InfoOutlinedIcon color="warning" />
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="body2" fontWeight={600}>Usando provider padrão da Zentriz</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Provider: {config?.default?.provider ?? "bedrock"} · Modelo: {config?.default?.model_id ?? "claude-sonnet-4-6"}
                  </Typography>
                </Box>
                <Chip label="Padrão do sistema" size="small" />
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess("")}>{success}</Alert>}
      {error   && <Alert severity="error"   sx={{ mb: 2 }} onClose={() => setError("")}>{error}</Alert>}

      {/* Formulário */}
      <Card>
        <CardContent>
          <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 2 }}>
            Selecione o provider
          </Typography>
          <Tabs value={tab} onChange={(_e, v) => setTab(v as number)} sx={{ mb: 3, borderBottom: "1px solid", borderColor: "divider" }}>
            {PROVIDERS.map((p, i) => (
              <Tab key={p} value={i}
                label={<Stack direction="row" spacing={0.75} alignItems="center">
                  <span>{PROVIDER_META[p].icon}</span>
                  <span>{PROVIDER_META[p].label}</span>
                </Stack>}
                sx={{ textTransform: "none", minHeight: 44 }}
              />
            ))}
          </Tabs>

          {/* Credentials */}
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5 }}>
            Credenciais
          </Typography>
          <Stack spacing={2} sx={{ mb: 3 }}>
            {meta.fields.map((f) => (
              <TextField key={f.key}
                label={f.label}
                placeholder={
                  config?.configured && config.provider === provider && config.credentials_masked?.[f.key]
                    ? config.credentials_masked[f.key]  // mostra masked value como placeholder
                    : f.placeholder
                }
                type={f.secret ? "password" : "text"}
                size="small"
                value={credentials[f.key] ?? ""}
                onChange={(e) => setCredentials(prev => ({ ...prev, [f.key]: e.target.value }))}
                helperText={
                  config?.configured && config.provider === provider && config.credentials_masked?.[f.key]
                    ? "Deixe em branco para manter o valor salvo"
                    : undefined
                }
                fullWidth
              />
            ))}
          </Stack>

          <Divider sx={{ my: 2 }} />

          {/* Model */}
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5 }}>
            Modelo
          </Typography>
          <FormControl size="small" fullWidth sx={{ mb: 3 }}>
            <InputLabel>Modelo padrão</InputLabel>
            <Select value={modelId || meta.models[0]} label="Modelo padrão" onChange={(e) => setModelId(e.target.value)}>
              {meta.models.map((m) => (
                <MenuItem key={m} value={m}>{m}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <Divider sx={{ my: 2 }} />

          {/* Limites */}
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 2 }}>
            Limites e quotas
          </Typography>
          <Stack spacing={3} sx={{ mb: 3 }}>
            <Box>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Typography variant="body2">Projetos simultâneos máximos</Typography>
                <Typography variant="body2" fontWeight={600} color="primary.main">{maxConcurrent}</Typography>
              </Stack>
              <Slider value={maxConcurrent} onChange={(_e, v) => setMaxConcurrent(v as number)}
                min={1} max={20} step={1} marks={[{value:1},{value:5},{value:10},{value:20}]}
                sx={{ color: "primary.main" }} />
              <Typography variant="caption" color="text.secondary">
                Projetos acima do limite entram em fila automática.
              </Typography>
            </Box>

            <TextField
              label="Quota diária de tokens (opcional)"
              placeholder="ex: 1000000"
              size="small"
              type="number"
              value={dailyQuota}
              onChange={(e) => setDailyQuota(e.target.value)}
              helperText="Deixe vazio para sem limite. Inclui uso do Genesis + Deadpool."
              fullWidth
            />

            <Box>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Typography variant="body2">Reserva Deadpool</Typography>
                  <Tooltip title="Tokens reservados para o Deadpool monitorar projetos. O Genesis usa o restante.">
                    <InfoOutlinedIcon sx={{ fontSize: "0.9rem", color: "text.secondary" }} />
                  </Tooltip>
                </Stack>
                <Typography variant="body2" fontWeight={600} color="primary.main">
                  {dpReserve > 0 ? `${(dpReserve / 1000).toFixed(0)}k tokens` : "Sem reserva"}
                </Typography>
              </Stack>
              <Slider value={dpReserve} onChange={(_e, v) => setDpReserve(v as number)}
                min={0} max={500000} step={10000}
                marks={[{value:0,label:"0"},{value:100000,label:"100k"},{value:500000,label:"500k"}]}
                sx={{ color: "secondary.main" }} />
            </Box>
          </Stack>

          {/* Actions */}
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            <Button variant="contained" startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
              disabled={saving} onClick={handleSave}>
              {saving ? "Salvando…" : "Salvar configuração"}
            </Button>
            {config?.configured && (
              <Button variant="outlined" color="error"
                startIcon={deleting ? <CircularProgress size={14} color="inherit" /> : <DeleteIcon />}
                disabled={deleting} onClick={handleDelete}>
                {deleting ? "Removendo…" : "Remover e usar padrão"}
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Info */}
      <Alert severity="info" sx={{ mt: 2 }} icon={<InfoOutlinedIcon />}>
        <Typography variant="body2" fontWeight={500}>Como funciona</Typography>
        <Typography variant="caption" color="text.secondary">
          Ao salvar, todos os projetos deste tenant passarão a usar as credenciais configuradas aqui.
          Genesis (build) e Deadpool (monitoramento) compartilham a mesma conta — gerencie a reserva de tokens para o Deadpool evitar que projetos em build esgotem a quota.
          As credenciais são armazenadas de forma segura e nunca expostas em logs.
        </Typography>
      </Alert>
    </Box>
  );
}

export default observer(LlmSettingsInner);
