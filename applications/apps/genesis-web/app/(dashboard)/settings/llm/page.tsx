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
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
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
import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PsychologyIcon from "@mui/icons-material/Psychology";
import SaveIcon from "@mui/icons-material/Save";
import { apiGet, apiPut, apiDelete } from "@/lib/api";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Provider = "bedrock" | "openai" | "anthropic" | "azure_openai";

interface LlmSlot {
  configured: boolean;
  priority: number;
  priority_label: string;
  provider: Provider | null;
  model_id: string | null;
  model_id_fallback: string | null;
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
    models: ["gpt-5.5-high","gpt-5.5-high-fast","gpt-5.4-high","gpt-5.4-high-fast","gpt-4o","gpt-4o-mini","gpt-4-turbo","o1","o3-mini"],
    fields: [
      { key: "api_key", label: "API Key", placeholder: "sk-proj-...", secret: true },
    ],
  },
  anthropic: {
    label: "Anthropic (API Direta)", icon: "🧠",
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

const MODEL_PROVIDER_MAP: Record<string, Provider> = {
  "us.anthropic.claude-sonnet-4-6":           "bedrock",
  "us.anthropic.claude-opus-4-7":             "bedrock",
  "us.anthropic.claude-haiku-4-5-20251001":   "bedrock",
  "claude-opus-4-7":                          "anthropic",
  "claude-sonnet-4-6":                        "anthropic",
  "claude-haiku-4-5-20251001":                "anthropic",
  "claude-3-5-sonnet-20241022":               "anthropic",
  "claude-3-opus-20240229":                   "anthropic",
  "gpt-4o": "openai", "gpt-4o-mini": "openai", "gpt-4-turbo": "openai",
  "gpt-5.5-high": "openai", "gpt-5.5-high-fast": "openai",
  "gpt-5.4-high": "openai", "gpt-5.4-high-fast": "openai",
  "o1": "openai", "o3-mini": "openai",
};

function resolveProvider(modelId: string, tabProvider: Provider): Provider {
  return MODEL_PROVIDER_MAP[modelId] ?? tabProvider;
}

// ── Labels / cores por posição ────────────────────────────────────────────────

const SLOT_LABEL = (idx: number) =>
  idx === 0 ? "Padrão" : `Contingência ${idx}`;

const SLOT_COLOR = (idx: number) => {
  const COLORS = ["#6366F1", "#10B981", "#F59E0B", "#EF4444"];
  return COLORS[idx] ?? "#6366F1";
};

// ── Modal de cadastro / edição ────────────────────────────────────────────────

interface AddModalProps {
  open: boolean;
  slot: LlmSlot | null;          // null = novo
  priority: number;              // posição onde será inserido
  onClose: () => void;
  onSaved: () => void;
  globalLimits: { maxConc: number; quota: string; dpRes: number };
  onLimitsChange: (v: { maxConc: number; quota: string; dpRes: number }) => void;
}

function AddModal({ open, slot, priority, onClose, onSaved, globalLimits, onLimitsChange }: AddModalProps) {
  const initialProvider = (slot?.provider as Provider) ?? "bedrock";
  const [tab, setTab]           = useState(PROVIDERS.indexOf(initialProvider));
  const [modelId, setModelId]   = useState(slot?.model_id ?? "");
  const [fallbackId, setFallbackId] = useState(slot?.model_id_fallback ?? "");
  const [creds, setCreds]       = useState<Record<string, string>>({});
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const [showLimits, setShowLimits] = useState(false);

  // Sincronizar tab quando o slot muda (edição de slot existente)
  useEffect(() => {
    if (open) {
      const p = (slot?.provider as Provider) ?? "bedrock";
      setTab(PROVIDERS.indexOf(p));
      setModelId(slot?.model_id ?? "");
      setFallbackId(slot?.model_id_fallback ?? "");
      setCreds({});
      setErr(null);
    }
  }, [open, slot]);

  // Reset model ao trocar provider
  useEffect(() => {
    const meta = PROVIDER_META[PROVIDERS[tab]];
    setModelId(meta.models[0] ?? "");
    setFallbackId("");
    setCreds({});
  }, [tab]);

  const provider = PROVIDERS[tab] as Provider;
  const meta     = PROVIDER_META[provider];

  const handleSave = async () => {
    setSaving(true); setErr(null);
    try {
      const selected         = modelId || meta.models[0];
      const resolvedProvider = resolveProvider(selected, provider);
      await apiPut(`/api/tenant/llm-config/${priority}`, {
        provider:                resolvedProvider,
        model_id:                selected,
        model_id_fallback:       fallbackId || null,
        credentials:             creds,
        max_concurrent_projects: globalLimits.maxConc,
        daily_token_quota:       globalLimits.quota ? Number(globalLimits.quota) : null,
        deadpool_token_reserve:  globalLimits.dpRes,
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally { setSaving(false); }
  };

  const isEdit = slot?.configured && slot.has_credentials;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: "background.paper" } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <PsychologyIcon sx={{ color: "primary.main" }} />
          <Typography fontWeight={700}>
            {isEdit ? `Editar — ${SLOT_LABEL(priority)}` : "Adicionar LLM"}
          </Typography>
          <Chip label={SLOT_LABEL(priority)} size="small"
            sx={{ bgcolor: SLOT_COLOR(priority) + "22", color: SLOT_COLOR(priority), fontWeight: 700, ml: 0.5 }} />
        </Stack>
      </DialogTitle>

      <DialogContent sx={{ pt: "8px !important" }}>
        {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>{err}</Alert>}

        {/* Tabs de provider */}
        <Tabs value={tab} onChange={(_e, v) => setTab(v as number)}
          sx={{ mb: 2.5, borderBottom: "1px solid", borderColor: "divider", minHeight: 36 }}
          variant="scrollable" scrollButtons="auto">
          {PROVIDERS.map((p, i) => (
            <Tab key={p} value={i}
              label={
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span style={{ fontSize: "0.9rem" }}>{PROVIDER_META[p].icon}</span>
                  <span style={{ fontSize: "0.72rem" }}>{PROVIDER_META[p].label}</span>
                </Stack>
              }
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
                isEdit && slot?.provider === provider && slot.credentials_masked[f.key]
                  ? slot.credentials_masked[f.key]
                  : f.placeholder
              }
              type={f.secret ? "password" : "text"}
              size="small"
              value={creds[f.key] ?? ""}
              onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
              helperText={
                isEdit && slot?.provider === provider && slot.credentials_masked[f.key]
                  ? "Deixe em branco para manter o valor salvo"
                  : undefined
              }
              fullWidth
            />
          ))}
        </Stack>

        {/* Modelo principal + Fallback */}
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Modelo principal</InputLabel>
            <Select value={modelId || meta.models[0]} label="Modelo principal"
              onChange={(e) => setModelId(e.target.value)}>
              {meta.models.map((m) => (
                <MenuItem key={m} value={m} sx={{ fontSize: "0.8rem" }}>{m}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Fallback (rework / QA)</InputLabel>
            <Select value={fallbackId} label="Fallback (rework / QA)"
              onChange={(e) => setFallbackId(e.target.value)}>
              <MenuItem value="" sx={{ fontSize: "0.8rem", color: "text.disabled" }}>
                — Nenhum —
              </MenuItem>
              {meta.models.map((m) => (
                <MenuItem key={m} value={m} sx={{ fontSize: "0.8rem" }}>{m}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        {fallbackId && (
          <Alert severity="info" icon={false} sx={{ mb: 2, py: 0.5, fontSize: "0.75rem" }}>
            Dev/QA usam <strong>{modelId || meta.models[0]}</strong> no 1º intento.
            No rework (QA_FAIL ≥ 1) ou quando Dev escalou, <strong>{fallbackId}</strong> é chamado automaticamente.
          </Alert>
        )}

        {/* Limites globais — expansível */}
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
          <Box
            onClick={() => setShowLimits((v) => !v)}
            sx={{ px: 2, py: 1, display: "flex", alignItems: "center", cursor: "pointer",
              bgcolor: "action.hover", "&:hover": { bgcolor: "action.selected" } }}>
            <Typography variant="caption" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", flexGrow: 1 }}>
              Limites globais
            </Typography>
            <Typography variant="caption" color="text.secondary">{showLimits ? "▲" : "▼"}</Typography>
          </Box>
          {showLimits && (
            <Box sx={{ px: 2, pb: 2, pt: 1.5 }}>
              <Stack spacing={2}>
                <Box>
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                    <Typography variant="body2">Projetos simultâneos máx.</Typography>
                    <Typography variant="body2" fontWeight={700} color="primary.main">{globalLimits.maxConc}</Typography>
                  </Stack>
                  <Slider value={globalLimits.maxConc}
                    onChange={(_e, v) => onLimitsChange({ ...globalLimits, maxConc: v as number })}
                    min={1} max={20} step={1}
                    marks={[{ value: 1, label: "1" }, { value: 10 }, { value: 20, label: "20" }]}
                    sx={{ color: "primary.main" }} />
                </Box>
                <TextField label="Quota diária de tokens (opcional)" placeholder="ex: 1000000"
                  size="small" type="number" value={globalLimits.quota}
                  onChange={(e) => onLimitsChange({ ...globalLimits, quota: e.target.value })}
                  helperText="Vazio = sem limite." fullWidth />
                <Box>
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="body2">Reserva Deadpool</Typography>
                      <Tooltip title="Tokens reservados para o Deadpool.">
                        <InfoOutlinedIcon sx={{ fontSize: "0.85rem", color: "text.secondary" }} />
                      </Tooltip>
                    </Stack>
                    <Typography variant="body2" fontWeight={700} color="secondary.main">
                      {globalLimits.dpRes > 0 ? `${(globalLimits.dpRes / 1000).toFixed(0)}k` : "0"}
                    </Typography>
                  </Stack>
                  <Slider value={globalLimits.dpRes}
                    onChange={(_e, v) => onLimitsChange({ ...globalLimits, dpRes: v as number })}
                    min={0} max={500000} step={10000}
                    marks={[{ value: 0, label: "0" }, { value: 250000, label: "250k" }, { value: 500000, label: "500k" }]}
                    sx={{ color: "secondary.main" }} />
                </Box>
              </Stack>
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button variant="outlined" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}>
          {saving ? "Salvando…" : "Salvar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Card de um LLM configurado ────────────────────────────────────────────────

interface LlmCardProps {
  slot: LlmSlot;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function LlmCard({ slot, index, total, onMoveUp, onMoveDown, onEdit, onDelete, deleting }: LlmCardProps) {
  const color = SLOT_COLOR(index);
  const meta  = PROVIDER_META[slot.provider!];

  return (
    <Card variant="outlined" sx={{ borderColor: color + "55", borderLeft: `4px solid ${color}` }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          {/* Badge de posição */}
          <Chip label={SLOT_LABEL(index)} size="small"
            sx={{ bgcolor: color + "20", color, fontWeight: 700, border: `1px solid ${color}44`, minWidth: 100 }} />

          {/* Info do provider */}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography sx={{ fontSize: "1rem" }}>{meta?.icon}</Typography>
              <Typography variant="body2" fontWeight={600} noWrap>{meta?.label}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: "monospace" }}>
                {slot.model_id}
                {slot.model_id_fallback && (
                  <> <span style={{ opacity: 0.5 }}>→</span> {slot.model_id_fallback}</>
                )}
              </Typography>
            </Stack>
            {slot.has_credentials ? (
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                <CheckCircleIcon sx={{ fontSize: "0.75rem", color: "success.main" }} />
                <Typography variant="caption" color="success.main">Credenciais configuradas</Typography>
              </Stack>
            ) : (
              <Typography variant="caption" color="warning.main">Sem credenciais</Typography>
            )}
          </Box>

          {/* Ações */}
          <Stack direction="row" spacing={0.25}>
            <Tooltip title="Mover para cima (aumentar prioridade)">
              <span>
                <IconButton size="small" onClick={onMoveUp} disabled={index === 0}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Mover para baixo (diminuir prioridade)">
              <span>
                <IconButton size="small" onClick={onMoveDown} disabled={index === total - 1}>
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Editar credenciais / modelo">
              <IconButton size="small" onClick={onEdit}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remover">
              <IconButton size="small" color="error" onClick={onDelete} disabled={deleting}>
                {deleting ? <CircularProgress size={14} /> : <DeleteIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

function LlmSettingsInner() {
  const [slots, setSlots]   = useState<LlmSlot[]>([]);
  const [sysDefault, setSysDefault] = useState({ provider: "bedrock", model_id: "us.anthropic.claude-sonnet-4-6" });
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Modal
  const [modalOpen, setModalOpen]   = useState(false);
  const [editSlot, setEditSlot]     = useState<LlmSlot | null>(null);
  const [editPriority, setEditPriority] = useState(0);

  // Deleting por priority
  const [deletingPriority, setDeletingPriority] = useState<number | null>(null);

  // Limites globais — lidos do slot 0, usados em todos os saves
  const [globalLimits, setGlobalLimits] = useState({ maxConc: 3, quota: "", dpRes: 0 });

  const configuredSlots = slots.filter((s) => s.configured && s.has_credentials);

  const load = useCallback(async () => {
    try {
      const raw = await apiGet("/api/tenant/llm-config") as LlmConfigResponse | { configured: boolean };
      if ("slots" in raw) {
        const resp = raw as LlmConfigResponse;
        setSysDefault(resp.system_default);
        const configured = resp.slots.filter((s) => s.configured && s.has_credentials);
        setSlots(configured);
        // Puxar limites do slot 0 se existir
        const slot0 = resp.slots.find((s) => s.priority === 0);
        if (slot0?.configured) {
          setGlobalLimits({
            maxConc: slot0.max_concurrent_projects ?? 3,
            quota:   slot0.daily_token_quota != null ? String(slot0.daily_token_quota) : "",
            dpRes:   slot0.deadpool_token_reserve ?? 0,
          });
        }
      }
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar as configurações." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ── Reordenar: troca duas posições e re-salva com novas priorities ────────

  const swapSlots = async (indexA: number, indexB: number) => {
    const next = [...configuredSlots];
    [next[indexA], next[indexB]] = [next[indexB], next[indexA]];

    // Optimistic update
    setSlots(next);

    // Persistir: DELETE tudo → re-inserir na nova ordem
    setGlobalMsg(null);
    try {
      await apiDelete("/api/tenant/llm-config");
      for (let i = 0; i < next.length; i++) {
        const s = next[i];
        await apiPut(`/api/tenant/llm-config/${i}`, {
          provider:                s.provider,
          model_id:                s.model_id,
          credentials:             {},                  // vazio = mantém credenciais salvas
          max_concurrent_projects: globalLimits.maxConc,
          daily_token_quota:       globalLimits.quota ? Number(globalLimits.quota) : null,
          deadpool_token_reserve:  globalLimits.dpRes,
        });
      }
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao reordenar. Recarregando…" });
      await load();
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (slotIndex: number) => {
    const slot = configuredSlots[slotIndex];
    if (!confirm(`Remover "${SLOT_LABEL(slotIndex)}" (${slot.model_id})?`)) return;
    setDeletingPriority(slot.priority);
    try {
      // Remove, então reorganiza priorities dos que ficaram
      const remaining = configuredSlots.filter((_, i) => i !== slotIndex);
      await apiDelete("/api/tenant/llm-config");
      for (let i = 0; i < remaining.length; i++) {
        await apiPut(`/api/tenant/llm-config/${i}`, {
          provider:                remaining[i].provider,
          model_id:                remaining[i].model_id,
          credentials:             {},
          max_concurrent_projects: globalLimits.maxConc,
          daily_token_quota:       globalLimits.quota ? Number(globalLimits.quota) : null,
          deadpool_token_reserve:  globalLimits.dpRes,
        });
      }
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao remover." });
    } finally { setDeletingPriority(null); }
  };

  // ── Abrir modal ───────────────────────────────────────────────────────────

  const openAdd = () => {
    if (configuredSlots.length >= 4) {
      setGlobalMsg({ type: "error", text: "Máximo de 4 LLMs atingido." });
      return;
    }
    setEditSlot(null);
    setEditPriority(configuredSlots.length);
    setModalOpen(true);
  };

  const openEdit = (index: number) => {
    setEditSlot(configuredSlots[index]);
    setEditPriority(index);
    setModalOpen(true);
  };

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>
  );

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: { xs: 2, md: 4 } }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <PsychologyIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5" fontWeight={700}>Configuração de LLM</Typography>
          <Typography variant="body2" color="text.secondary">
            O Genesis usa os providers na ordem listada — o primeiro é o Padrão, os demais são Contingências.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}
          disabled={configuredSlots.length >= 4}>
          Adicionar
        </Button>
      </Stack>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>
          {globalMsg.text}
        </Alert>
      )}

      {/* Lista de LLMs configurados */}
      {configuredSlots.length === 0 ? (
        <Card variant="outlined" sx={{ textAlign: "center", py: 6, borderStyle: "dashed" }}>
          <CardContent>
            <PsychologyIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
            <Typography variant="body1" color="text.secondary" fontWeight={500}>
              Nenhum LLM configurado
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
              Usando provider padrão da Zentriz ({sysDefault.provider} · {sysDefault.model_id})
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
              Adicionar primeiro LLM
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {configuredSlots.map((slot, index) => (
            <LlmCard
              key={slot.priority}
              slot={slot}
              index={index}
              total={configuredSlots.length}
              onMoveUp={() => swapSlots(index, index - 1)}
              onMoveDown={() => swapSlots(index, index + 1)}
              onEdit={() => openEdit(index)}
              onDelete={() => handleDelete(index)}
              deleting={deletingPriority === slot.priority}
            />
          ))}

          {/* Slots vazios restantes — placeholder visual */}
          {configuredSlots.length < 4 && (
            <>
              <Divider sx={{ my: 0.5 }}>
                <Typography variant="caption" color="text.disabled">slots disponíveis</Typography>
              </Divider>
              {Array.from({ length: 4 - configuredSlots.length }).map((_, i) => (
                <Card key={i} variant="outlined"
                  sx={{ borderStyle: "dashed", borderColor: "divider", opacity: 0.5 }}>
                  <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                      <Chip label={SLOT_LABEL(configuredSlots.length + i)} size="small"
                        sx={{ color: "text.disabled", bgcolor: "action.hover", minWidth: 100 }} />
                      <Typography variant="body2" color="text.disabled">Não configurado</Typography>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </Stack>
      )}

      {/* Informativo */}
      {configuredSlots.length > 0 && (
        <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona</Typography>
          <Typography variant="caption" color="text.secondary">
            O Genesis tenta os providers em ordem. Se o <strong>Padrão</strong> falhar ou atingir limite,
            tenta <strong>Contingência 1</strong>, depois <strong>2</strong> e <strong>3</strong>.
            Use ↑ ↓ para mudar a ordem — a posição define a prioridade.
          </Typography>
        </Alert>
      )}

      {/* Modal de adicionar / editar */}
      <AddModal
        open={modalOpen}
        slot={editSlot}
        priority={editPriority}
        onClose={() => setModalOpen(false)}
        onSaved={load}
        globalLimits={globalLimits}
        onLimitsChange={setGlobalLimits}
      />
    </Box>
  );
}

export default observer(LlmSettingsInner);
