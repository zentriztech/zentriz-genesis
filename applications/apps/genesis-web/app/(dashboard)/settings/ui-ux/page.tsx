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
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import DesignServicesIcon from "@mui/icons-material/DesignServices";
import EditIcon from "@mui/icons-material/Edit";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SaveIcon from "@mui/icons-material/Save";
import VerifiedIcon from "@mui/icons-material/Verified";
import { apiGet, apiPost, apiPut, apiDelete, withQuery } from "@/lib/api";
import { tenantScopeStore } from "@/stores/tenantScopeStore";

type UiuxProvider = "figma" | "canva";

interface UiuxConnection {
  id: string;
  provider: UiuxProvider;
  label: string | null;
  accountRef: string | null;
  slotIndex: number;
  status: string;
  createdAt: string;
}

const PROVIDER_META: Record<UiuxProvider, {
  label: string; icon: string; hint: string; color: string;
  fields: { key: string; label: string; placeholder: string; required?: boolean; secret?: boolean; helperText?: string }[];
  note?: string;
}> = {
  figma: {
    label: "Figma", icon: "🎨", hint: "Personal Access Token", color: "#A259FF",
    fields: [
      { key: "accessToken", label: "Personal Access Token", placeholder: "figd_...", required: true, secret: true,
        helperText: "Figma → Settings → Security → Personal access tokens" },
      { key: "teamId", label: "Team ID", placeholder: "1234567890", secret: false,
        helperText: "Opcional — necessário para listar os projetos da conta no form de spec" },
    ],
  },
  canva: {
    label: "Canva", icon: "🖌️", hint: "Connect API (OAuth)", color: "#00C4CC",
    note: "A Canva Connect API exige um app OAuth registrado no Developer Portal da Zentriz. Enquanto o app não estiver configurado, cole aqui um access token válido obtido via OAuth.",
    fields: [
      { key: "accessToken", label: "Access Token (OAuth)", placeholder: "...", required: true, secret: true,
        helperText: "Obtido via fluxo OAuth2 do app Connect" },
    ],
  },
};

const PROVIDERS = Object.keys(PROVIDER_META) as UiuxProvider[];

interface ModalProps {
  open: boolean;
  slot: UiuxConnection | null;
  tenantId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function UiuxModal({ open, slot, tenantId, onClose, onSaved }: ModalProps) {
  const isEdit = Boolean(slot);
  const [tab, setTab] = useState(isEdit ? PROVIDERS.indexOf(slot!.provider) : 0);
  const [label, setLabel] = useState(slot?.label ?? "");
  const [accountRef, setAccountRef] = useState(slot?.accountRef ?? "");
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // canvaConfigured: null = ainda checando; true/false = há app OAuth registrado.
  const [canvaConfigured, setCanvaConfigured] = useState<boolean | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(isEdit ? PROVIDERS.indexOf(slot!.provider) : 0);
      setLabel(slot?.label ?? "");
      setAccountRef(slot?.accountRef ?? "");
      setForm({});
      setErr(null);
      setCanvaConfigured(null);
      let cancelled = false;
      // Descobre se o app OAuth do Canva está configurado → 1-clique x token manual.
      apiGet(withQuery("/api/tenant/uiux-connections/canva/config", { tenantId }))
        .then((r) => { if (!cancelled) setCanvaConfigured(Boolean((r as { configured?: boolean })?.configured)); })
        .catch(() => { if (!cancelled) setCanvaConfigured(false); });
      return () => { cancelled = true; };
    }
  }, [open, slot, isEdit, tenantId]);

  useEffect(() => { setForm({}); }, [tab]);

  const provider = PROVIDERS[tab];
  const meta = PROVIDER_META[provider];
  // Modo OAuth 1-clique: só ao criar uma conexão Canva com app configurado.
  const canvaOAuthMode = provider === "canva" && !isEdit && canvaConfigured === true;

  const handleCanvaOAuth = async () => {
    setOauthLoading(true); setErr(null);
    try {
      const r = await apiGet(
        withQuery("/api/tenant/uiux-connections/canva/authorize", { tenantId, label: label || undefined }),
      ) as { authorizeUrl?: string };
      if (!r?.authorizeUrl) throw new Error("URL de autorização indisponível.");
      window.location.href = r.authorizeUrl; // sai do portal → consent no Canva → volta no callback
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Não foi possível iniciar o OAuth do Canva.");
      setOauthLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true); setErr(null);
    try {
      if (!isEdit) {
        const missing = meta.fields.filter((f) => f.required && !form[f.key]?.trim()).map((f) => f.label);
        if (missing.length) throw new Error(`Campos obrigatórios: ${missing.join(", ")}`);
      }
      const accRef = provider === "figma" ? (accountRef || form.teamId || null) : (accountRef || null);
      if (isEdit) {
        await apiPut(withQuery(`/api/tenant/uiux-connections/${slot!.id}`, { tenantId }), {
          provider, label: label || null, accountRef: accRef, credentials: form,
        });
      } else {
        await apiPost(withQuery("/api/tenant/uiux-connections", { tenantId }), {
          provider, label: label || null, accountRef: accRef, credentials: form,
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
          <DesignServicesIcon sx={{ color: "primary.main" }} />
          <Typography fontWeight={700}>{isEdit ? "Editar ferramenta" : "Conectar ferramenta"}</Typography>
        </Stack>
      </DialogTitle>

      <DialogContent sx={{ pt: "8px !important" }}>
        {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>{err}</Alert>}

        <TextField
          label="Nome / Label (opcional)"
          placeholder="ex: Figma Produto, Canva Marketing"
          size="small" fullWidth sx={{ mb: 2 }}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          helperText="Ajuda a identificar esta conta na lista e no form de spec"
        />

        <Tabs value={tab} onChange={(_e, v) => !isEdit && setTab(v as number)}
          sx={{ mb: 2.5, borderBottom: "1px solid", borderColor: "divider", minHeight: 36 }}
          variant="scrollable" scrollButtons="auto">
          {PROVIDERS.map((prov, i) => (
            <Tab key={prov} value={i}
              disabled={isEdit && prov !== slot?.provider}
              label={
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span style={{ fontSize: "0.9rem" }}>{PROVIDER_META[prov].icon}</span>
                  <span style={{ fontSize: "0.72rem" }}>{PROVIDER_META[prov].label}</span>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem" }}>
                    ({PROVIDER_META[prov].hint})
                  </Typography>
                </Stack>
              }
              sx={{ textTransform: "none", minHeight: 36, py: 0.5 }}
            />
          ))}
        </Tabs>

        {/* Canva ao criar: checando app OAuth → spinner; com app → 1-clique; sem app → token manual. */}
        {provider === "canva" && !isEdit && canvaConfigured === null ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">Verificando integração do Canva…</Typography>
          </Stack>
        ) : canvaOAuthMode ? (
          <Box>
            <Alert severity="success" sx={{ mb: 2 }} icon={<InfoOutlinedIcon />}>
              <Typography variant="caption">
                App OAuth do Canva configurado. Conecte com 1 clique — você será levado ao Canva para autorizar
                o acesso aos seus designs e voltará automaticamente ao portal.
              </Typography>
            </Alert>
            <Button
              variant="contained" fullWidth onClick={handleCanvaOAuth} disabled={oauthLoading}
              // Fundo Canva escurecido + texto branco explícito para contraste AA (o cyan claro
              // #00C4CC com texto branco herdado ficava ~2:1). Regra de ouro: texto claro → fundo escuro.
              sx={{ bgcolor: "#008E95", color: "#fff", "&:hover": { bgcolor: "#00787E" } }}
              startIcon={oauthLoading ? <CircularProgress size={14} color="inherit" /> : <span>🖌️</span>}
            >
              {oauthLoading ? "Redirecionando…" : "Conectar com Canva"}
            </Button>
          </Box>
        ) : (
          <>
            {meta.note && (
              <Alert severity="info" sx={{ mb: 2 }} icon={<InfoOutlinedIcon />}>
                <Typography variant="caption">{meta.note}</Typography>
              </Alert>
            )}

            <Stack spacing={1.5}>
              {meta.fields.map((f) => (
                <TextField
                  key={f.key}
                  label={f.label + (f.required ? " *" : "")}
                  placeholder={isEdit && slot?.provider === provider ? "(manter atual — deixe em branco)" : f.placeholder}
                  type={f.secret ? "password" : "text"}
                  size="small"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  helperText={f.helperText ?? (isEdit ? "Deixe em branco para manter o valor atual" : undefined)}
                  fullWidth
                />
              ))}
            </Stack>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button variant="outlined" onClick={onClose} disabled={saving || oauthLoading}>Cancelar</Button>
        {/* No modo OAuth 1-clique a ação é o botão "Conectar com Canva"; não há o que salvar.
            Enquanto o config do Canva ainda carrega (só o spinner à mostra), também não há campo. */}
        {!canvaOAuthMode && !(provider === "canva" && !isEdit && canvaConfigured === null) && (
          <Button variant="contained" onClick={handleSave} disabled={saving}
            startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

interface CardProps {
  slot: UiuxConnection;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  deleting: boolean;
  testing: boolean;
}

function UiuxConnectionCard({ slot, onEdit, onDelete, onTest, deleting, testing }: CardProps) {
  const meta = PROVIDER_META[slot.provider];
  return (
    <Card variant="outlined" sx={{ borderColor: meta.color + "55", borderLeft: `4px solid ${meta.color}` }}>
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography sx={{ fontSize: "1rem" }}>{meta.icon}</Typography>
              <Typography variant="body2" fontWeight={600}>{meta.label}</Typography>
              {slot.label && <Typography variant="caption" color="text.secondary">— {slot.label}</Typography>}
              {slot.accountRef && (
                <Chip label={`ref: ${slot.accountRef}`} size="small" variant="outlined" sx={{ fontSize: "0.65rem", height: 18 }} />
              )}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
              <CheckCircleIcon sx={{ fontSize: "0.75rem", color: "success.main" }} />
              <Typography variant="caption" color="success.main">Credenciais configuradas</Typography>
            </Stack>
          </Box>
          <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
            <Tooltip title="Testar credenciais">
              <IconButton size="small" onClick={onTest} disabled={testing}>
                {testing ? <CircularProgress size={14} /> : <VerifiedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Editar">
              <IconButton size="small" onClick={onEdit}><EditIcon fontSize="small" /></IconButton>
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

function UiuxSettingsPageInner() {
  const tenantId = tenantScopeStore.effectiveTenantId;
  const [slots, setSlots] = useState<UiuxConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalMsg, setGlobalMsg] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editSlot, setEditSlot] = useState<UiuxConnection | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const MAX_SLOTS = 6;

  const load = useCallback(async () => {
    try {
      const res = await apiGet(withQuery("/api/tenant/uiux-connections", { tenantId })) as UiuxConnection[];
      setSlots(Array.isArray(res) ? res : []);
    } catch {
      setGlobalMsg({ type: "error", text: "Não foi possível carregar as conexões." });
    } finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  // Retorno do callback OAuth do Canva: ?canva=connected|error[&reason=...]. Mostra feedback,
  // limpa a query da URL (sem recarregar) e recarrega a lista quando conectou.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const canva = params.get("canva");
    if (!canva) return;
    const reason = params.get("reason");
    const REASONS: Record<string, string> = {
      denied: "Autorização cancelada no Canva.",
      missing_params: "Retorno do Canva incompleto.",
      not_configured: "App OAuth do Canva não configurado.",
      invalid_state: "Sessão de autorização inválida ou já usada.",
      expired_state: "Sessão de autorização expirada — tente novamente.",
      slot_limit: "Máximo de conexões UI/UX atingido.",
      exchange_failed: "Falha ao concluir a autorização com o Canva.",
    };
    if (canva === "connected") {
      setGlobalMsg({ type: "success", text: "Canva conectado com sucesso." });
      void load();
    } else {
      setGlobalMsg({ type: "error", text: (reason && REASONS[reason]) || "Não foi possível conectar o Canva." });
    }
    params.delete("canva"); params.delete("reason");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }, [load]);

  const handleDelete = async (slot: UiuxConnection) => {
    const displayName = slot.label ?? PROVIDER_META[slot.provider].label;
    if (!confirm(`Remover a conexão "${displayName}"?`)) return;
    setDeletingId(slot.id);
    try {
      await apiDelete(withQuery(`/api/tenant/uiux-connections/${slot.id}`, { tenantId }));
      await load();
    } catch {
      setGlobalMsg({ type: "error", text: "Erro ao remover." });
    } finally { setDeletingId(null); }
  };

  const handleTest = async (slot: UiuxConnection) => {
    setTestingId(slot.id);
    try {
      const res = await apiPost(withQuery(`/api/tenant/uiux-connections/${slot.id}/test`, { tenantId }), {}) as { ok: boolean; message: string };
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
      <Stack direction="row" alignItems="flex-start" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
        <DesignServicesIcon sx={{ color: "primary.main", fontSize: 28, mt: 0.25 }} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h5" fontWeight={700}>Ferramentas UI/UX</Typography>
          <Typography variant="body2" color="text.secondary">
            Conecte contas de ferramentas de design (Figma, Canva). No formulário de spec, escolha uma conta
            e os projetos que fazem parte da spec — o Genesis extrai as definições e gera um documento UI/UX
            especializado (descrições macro e micro dos objetos).
          </Typography>
        </Box>
        <Box sx={{ flexShrink: 0 }}>
          <Button variant="contained" startIcon={<AddIcon />}
            onClick={() => { setEditSlot(null); setModalOpen(true); }}
            disabled={slots.length >= MAX_SLOTS}>
            Conectar
          </Button>
        </Box>
      </Stack>

      {globalMsg && (
        <Alert severity={globalMsg.type} sx={{ mb: 2 }} onClose={() => setGlobalMsg(null)}>{globalMsg.text}</Alert>
      )}

      {slots.length === 0 ? (
        <Card variant="outlined" sx={{ textAlign: "center", py: 6, borderStyle: "dashed" }}>
          <CardContent>
            <DesignServicesIcon sx={{ fontSize: 48, color: "text.disabled", mb: 1 }} />
            <Typography variant="body1" color="text.secondary" fontWeight={500}>Nenhuma ferramenta conectada</Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
              Conecte Figma ou Canva para extrair definições de UI/UX nas specs
            </Typography>
            <Button variant="contained" startIcon={<AddIcon />}
              onClick={() => { setEditSlot(null); setModalOpen(true); }}>
              Conectar primeira ferramenta
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {slots.map((slot) => (
            <UiuxConnectionCard
              key={slot.id}
              slot={slot}
              onEdit={() => { setEditSlot(slot); setModalOpen(true); }}
              onDelete={() => handleDelete(slot)}
              onTest={() => handleTest(slot)}
              deleting={deletingId === slot.id}
              testing={testingId === slot.id}
            />
          ))}
        </Stack>
      )}

      {slots.length > 0 && (
        <Alert severity="info" sx={{ mt: 3 }} icon={<InfoOutlinedIcon />}>
          <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>Como funciona</Typography>
          <Stack spacing={0.5}>
            {[
              "1. Credenciais salvas criptografadas com AES-256-GCM",
              "2. No form de spec, escolha uma conta conectada e um ou mais projetos",
              "3. O Genesis lê a estrutura de design (páginas, telas, componentes, textos)",
              "4. Um arquivo de spec UI/UX é gerado com descrições macro e micro dos objetos",
              "5. Esse documento entra no bundle da spec e guia o build",
            ].map((s) => (
              <Typography key={s} variant="caption" color="text.secondary">{s}</Typography>
            ))}
          </Stack>
        </Alert>
      )}

      <UiuxModal
        open={modalOpen}
        slot={editSlot}
        tenantId={tenantId}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </Box>
  );
}

export default observer(UiuxSettingsPageInner);
