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
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CodeIcon from "@mui/icons-material/Code";
import LockIcon from "@mui/icons-material/Lock";
import PsychologyAltIcon from "@mui/icons-material/PsychologyAlt";
import VisibilityIcon from "@mui/icons-material/Visibility";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { apiGet, apiPatch } from "@/lib/api";
import { authStore } from "@/stores/authStore";

interface Skill {
  id: string;
  slug: string;
  role: string;
  category: string;
  stack_key: string;
  domain: string | null;
  title: string;
  body_md: string;
  hard_rule: boolean;
  source: string;
  status: string;
  ttl_days: number | null;
  use_count: number;
  quality_score: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const ROLES = ["dev", "qa", "pm", "devops", "engineer", "cto", "cyborg"];
const STATUSES = ["trusted", "shadow", "draft", "deprecated"];

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  trusted:    { label: "Trusted",     color: "#10B981", icon: <CheckCircleOutlineIcon fontSize="small" /> },
  shadow:     { label: "Shadow",      color: "#F59E0B", icon: <WarningAmberIcon fontSize="small" /> },
  draft:      { label: "Draft",       color: "#6B7280", icon: <PsychologyAltIcon fontSize="small" /> },
  deprecated: { label: "Deprecated",  color: "#EF4444", icon: <BlockIcon fontSize="small" /> },
};

const ROLE_COLORS: Record<string, string> = {
  dev: "#3B82F6", qa: "#8B5CF6", pm: "#F97316",
  devops: "#10B981", engineer: "#6366F1", cto: "#EC4899", cyborg: "#14B8A6",
};

export default observer(function SkillsPage() {
  const [skills, setSkills]           = useState<Skill[]>([]);
  const [loading, setLoading]         = useState(true);
  const [roleFilter, setRoleFilter]   = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [viewOpen, setViewOpen]       = useState(false);
  const [globalAlert, setGlobalAlert] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [updating, setUpdating]       = useState<string | null>(null);

  const isAdmin = authStore.isZentrizAdmin || authStore.isTenantAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (roleFilter !== "all")   params.set("role",   roleFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const data = await apiGet(`/api/skills?${params}`) as { data: Skill[] };
      setSkills(data.data ?? []);
    } catch {
      setGlobalAlert({ type: "error", msg: "Erro ao carregar skills." });
    } finally {
      setLoading(false);
    }
  }, [roleFilter, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const updateStatus = async (skill: Skill, newStatus: string) => {
    if (skill.hard_rule && newStatus === "deprecated") {
      setGlobalAlert({ type: "error", msg: "hard_rule skills não podem ser deprecadas pela UI." });
      return;
    }
    setUpdating(skill.id);
    try {
      await apiPatch(`/api/skills/${skill.id}`, { status: newStatus });
      setGlobalAlert({ type: "success", msg: `Skill "${skill.title}" atualizada para ${newStatus}.` });
      await load();
    } catch {
      setGlobalAlert({ type: "error", msg: "Erro ao atualizar skill." });
    } finally {
      setUpdating(null);
    }
  };

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, s) => {
    const key = s.role;
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  const totalTrusted    = skills.filter((s) => s.status === "trusted").length;
  const totalShadow     = skills.filter((s) => s.status === "shadow").length;
  const totalHardRule   = skills.filter((s) => s.hard_rule).length;
  const totalDeprecated = skills.filter((s) => s.status === "deprecated").length;

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={1.5} mb={3}>
        <AutoAwesomeIcon sx={{ color: "#3B82F6", fontSize: 28 }} />
        <Box>
          <Typography variant="h5" fontWeight={700}>Skill Store</Typography>
          <Typography variant="body2" color="text.secondary">
            Fragmentos de conhecimento dos agentes — montagem dinâmica de SYSTEM_PROMPTs
          </Typography>
        </Box>
      </Stack>

      {globalAlert && (
        <Alert
          severity={globalAlert.type}
          onClose={() => setGlobalAlert(null)}
          sx={{ mb: 2 }}
        >
          {globalAlert.msg}
        </Alert>
      )}

      {/* Métricas resumo */}
      <Stack direction="row" spacing={2} mb={3} flexWrap="wrap">
        {[
          { label: "Trusted",    count: totalTrusted,    color: "#10B981" },
          { label: "Shadow",     count: totalShadow,     color: "#F59E0B" },
          { label: "Hard Rules", count: totalHardRule,   color: "#EF4444" },
          { label: "Deprecated", count: totalDeprecated, color: "#6B7280" },
        ].map((m) => (
          <Card key={m.label} sx={{ minWidth: 120, border: `1px solid ${m.color}22` }}>
            <CardContent sx={{ p: "12px 16px !important" }}>
              <Typography variant="h6" fontWeight={700} color={m.color}>{m.count}</Typography>
              <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            </CardContent>
          </Card>
        ))}
      </Stack>

      {/* Filtros */}
      <Stack direction="row" spacing={2} mb={3} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Role</InputLabel>
          <Select value={roleFilter} label="Role" onChange={(e) => setRoleFilter(e.target.value)}>
            <MenuItem value="all">Todos</MenuItem>
            {ROLES.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Status</InputLabel>
          <Select value={statusFilter} label="Status" onChange={(e) => setStatusFilter(e.target.value)}>
            <MenuItem value="all">Todos</MenuItem>
            {STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="outlined" size="small" onClick={load} disabled={loading}>
          Atualizar
        </Button>
      </Stack>

      {/* Lista agrupada por role */}
      {loading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress /></Box>
      ) : (
        <Stack spacing={3}>
          {Object.entries(grouped).sort().map(([role, roleSkills]) => (
            <Card key={role} variant="outlined">
              <CardContent>
                <Stack direction="row" alignItems="center" spacing={1} mb={2}>
                  <Chip
                    label={role.toUpperCase()}
                    size="small"
                    sx={{ bgcolor: ROLE_COLORS[role] ?? "#6B7280", color: "#fff", fontWeight: 700 }}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {roleSkills.length} skill{roleSkills.length !== 1 ? "s" : ""}
                  </Typography>
                </Stack>

                <Stack spacing={1}>
                  {roleSkills.map((skill) => {
                    const sc = STATUS_CONFIG[skill.status] ?? STATUS_CONFIG.draft;
                    return (
                      <Box
                        key={skill.id}
                        sx={{
                          p: 1.5,
                          borderRadius: 1,
                          border: "1px solid",
                          borderColor: skill.hard_rule ? "#EF444433" : "divider",
                          bgcolor: skill.hard_rule ? "#EF444408" : "background.paper",
                          display: "flex",
                          alignItems: "center",
                          gap: 1.5,
                          flexWrap: "wrap",
                        }}
                      >
                        {/* Status + hard rule */}
                        <Stack direction="row" spacing={0.5} alignItems="center" flexShrink={0}>
                          <Tooltip title={sc.label}>
                            <Box sx={{ color: sc.color, display: "flex", alignItems: "center" }}>
                              {sc.icon}
                            </Box>
                          </Tooltip>
                          {skill.hard_rule && (
                            <Tooltip title="Hard Rule — imune a TTL e LLM acquisition">
                              <LockIcon fontSize="small" sx={{ color: "#EF4444" }} />
                            </Tooltip>
                          )}
                        </Stack>

                        {/* Título + slug */}
                        <Box flex={1} minWidth={200}>
                          <Typography variant="body2" fontWeight={600}>{skill.title}</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                            {skill.slug}
                          </Typography>
                        </Box>

                        {/* stack_key */}
                        <Chip
                          label={skill.stack_key}
                          size="small"
                          variant="outlined"
                          sx={{ fontFamily: "monospace", fontSize: 11 }}
                        />

                        {/* Métricas */}
                        <Stack direction="row" spacing={1} alignItems="center" flexShrink={0}>
                          <Tooltip title="Uso total">
                            <Typography variant="caption" color="text.secondary">
                              {skill.use_count}×
                            </Typography>
                          </Tooltip>
                          <Tooltip title={`Quality score: ${(skill.quality_score * 100).toFixed(0)}%`}>
                            <Box
                              sx={{
                                width: 36, height: 6, borderRadius: 3,
                                bgcolor: "#E5E7EB",
                                overflow: "hidden",
                              }}
                            >
                              <Box
                                sx={{
                                  width: `${skill.quality_score * 100}%`,
                                  height: "100%",
                                  bgcolor: skill.quality_score > 0.6 ? "#10B981" :
                                           skill.quality_score > 0.3 ? "#F59E0B" : "#EF4444",
                                }}
                              />
                            </Box>
                          </Tooltip>
                        </Stack>

                        {/* Ações */}
                        <Stack direction="row" spacing={0.5} flexShrink={0}>
                          <Tooltip title="Ver body_md">
                            <IconButton
                              size="small"
                              onClick={() => { setSelectedSkill(skill); setViewOpen(true); }}
                            >
                              <VisibilityIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          {isAdmin && !skill.hard_rule && (
                            <>
                              {skill.status === "shadow" && (
                                <Tooltip title="Promover para trusted">
                                  <IconButton
                                    size="small"
                                    disabled={updating === skill.id}
                                    onClick={() => updateStatus(skill, "trusted")}
                                    sx={{ color: "#10B981" }}
                                  >
                                    <CheckCircleOutlineIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              )}
                              {skill.status === "trusted" && (
                                <Tooltip title="Deprecar skill">
                                  <IconButton
                                    size="small"
                                    disabled={updating === skill.id}
                                    onClick={() => updateStatus(skill, "deprecated")}
                                    sx={{ color: "#EF4444" }}
                                  >
                                    <BlockIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              )}
                              {skill.status === "deprecated" && (
                                <Tooltip title="Restaurar para trusted">
                                  <IconButton
                                    size="small"
                                    disabled={updating === skill.id}
                                    onClick={() => updateStatus(skill, "trusted")}
                                    sx={{ color: "#6B7280" }}
                                  >
                                    <CheckCircleOutlineIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              )}
                            </>
                          )}
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              </CardContent>
            </Card>
          ))}

          {Object.keys(grouped).length === 0 && (
            <Box textAlign="center" py={6}>
              <CodeIcon sx={{ fontSize: 48, color: "text.disabled" }} />
              <Typography color="text.secondary" mt={1}>
                Nenhuma skill encontrada. Rode <code>skill_store_seed.py</code> para popular.
              </Typography>
            </Box>
          )}
        </Stack>
      )}

      {/* Modal de visualização do body_md */}
      <Dialog open={viewOpen} onClose={() => setViewOpen(false)} maxWidth="md" fullWidth>
        {selectedSkill && (
          <>
            <DialogTitle>
              <Stack direction="row" spacing={1} alignItems="center">
                <CodeIcon />
                <Box>
                  <Typography variant="subtitle1" fontWeight={700}>{selectedSkill.title}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                    {selectedSkill.slug} · {selectedSkill.role}/{selectedSkill.stack_key}
                  </Typography>
                </Box>
                {selectedSkill.hard_rule && (
                  <Chip label="hard_rule" size="small" color="error" icon={<LockIcon />} />
                )}
              </Stack>
            </DialogTitle>
            <Divider />
            <DialogContent>
              <Stack direction="row" spacing={1} mb={2} flexWrap="wrap">
                <Chip label={`status: ${selectedSkill.status}`} size="small"
                      sx={{ bgcolor: STATUS_CONFIG[selectedSkill.status]?.color ?? "#6B7280", color: "#fff" }} />
                <Chip label={`source: ${selectedSkill.source}`} size="small" variant="outlined" />
                <Chip label={`uso: ${selectedSkill.use_count}×`} size="small" variant="outlined" />
                <Chip label={`score: ${(selectedSkill.quality_score * 100).toFixed(0)}%`} size="small" variant="outlined" />
                {selectedSkill.ttl_days && (
                  <Chip label={`TTL: ${selectedSkill.ttl_days}d`} size="small" variant="outlined" />
                )}
              </Stack>
              <Box
                component="pre"
                sx={{
                  p: 2, bgcolor: "#0F172A", color: "#E2E8F0",
                  borderRadius: 1, fontSize: 12,
                  fontFamily: "monospace", whiteSpace: "pre-wrap",
                  maxHeight: 480, overflow: "auto",
                }}
              >
                {selectedSkill.body_md}
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setViewOpen(false)}>Fechar</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
});
