"use client";

import { useCallback, useEffect, useState } from "react";
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
import IconButton from "@mui/material/IconButton";
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
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import SaveIcon from "@mui/icons-material/Save";
import { apiGet, apiPut, apiDelete } from "@/lib/api";

// ── Tipos ────────────────────────────────────────────────────────────────────

type Provider = "bedrock" | "openai" | "anthropic" | "azure_openai";

interface LlmSlot {
  configured: boolean;
  priority: number;
  priority_label: string;
  provider: Provider | null;
  model_id: string | null;
  credentials_masked: Record<string, string>;
  has_credentials: boolean;
  max_concurrent_projects: number;
  daily_token_quota: number | null;
  deadpool_token_reserve: number;
  is_active: boolean;
}

interface LlmConfigResponse {
  slots: LlmSlot[];
  system_default: { provider: string; model_id: string };
}

// ── Mapa modelo → provider correto ────────────────────────────────────────────
// Garante que ao salvar o provider certo vai para o banco, independente da aba.
const MODEL_PROVIDER_MAP: Record<string, Provider> = {
  "us.anthropic.claude-sonnet-4-6":           "bedrock",
  "us.anthropic.claude-opus-4-7":             "bedrock",
  "us.anthropic.claude-haiku-4-5-20251001":   "bedrock",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": "bedrock",
  "claude-opus-4-7":                          "anthropic",
  "claude-sonnet-4-6":                        "anthropic",
  "claude-haiku-4-5-20251001":                "anthropic",
  "claude-3-5-sonnet-20241022":               "anthropic",
  "claude-3-opus-20240229":                   "anthropic",
  "gpt-5.5-high":   "openai", "gpt-5.5-high-fast": "openai",
  "gpt-5.4-high":   "openai", "gpt-5.4-high-fast": "openai",
  "gpt-5.3-high":   "openai", "gpt-5.3-high-fast": "openai",
  "gpt-4o":         "openai", "gpt-4o-mini":        "openai",
  "gpt-4-turbo":    "openai", "gpt-4":              "openai",
  "o1":             "openai", "o3-mini":             "openai",
  "composer-2":     "openai",
};

function resolveProviderForModel(modelId: string, tabProvider: Provider): Provider {
  return MODEL_PROVIDER_MAP[modelId] ?? tabProvider;
}

// ── Meta dos providers ────────────────────────────────────────────────────────

const PROVIDER_META: Record<Provider, {
  label: string; icon: string; models: string[];
  fields: { key: string; label: string; placeholder: string; secret?: boolean }[];
}> = {
  bedrock: {
    label: "AWS Bedrock", icon: "☁️",
    models: ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-opus-4-7", "us.anthropic.claude-haiku-4-5-20251001"],
    fields: [
      { key: "aws_access_key_id",     label: "AWS Access Key ID",     placeholder: "AKIA...",     secret: false },
      { key: "aws_secret_access_key", label: "AWS Secret Access Key", placeholder: "wJalrXUt...", secret: true  },
      { key: "aws_region",            label: "AWS Region",            placeholder: "us-east-1",   secret: false },
    ],
  },
  openai: {
    label: "OpenAI (GPT)", icon: "🤖",
    models: ["gpt-5.5-high","gpt-5.5-high-fast","gpt-5.4-high","gpt-5.4-high-fast","gpt-5.3-high","gpt-5.3-high-fast","gpt-4o","gpt-4o-mini","gpt-4-turbo","o1","o3-mini","composer-2"],
    fields: [
      { key: "api_key", label: "API Key", placeholder: "sk-proj-...", secret: true },
    ],
  },
  anthropic: {
    label: "Anthropic Claude (API direta)", icon: "🧠",
    models: ["claude-opus-4-7","claude-sonnet-4-6","claude-haiku-4-5-20251001","claude-3-5-sonnet-20241022","claude-3-opus-20240229"],
    fields: [
      { key: "api_key", label: "API Key (sk-ant-...)", placeholder: "sk-ant-...", secret: true },
    ],
  },
  azure_openai: {
    label: "Azure OpenAI", icon: "🔷",
    models: ["gpt-4o","gpt-4.1","gpt-4-turbo","gpt-35-turbo"],
    fields: [
      { key: "api_key",         label: "API Key",          placeholder: "...",                          secret: true  },
      { key: "endpoint",        label: "Endpoint",         placeholder: "https://xxx.openai.azure.com", secret: false },
      { key: "deployment_name", label: "Deployment Name",  placeholder: "my-gpt4o",                     secret: false },
      { key: "api_version",     label: "API Version",      placeholder: "2024-02-01",                   secret: false },
    ],
  },
};

const PROVIDERS = Object.keys(PROVIDER_META) as Provider[];

const PRIORITY_LABELS: Record<number, string> = {
  0: "Padrão",
  1: "Contingência 1",
  2: "Contingência 2",
  3: "Contingência 3",
};

const PRIORITY_COLORS: Record<number, string> = {
  0: "#6366F1",
  1: "#10B981",
  2: "#F59E0B",
  3: "#EF4444",
};

// ── Formulário de um slot ─────────────────────────────────────────────────────

function SlotForm({
  slot,
  onSaved,
  onDeleted,
}: {
  slot: LlmSlot;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const initialProvider = (slot.provider as Provider) ?? "bedrock";
  const [tab, setTab]           = useState(PROVIDERS.indexOf(initialProvider));
  const [modelId, setModelId]   = useState(slot.model_id ?? "");
  const [creds, setCreds]       = useState<Record<string, string>>({});
  const [maxConc, setMaxConc]   = useState(slot.max_concurrent_projects ?? 3);
  const [quota, setQuota]       = useState(slot.daily_token_quota != null ? String(slot.daily_token_quota) : "");
  const [dpRes, setDpRes]       = useState(slot.deadpool_token_reserve ?? 0);
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg]           = useState<{ type: "success" | "error"; text: string } | null>(null);

  const provider = PROVIDERS[tab] as Provider;
  const meta     = PROVIDER_META[provider];

  // Reset creds ao trocar de aba
  useEffect(() => {
    setCreds({});
    setModelId(meta.models[0] ?? "");
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true); setMsg(null);
    try {
      const selectedModel    = modelId || meta.models[0];
      const resolvedProvider = resolveProviderForModel(selectedModel, provider);
      await apiPut(`/api/tenant/llm-config/${slot.priority}`, {
        provider:                resolvedProvider,
        model_id:                selectedModel,
        credentials:             creds,
        max_concurrent_projects: maxConc,
        daily_token_quota:       quota ? Number(quota) : null,
        deadpool_token_reserve:  dpRes,
      });
      setMsg({ type: "success", text: `${PRIORITY_LABELS[slot.priority]} salvo — provider: ${resolvedProvider}` });
      onSaved();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Erro ao salvar." });
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`Remover ${PRIORITY_LABELS[slot.priority]}?`)) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/tenant/llm-config/${slot.priority}`);
      setMsg({ type: "success", text: "Config removida." });
      onDeleted();
    } catch (e) {
      setMsg({ type: "error", text: e instanceof Error ? e.message : "Erro ao remover." });
    } finally { setDeleting(false); }
  };

  const color = PRIORITY_COLORS[slot.priority];

  return (
    <Card variant="outlined" sx={{ borderColor: slot.configured ? color + "66" : "divider" }}>
      <CardContent>
        {/* Header do slot */}
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
          <Chip
            label={PRIORITY_LABELS[slot.priority]}
            size="small"
            sx={{ bgcolor: color + "20", color, fontWeight: 700, border: `1px solid ${color}44` }}
          />
          {slot.configured && slot.has_credentials ? (
            <Chip icon={<CheckCircleIcon sx={{ fontSize: "0.8rem !important" }} />}
              label={`${PROVIDER_META[slot.provider!]?.icon ?? ""} ${slot.provider} · ${slot.model_id}`}
              size="small" color="success" variant="outlined" />
          ) : slot.configured ? (
            <Chip label={`${slot.provider} · sem credenciais`} size="small" color="warning" variant="outlined" />
          ) : (
            <Chip icon={<RadioButtonUncheckedIcon sx={{ fontSize: "0.8rem !important" }} />}
              label="Não configurado" size="small" variant="outlined" sx={{ color: "text.disabled" }} />
          )}
          <Box sx={{ flexGrow: 1 }} />
          {slot.configured && (
            <Tooltip title={`Remover ${PRIORITY_LABELS[slot.priority]}`}>
              <IconButton size="small" color="error" onClick={handleDelete} disabled={deleting}>
                {deleting ? <CircularProgress size={14} /> : <DeleteIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
        </Stack>

        {msg && <Alert severity={msg.type} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.text}</Alert>}

        {/* Tabs de provider */}
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          sx={{ mb: 2.5, borderBottom: "1px solid", borderColor: "divider", minHeight: 36 }}
          variant="scrollable" scrollButtons="auto">
          {PROVIDERS.map((p, i) => (
            <Tab key={p} value={i}
              label={<Stack direction="row" spacing={0.5} alignItems="center">
                <span style={{ fontSize: "0.9rem" }}>{PROVIDER_META[p].icon}</span>
                <span style={{ fontSize: "0.72rem" }}>{PROVIDER_META[p].label}</span>
              </Stack>}
              sx={{ textTransform: "none", minHeight: 36, py: 0.5 }}
            />
          ))}
        </Tabs>

        {/* Credenciais */}
        <Stack spacing={1.5} sx={{ mb: 2 }}>
          {meta.fields.map((f) => (
            <TextField key={f.key}
              label={f.label}
              placeholder={
                slot.configured && slot.provider === provider && slot.credentials_masked[f.key]
                  ? slot.credentials_masked[f.key]
                  : f.placeholder
              }
              type={f.secret ? "password" : "text"}
              size="small"
              value={creds[f.key] ?? ""}
              onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
              helperText={
                slot.configured && slot.provider === provider && slot.credentials_masked[f.key]
                  ? "Deixe em branco para manter o valor salvo"
                  : undefined
              }
              fullWidth
            />
          ))}
        </Stack>

        {/* Modelo */}
        <FormControl size="small" fullWidth sx={{ mb: 2 }}>
          <InputLabel>Modelo</InputLabel>
          <Select
            value={modelId || meta.models[0]}
            label="Modelo"
            onChange={(e) => setModelId(e.target.value)}
          >
            {meta.models.map((m) => (
              <MenuItem key={m} value={m} sx={{ fontSize: "0.8rem" }}>{m}</MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Limites (só no slot Padrão) */}
        {slot.priority === 0 && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="caption" color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 1.5 }}>
              Limites (aplicados a todos os slots)
            </Typography>
            <Stack spacing={2} sx={{ mb: 2 }}>
              <Box>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Typography variant="body2">Projetos simultâneos máx.</Typography>
                  <Typography variant="body2" fontWeight={700} color="primary.main">{maxConc}</Typography>
                </Stack>
                <Slider value={maxConc} onChange={(_e, v) => setMaxConc(v as number)}
                  min={1} max={20} step={1}
                  marks={[{value:1,label:"1"},{value:5},{value:10},{value:20,label:"20"}]}
                  sx={{ color: "primary.main" }} />
              </Box>
              <TextField label="Quota diária de tokens (opcional)" placeholder="ex: 1000000"
                size="small" type="number" value={quota}
                onChange={(e) => setQuota(e.target.value)}
                helperText="Vazio = sem limite." fullWidth />
              <Box>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography variant="body2">Reserva Deadpool</Typography>
                    <Tooltip title="Tokens reservados para o Deadpool. O Genesis usa o restante.">
                      <InfoOutlinedIcon sx={{ fontSize: "0.85rem", color: "text.secondary" }} />
                    </Tooltip>
                  </Stack>
                  <Typography variant="body2" fontWeight={700} color="secondary.main">
                    {dpRes > 0 ? `${(dpRes / 1000).toFixed(0)}k tok` : "0"}
                  </Typography>
                </Stack>
                <Slider value={dpRes} onChange={(_e, v) => setDpRes(v as number)}
                  min={0} max={500000} step={10000}
                  marks={[{value:0,label:"0"},{value:100000,label:"100k"},{value:500000,label:"500k"}]}
                  sx={{ color: "secondary.main" }} />
              </Box>
            </Stack>
          </>
        )}

        <Button variant="contained" size="small"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
          disabled={saving} onClick={handleSave}
          sx={{ bgcolor: color, "&:hover": { bgcolor: color, opacity: 0.85 } }}>
          {saving ? "Salvando…" : `Salvar ${PRIORITY_LABELS[slot.priority]}`}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

function LlmSettingsInner() {
  const [data, setData]     = useState<LlmConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success"|"error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      // A nova API retorna { slots, system_default }
      // Para compatibilidade com a API antiga que retornava objeto plano,
      // tentamos primeiro o novo formato
      const raw = await apiGet<LlmConfigResponse | { configured: boolean; provider?: string }>("/api/tenant/llm-config");
      if ("slots" in raw) {
        setData(raw as LlmConfigResponse);
      } else {
        // Compat: API antiga → montar estrutura de 4 slots
        const old = raw as { configured: boolean; provider?: string; model_id?: string; credentials_masked?: Record<string,string>; has_credentials?: boolean; max_concurrent_projects?: number; daily_token_quota?: number|null; deadpool_token_reserve?: number; is_active?: boolean };
        const sysDefault = { provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6" };
        const slot0: LlmSlot = {
          configured:              old.configured ?? false,
          priority:                0,
          priority_label:          "Padrão",
          provider:                (old.provider as Provider) ?? null,
          model_id:                old.model_id ?? null,
          credentials_masked:      old.credentials_masked ?? {},
          has_credentials:         old.has_credentials ?? false,
          max_concurrent_projects: old.max_concurrent_projects ?? 3,
          daily_token_quota:       old.daily_token_quota ?? null,
          deadpool_token_reserve:  old.deadpool_token_reserve ?? 0,
          is_active:               old.is_active ?? true,
        };
        setData({ slots: [slot0, ...[1,2,3].map((p) => ({ configured: false, priority: p, priority_label: `Contingência ${p}`, provider: null, model_id: null, credentials_masked: {}, has_credentials: false, max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, is_active: false }))], system_default: sysDefault });
      }
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar as configurações." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const activeSlots  = data?.slots.filter((s) => s.configured && s.has_credentials) ?? [];
  const inactiveSlots = data?.slots.filter((s) => !s.configured || !s.has_credentials) ?? [];

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>
  );

  return (
    <Box sx={{ maxWidth: 860, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 3 }}>
        <PsychologyIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Configuração de LLM</Typography>
          <Typography variant="body2" color="text.secondary">
            Configure até 4 providers. O Genesis usa em ordem: Padrão → Contingência 1 → 2 → 3.
          </Typography>
        </Box>
      </Stack>

      {/* Status resumido */}
      <Card sx={{ mb: 3 }}>
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {activeSlots.length === 0 ? (
              <>
                <InfoOutlinedIcon color="warning" sx={{ fontSize: "1rem" }} />
                <Typography variant="body2" color="text.secondary">
                  Usando provider padrão da Zentriz ({data?.system_default.provider} · {data?.system_default.model_id})
                </Typography>
              </>
            ) : (
              <>
                <CheckCircleIcon color="success" sx={{ fontSize: "1rem" }} />
                <Typography variant="body2" fontWeight={600}>
                  {activeSlots.length} provider{activeSlots.length > 1 ? "s" : ""} configurado{activeSlots.length > 1 ? "s" : ""}
                </Typography>
                {activeSlots.map((s) => (
                  <Chip key={s.priority} size="small"
                    label={`${PRIORITY_LABELS[s.priority]}: ${PROVIDER_META[s.provider!]?.icon ?? ""} ${s.model_id}`}
                    sx={{ bgcolor: PRIORITY_COLORS[s.priority] + "20", color: PRIORITY_COLORS[s.priority], fontSize: "0.65rem" }}
                  />
                ))}
                {inactiveSlots.some((s) => !s.configured) && (
                  <Typography variant="caption" color="text.disabled">
                    · {inactiveSlots.filter((s) => !s.configured).length} slot(s) vazios como fallback
                  </Typography>
                )}
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>
          {globalMsg.text}
        </Alert>
      )}

      {/* 4 slots */}
      <Stack spacing={2}>
        {(data?.slots ?? []).map((slot) => (
          <SlotForm
            key={slot.priority}
            slot={slot}
            onSaved={load}
            onDeleted={load}
          />
        ))}
      </Stack>

      <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
        <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona a ordem de prioridade</Typography>
        <Typography variant="caption" color="text.secondary">
          O Genesis tenta o <strong>Padrão</strong> primeiro. Se não tiver credenciais válidas, tenta <strong>Contingência 1</strong>, depois <strong>2</strong>, depois <strong>3</strong>.
          Se nenhum tiver credenciais, usa o Bedrock da Zentriz como fallback final.
          Bedrock sempre é considerado com credenciais válidas (usa as credenciais AWS da instância).
        </Typography>
      </Alert>
    </Box>
  );
}

export default observer(LlmSettingsInner);
