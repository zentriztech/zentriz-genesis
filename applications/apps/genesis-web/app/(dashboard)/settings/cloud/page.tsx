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
import IconButton from "@mui/material/IconButton";
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
import CloudIcon from "@mui/icons-material/Cloud";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SaveIcon from "@mui/icons-material/Save";
import VerifiedIcon from "@mui/icons-material/Verified";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type CloudProvider = "aws" | "azure" | "gcp";

interface CloudSlot {
  id: string;
  provider: CloudProvider;
  label: string | null;
  region: string | null;
  serviceType: string;
  slotIndex: number;
  status: string;
  githubSecretsSyncedAt: string | null;
  createdAt: string;
}

// ── Meta dos providers ────────────────────────────────────────────────────────

const PROVIDER_META: Record<CloudProvider, {
  label: string; icon: string; hint: string; color: string;
  fields: { key: string; label: string; placeholder: string; required?: boolean; secret?: boolean; multiline?: boolean; rows?: number; helperText?: string }[];
}> = {
  aws: {
    label: "AWS", icon: "🟠", hint: "ECS Fargate / ECR", color: "#FF9900",
    fields: [
      { key: "accessKeyId",      label: "Access Key ID",      placeholder: "AKIA...",                required: true,  secret: false },
      { key: "secretAccessKey",  label: "Secret Access Key",  placeholder: "wJalrXUt...",            required: true,  secret: true  },
      { key: "region",           label: "Região",             placeholder: "us-east-1",              required: true,  secret: false, helperText: "ex: us-east-1, sa-east-1" },
      { key: "ecrRegistry",      label: "ECR Registry",       placeholder: "123456.dkr.ecr.us-east-1.amazonaws.com", helperText: "Opcional" },
      { key: "ecsCluster",       label: "ECS Cluster",        placeholder: "zentriz-production",     helperText: "Opcional" },
    ],
  },
  azure: {
    label: "Azure", icon: "🔵", hint: "Container Apps / ACR", color: "#0078D4",
    fields: [
      { key: "clientId",          label: "Client ID (App ID)",  placeholder: "xxxxxxxx-xxxx-...", required: true  },
      { key: "clientSecret",      label: "Client Secret",       placeholder: "...",               required: true,  secret: true },
      { key: "subscriptionId",    label: "Subscription ID",     placeholder: "xxxxxxxx-xxxx-...", required: true  },
      { key: "tenantId",          label: "Tenant ID",           placeholder: "xxxxxxxx-xxxx-...", required: true  },
      { key: "resourceGroup",     label: "Resource Group",      placeholder: "my-rg",             helperText: "Opcional" },
      { key: "containerAppName",  label: "Container App Name",  placeholder: "my-app",            helperText: "Opcional" },
    ],
  },
  gcp: {
    label: "GCP", icon: "🔷", hint: "Cloud Run / GCR", color: "#4285F4",
    fields: [
      { key: "serviceAccountKey", label: "Service Account Key (JSON)", placeholder: '{"type":"service_account",...}',
        required: true, multiline: true, rows: 5,
        helperText: "Roles: Cloud Run Admin, Storage Admin, Artifact Registry Writer" },
      { key: "projectId",   label: "Project ID",             placeholder: "my-project-123",  required: true },
      { key: "region",      label: "Região",                 placeholder: "us-central1",     helperText: "ex: southamerica-east1" },
      { key: "serviceName", label: "Cloud Run Service Name", placeholder: "my-service",      helperText: "Opcional" },
    ],
  },
};

const PROVIDERS = Object.keys(PROVIDER_META) as CloudProvider[];

// ── Label / cor por posição ───────────────────────────────────────────────────

const SLOT_LABEL = (i: number) => i === 0 ? "Principal" : `Fallback ${i}`;
const SLOT_COLOR = (i: number) => ["#6366F1","#10B981","#F59E0B","#EF4444"][i] ?? "#6366F1";

// ── Modal de cadastro / edição ────────────────────────────────────────────────

interface ModalProps {
  open: boolean;
  slot: CloudSlot | null;   // null = novo
  onClose: () => void;
  onSaved: () => void;
}

function CloudModal({ open, slot, onClose, onSaved }: ModalProps) {
  const isEdit = Boolean(slot);
  const [tab, setTab]     = useState(isEdit ? PROVIDERS.indexOf(slot!.provider) : 0);
  const [label, setLabel] = useState(slot?.label ?? "");
  const [form, setForm]   = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr]     = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(isEdit ? PROVIDERS.indexOf(slot!.provider) : 0);
      setLabel(slot?.label ?? "");
      setForm({});
      setErr(null);
    }
  }, [open, slot, isEdit]);

  useEffect(() => {
    setForm({});
  }, [tab]);

  const provider = PROVIDERS[tab];
  const meta     = PROVIDER_META[provider];

  const handleSave = async () => {
    setSaving(true); setErr(null);
    try {
      // Validar campos required não preenchidos (novo) ou que precisam de valor (edição sem existente)
      if (!isEdit) {
        const missing = meta.fields.filter((f) => f.required && !form[f.key]?.trim()).map((f) => f.label);
        if (missing.length) throw new Error(`Campos obrigatórios: ${missing.join(", ")}`);
      }
      if (isEdit) {
        await apiPut(`/api/tenant/cloud-connections/${slot!.id}`, {
          provider,
          label: label || null,
          credentials: form,
        });
      } else {
        await apiPost("/api/tenant/cloud-connections", {
          provider,
          label: label || null,
          credentials: form,
          region: form.region,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: "background.paper" } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CloudIcon sx={{ color: "primary.main" }} />
          <Typography fontWeight={700}>
            {isEdit ? "Editar Cloud" : "Adicionar Cloud"}
          </Typography>
        </Stack>
      </DialogTitle>

      <DialogContent sx={{ pt: "8px !important" }}>
        {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>{err}</Alert>}

        {/* Label personalizado */}
        <TextField
          label="Nome / Label (opcional)"
          placeholder="ex: AWS Produção, GCP Staging"
          size="small" fullWidth sx={{ mb: 2 }}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          helperText="Ajuda a identificar este slot na lista"
        />

        {/* Tabs de provider — desabilitadas em edição */}
        <Tabs value={tab} onChange={(_e, v) => !isEdit && setTab(v as number)}
          sx={{ mb: 2.5, borderBottom: "1px solid", borderColor: "divider", minHeight: 36 }}
          variant="scrollable" scrollButtons="auto">
          {PROVIDERS.map((p, i) => (
            <Tab key={p} value={i}
              disabled={isEdit && p !== slot?.provider}
              label={
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span style={{ fontSize: "0.9rem" }}>{PROVIDER_META[p].icon}</span>
                  <span style={{ fontSize: "0.72rem" }}>{PROVIDER_META[p].label}</span>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem" }}>
                    ({PROVIDER_META[p].hint})
                  </Typography>
                </Stack>
              }
              sx={{ textTransform: "none", minHeight: 36, py: 0.5 }}
            />
          ))}
        </Tabs>

        {/* Campos do provider */}
        <Stack spacing={1.5}>
          {meta.fields.map((f) => (
            <TextField
              key={f.key}
              label={f.label + (f.required ? " *" : "")}
              placeholder={
                isEdit && slot?.provider === provider
                  ? "(manter atual — deixe em branco)"
                  : f.placeholder
              }
              type={f.secret ? "password" : "text"}
              size="small"
              multiline={f.multiline}
              rows={f.rows}
              value={form[f.key] ?? ""}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
              helperText={f.helperText ?? (isEdit ? "Deixe em branco para manter o valor atual" : undefined)}
              fullWidth
              inputProps={f.multiline ? { style: { fontFamily: "monospace", fontSize: "0.72rem" } } : undefined}
            />
          ))}
        </Stack>
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

// ── Card de um slot configurado ───────────────────────────────────────────────

interface SlotCardProps {
  slot: CloudSlot;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  deleting: boolean;
  testing: boolean;
}

function CloudSlotCard({ slot, index, total, onMoveUp, onMoveDown, onEdit, onDelete, onTest, deleting, testing }: SlotCardProps) {
  const meta  = PROVIDER_META[slot.provider];
  const color = SLOT_COLOR(index);

  return (
    <Card variant="outlined" sx={{ borderColor: color + "55", borderLeft: `4px solid ${color}` }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          {/* Badge posição */}
          <Chip label={SLOT_LABEL(index)} size="small"
            sx={{ bgcolor: color + "20", color, fontWeight: 700, border: `1px solid ${color}44`, minWidth: 90 }} />

          {/* Info */}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography sx={{ fontSize: "1rem" }}>{meta.icon}</Typography>
              <Typography variant="body2" fontWeight={600}>{meta.label}</Typography>
              {slot.label && (
                <Typography variant="caption" color="text.secondary">— {slot.label}</Typography>
              )}
              {slot.region && (
                <Chip label={slot.region} size="small" variant="outlined"
                  sx={{ fontSize: "0.65rem", height: 18 }} />
              )}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
              <CheckCircleIcon sx={{ fontSize: "0.75rem", color: "success.main" }} />
              <Typography variant="caption" color="success.main">Credenciais configuradas</Typography>
              {slot.githubSecretsSyncedAt && (
                <Typography variant="caption" color="text.disabled">
                  · Secrets sincronizados {new Date(slot.githubSecretsSyncedAt).toLocaleDateString("pt-BR")}
                </Typography>
              )}
            </Stack>
          </Box>

          {/* Ações */}
          <Stack direction="row" spacing={0.25}>
            <Tooltip title="Testar credenciais">
              <IconButton size="small" onClick={onTest} disabled={testing}>
                {testing ? <CircularProgress size={14} /> : <VerifiedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Mover para cima">
              <span>
                <IconButton size="small" onClick={onMoveUp} disabled={index === 0}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Mover para baixo">
              <span>
                <IconButton size="small" onClick={onMoveDown} disabled={index === total - 1}>
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Editar">
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

function CloudSettingsPageInner() {
  const [slots, setSlots]     = useState<CloudSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editSlot, setEditSlot]   = useState<CloudSlot | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId]   = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet("/api/tenant/cloud-connections") as CloudSlot[];
      setSlots(Array.isArray(res) ? res : []);
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar as configurações." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ── Reordenar ─────────────────────────────────────────────────────────────

  const swap = async (indexA: number, indexB: number) => {
    const idA = slots[indexA].id;
    const idB = slots[indexB].id;
    // Optimistic
    const next = [...slots];
    [next[indexA], next[indexB]] = [next[indexB], next[indexA]];
    setSlots(next);
    try {
      await apiPost("/api/tenant/cloud-connections/reorder", { idA, idB });
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao reordenar." });
      await load();
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (slot: CloudSlot) => {
    const displayName = slot.label ?? `${PROVIDER_META[slot.provider].label}`;
    if (!confirm(`Remover "${SLOT_LABEL(slots.indexOf(slot))} — ${displayName}"?`)) return;
    setDeletingId(slot.id);
    try {
      await apiDelete(`/api/tenant/cloud-connections/${slot.id}`);
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao remover." });
    } finally { setDeletingId(null); }
  };

  // ── Testar ────────────────────────────────────────────────────────────────

  const handleTest = async (slot: CloudSlot) => {
    setTestingId(slot.id);
    try {
      const res = await apiPost(`/api/tenant/cloud-connections/${slot.id}/test`, {}) as { ok: boolean; message: string };
      setGlobalMsg({ type: res.ok ? "success" : "error", text: res.message });
    } catch (e) {
      setGlobalMsg({ type: "error", text: e instanceof Error ? e.message : "Erro ao testar" });
    } finally { setTestingId(null); }
  };

  if (loading) return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}><CircularProgress /></Box>
  );

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", p: { xs: 2, md: 4 } }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 3 }}>
        <CloudIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h5" fontWeight={700}>Conectar Cloud</Typography>
          <Typography variant="body2" color="text.secondary">
            Ao aceitar um projeto, o Genesis injeta as credenciais como GitHub Secrets e gera o workflow de deploy.
            O primeiro slot é o <strong>Principal</strong> — os demais são fallbacks.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />}
          onClick={() => { setEditSlot(null); setModalOpen(true); }}
          disabled={slots.length >= 4}>
          Adicionar
        </Button>
      </Stack>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>
          {globalMsg.text}
        </Alert>
      )}

      {/* Lista de slots */}
      {slots.length === 0 ? (
        <Card variant="outlined" sx={{ textAlign: "center", py: 6, borderStyle: "dashed" }}>
          <CardContent>
            <CloudIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
            <Typography variant="body1" color="text.secondary" fontWeight={500}>
              Nenhuma cloud configurada
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
              Configure AWS, Azure ou GCP para habilitar o deploy automático
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />}
              onClick={() => { setEditSlot(null); setModalOpen(true); }}>
              Adicionar primeira cloud
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {slots.map((slot, index) => (
            <CloudSlotCard
              key={slot.id}
              slot={slot}
              index={index}
              total={slots.length}
              onMoveUp={() => swap(index, index - 1)}
              onMoveDown={() => swap(index, index + 1)}
              onEdit={() => { setEditSlot(slot); setModalOpen(true); }}
              onDelete={() => handleDelete(slot)}
              onTest={() => handleTest(slot)}
              deleting={deletingId === slot.id}
              testing={testingId === slot.id}
            />
          ))}

          {/* Placeholders */}
          {slots.length < 4 && (
            <>
              <Divider sx={{ my: 0.5 }}>
                <Typography variant="caption" color="text.disabled">slots disponíveis</Typography>
              </Divider>
              {Array.from({ length: 4 - slots.length }).map((_, i) => (
                <Card key={i} variant="outlined"
                  sx={{ borderStyle: "dashed", borderColor: "divider", opacity: 0.5 }}>
                  <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                      <Chip label={SLOT_LABEL(slots.length + i)} size="small"
                        sx={{ color: "text.disabled", bgcolor: "action.hover", minWidth: 90 }} />
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
      {slots.length > 0 && (
        <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona</Typography>
          <Stack spacing={0.5}>
            {[
              "1. Credenciais salvas criptografadas com AES-256-GCM",
              "2. Ao aceitar um projeto, o Genesis cria o repositório GitHub",
              "3. As credenciais do slot Principal são injetadas como GitHub Actions Secrets",
              "4. O workflow .github/workflows/deploy.yml é gerado automaticamente",
              "5. Cada push para main dispara o deploy na cloud configurada",
            ].map((s) => (
              <Typography key={s} variant="caption" color="text.secondary">{s}</Typography>
            ))}
          </Stack>
        </Alert>
      )}

      {/* Modal */}
      <CloudModal
        open={modalOpen}
        slot={editSlot}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </Box>
  );
}

export default observer(CloudSettingsPageInner);
