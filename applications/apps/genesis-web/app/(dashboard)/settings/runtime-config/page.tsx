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
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RestoreIcon from "@mui/icons-material/Restore";
import SaveIcon from "@mui/icons-material/Save";
import TuneIcon from "@mui/icons-material/Tune";
import { apiGet, apiPut, apiDelete } from "@/lib/api";
import { authStore } from "@/stores/authStore";

interface ConfigItem {
  key:            string;
  label:          string;
  group:          string;
  unit:           string;
  min:            number;
  max:            number;
  globalValue:    string | null;
  tenantValue:    string | null;
  effectiveValue: string | null;
  description:    string | null;
  hasOverride:    boolean;
  updatedAt:      string | null;
}

const GROUP_LABELS: Record<string, { label: string; color: string }> = {
  timeouts: { label: "Timeouts por Agente",      color: "#F97316" },
  limits:   { label: "Limites de Iteração",       color: "#8B5CF6" },
  tokens:   { label: "Limites de Tokens (LLM)",   color: "#3B82F6" },
};

export default observer(function RuntimeConfigPage() {
  const [configs, setConfigs]   = useState<ConfigItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState<Record<string, boolean>>({});
  const [values, setValues]     = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, { type: "success" | "error"; msg: string }>>({});
  const [globalAlert, setGlobalAlert] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const isAdmin = authStore.isZentrizAdmin || authStore.isTenantAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<ConfigItem[]>("/api/admin/runtime-config");
      setConfigs(data);
      // Inicializar values com o valor efetivo atual
      const init: Record<string, string> = {};
      for (const c of data) {
        init[c.key] = c.effectiveValue ?? c.globalValue ?? "";
      }
      setValues(init);
    } catch {
      setGlobalAlert({ type: "error", msg: "Erro ao carregar configurações." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(item: ConfigItem) {
    const val = values[item.key];
    if (!val) return;
    setSaving((s) => ({ ...s, [item.key]: true }));
    setFeedback((f) => ({ ...f, [item.key]: { type: "success", msg: "" } }));
    try {
      await apiPut(`/api/admin/runtime-config/${item.key}`, { value: val });
      setFeedback((f) => ({ ...f, [item.key]: { type: "success", msg: "Salvo!" } }));
      await load();
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? "Erro ao salvar";
      setFeedback((f) => ({ ...f, [item.key]: { type: "error", msg } }));
    } finally {
      setSaving((s) => ({ ...s, [item.key]: false }));
    }
  }

  async function handleRestore(item: ConfigItem) {
    setSaving((s) => ({ ...s, [item.key]: true }));
    try {
      await apiDelete(`/api/admin/runtime-config/${item.key}`);
      setFeedback((f) => ({ ...f, [item.key]: { type: "success", msg: "Restaurado para padrão global!" } }));
      await load();
    } catch {
      setFeedback((f) => ({ ...f, [item.key]: { type: "error", msg: "Erro ao restaurar" } }));
    } finally {
      setSaving((s) => ({ ...s, [item.key]: false }));
    }
  }

  function handleSlider(key: string, val: number) {
    setValues((v) => ({ ...v, [key]: String(val) }));
    setFeedback((f) => ({ ...f, [key]: { type: "success", msg: "" } }));
  }

  function handleInput(key: string, val: string) {
    setValues((v) => ({ ...v, [key]: val }));
    setFeedback((f) => ({ ...f, [key]: { type: "success", msg: "" } }));
  }

  if (!isAdmin) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="warning">Apenas administradores podem acessar esta página.</Alert>
      </Box>
    );
  }

  // Agrupar configs por group
  const grouped = configs.reduce<Record<string, ConfigItem[]>>((acc, c) => {
    if (!acc[c.group]) acc[c.group] = [];
    acc[c.group].push(c);
    return acc;
  }, {});

  return (
    <Box sx={{ maxWidth: 860, mx: "auto", p: { xs: 2, md: 4 } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} mb={3}>
        <TuneIcon sx={{ color: "#F97316", fontSize: 28 }} />
        <Typography variant="h5" fontWeight={700}>Runtime Config</Typography>
        <Chip
          label={authStore.isZentrizAdmin ? "Global (zentriz_admin)" : "Override do seu tenant"}
          size="small"
          sx={{ bgcolor: authStore.isZentrizAdmin ? "#F97316" : "#6366F1", color: "#fff" }}
        />
      </Stack>

      <Alert severity="info" sx={{ mb: 3 }}>
        {authStore.isZentrizAdmin
          ? "Você está editando os valores globais. Tenants sem override herdam estes valores."
          : "Você pode sobrescrever valores globais para o seu tenant. Deixe no padrão para herdar o global."}
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
      ) : (
        <Stack spacing={3}>
          {Object.entries(GROUP_LABELS).map(([groupKey, groupMeta]) => {
            const items = grouped[groupKey] ?? [];
            if (!items.length) return null;
            return (
              <Card key={groupKey} variant="outlined">
                <CardContent>
                  <Typography
                    variant="subtitle1"
                    fontWeight={700}
                    mb={2}
                    sx={{ color: groupMeta.color, display: "flex", alignItems: "center", gap: 1 }}
                  >
                    {groupMeta.label}
                  </Typography>
                  <Stack spacing={3} divider={<Divider />}>
                    {items.map((item) => {
                      const currentVal = Number(values[item.key] ?? item.effectiveValue ?? item.globalValue ?? item.min);
                      const isDirty    = String(currentVal) !== (item.hasOverride ? item.tenantValue : item.globalValue);
                      const fb         = feedback[item.key];
                      const isSaving   = saving[item.key];

                      return (
                        <Box key={item.key}>
                          <Stack direction="row" alignItems="center" spacing={1} mb={0.5}>
                            <Typography variant="body2" fontWeight={600}>{item.label}</Typography>
                            {item.description && (
                              <Tooltip title={item.description} arrow placement="right">
                                <InfoOutlinedIcon sx={{ fontSize: 16, color: "text.secondary", cursor: "help" }} />
                              </Tooltip>
                            )}
                            {item.hasOverride && (
                              <Chip label="override" size="small" sx={{ bgcolor: "#6366F1", color: "#fff", fontSize: 10 }} />
                            )}
                          </Stack>

                          <Stack direction={{ xs: "column", sm: "row" }} alignItems="center" spacing={2}>
                            {/* Slider */}
                            <Box sx={{ flex: 1, px: 1 }}>
                              <Slider
                                value={currentVal}
                                min={item.min}
                                max={item.max}
                                step={item.group === "timeouts" ? 30 : item.group === "tokens" ? 1000 : 1}
                                onChange={(_, v) => handleSlider(item.key, v as number)}
                                valueLabelDisplay="auto"
                                valueLabelFormat={(v) => `${v}${item.unit}`}
                                disabled={isSaving}
                                sx={{ color: groupMeta.color }}
                              />
                            </Box>

                            {/* Input numérico */}
                            <TextField
                              size="small"
                              type="number"
                              value={values[item.key] ?? ""}
                              onChange={(e) => handleInput(item.key, e.target.value)}
                              InputProps={{
                                endAdornment: item.unit
                                  ? <InputAdornment position="end">{item.unit}</InputAdornment>
                                  : undefined,
                              }}
                              inputProps={{ min: item.min, max: item.max }}
                              sx={{ width: 120 }}
                              disabled={isSaving}
                            />

                            {/* Botão Salvar */}
                            <Button
                              variant="contained"
                              size="small"
                              startIcon={isSaving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
                              onClick={() => handleSave(item)}
                              disabled={isSaving || !isDirty}
                              sx={{ bgcolor: groupMeta.color, "&:hover": { bgcolor: groupMeta.color, opacity: 0.85 }, minWidth: 90 }}
                            >
                              Salvar
                            </Button>

                            {/* Restaurar para global (só se tiver override e for tenant_admin, ou zentriz_admin restaurando override) */}
                            {item.hasOverride && (
                              <Tooltip title={`Restaurar global: ${item.globalValue}${item.unit}`}>
                                <span>
                                  <IconButton
                                    size="small"
                                    onClick={() => handleRestore(item)}
                                    disabled={isSaving}
                                    color="default"
                                  >
                                    <RestoreIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            )}
                          </Stack>

                          {/* Linha de referência */}
                          <Stack direction="row" spacing={2} mt={0.5}>
                            {item.globalValue && (
                              <Typography variant="caption" color="text.secondary">
                                Global: {item.globalValue}{item.unit}
                              </Typography>
                            )}
                            {item.hasOverride && item.tenantValue && (
                              <Typography variant="caption" sx={{ color: "#6366F1" }}>
                                Override: {item.tenantValue}{item.unit}
                              </Typography>
                            )}
                            {item.updatedAt && (
                              <Typography variant="caption" color="text.secondary">
                                Atualizado: {new Date(item.updatedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                              </Typography>
                            )}
                          </Stack>

                          {fb?.msg && (
                            <Alert severity={fb.type} sx={{ mt: 0.5, py: 0 }}>{fb.msg}</Alert>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
});
