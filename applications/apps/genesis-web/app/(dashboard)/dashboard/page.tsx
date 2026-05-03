"use client";

import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import FolderIcon from "@mui/icons-material/Folder";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import SendIcon from "@mui/icons-material/Send";
import LinearProgress from "@mui/material/LinearProgress";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";
import type { Project } from "@/types";

// Percentual real de progresso — usa task counts quando disponível (projeto em execução)
function projectPercent(p: Project): number {
  if (p.status === "completed" || p.status === "accepted") return 100;
  if (p.status === "failed" || p.status === "stopped") return 0;
  if (p.status === "running" && p.taskCount && p.taskCount > 0) {
    return Math.round(15 + ((p.taskDoneCount ?? 0) / p.taskCount) * 70);
  }
  const phaseMap: Record<string, number> = {
    draft: 0, spec_submitted: 10, pending_conversion: 18,
    cto_charter: 25, pm_backlog: 38, running: 50,
  };
  return phaseMap[p.status] ?? 0;
}

const MotionCard = motion(Card);
const MotionBox  = motion(Box);

const fadeUp = (i: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { delay: i * 0.07, duration: 0.35 } },
});

// ── Stat card ────────────────────────────────────────────────────────────────
interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  gradient: string;
  delay?: number;
}

function StatCard({ label, value, icon, gradient, delay = 0 }: StatCardProps) {
  return (
    <MotionCard
      {...fadeUp(delay)}
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      sx={{ overflow: "hidden", position: "relative" }}
    >
      {/* Gradient accent top */}
      <Box sx={{ height: 3, background: gradient }} />
      <CardContent sx={{ pt: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {label}
            </Typography>
            <Typography variant="h4" fontWeight={700} sx={{ mt: 0.5, lineHeight: 1 }}>
              {value}
            </Typography>
          </Box>
          <Box
            sx={{
              width: 40, height: 40, borderRadius: "10px",
              background: gradient + "22",
              display: "flex", alignItems: "center", justifyContent: "center",
              "& svg": { fontSize: "1.25rem" },
            }}
          >
            {icon}
          </Box>
        </Stack>
      </CardContent>
    </MotionCard>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────
function statusLabel(s: string) {
  const map: Record<string, string> = {
    running: "Em execução", completed: "Concluído", accepted: "Aceito",
    failed: "Falhou", stopped: "Parado", draft: "Rascunho",
    spec_submitted: "Spec enviada", cto_charter: "Charter", pm_backlog: "Backlog",
  };
  return map[s] ?? s;
}
function statusColor(s: string): "default" | "success" | "error" | "info" | "warning" {
  if (s === "completed" || s === "accepted") return "success";
  if (s === "failed" || s === "stopped")     return "error";
  if (s === "running")                        return "info";
  if (s === "cto_charter" || s === "pm_backlog" || s === "spec_submitted") return "warning";
  return "default";
}

// ── Recent project row ────────────────────────────────────────────────────────
function RecentRow({ project, onClick }: { project: Project; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: "flex", alignItems: "center", gap: 2, px: 2, py: 1.25,
        borderRadius: 1, cursor: "pointer", transition: "background 0.15s",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box
        sx={{
          width: 32, height: 32, borderRadius: "8px",
          background: project.status === "running" ? "#6366F122" : project.status === "completed" || project.status === "accepted" ? "#10B98122" : "#8B949E22",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}
      >
        {project.status === "running" ? (
          <PlayArrowIcon sx={{ fontSize: "0.9rem", color: "#6366F1" }} />
        ) : project.status === "completed" || project.status === "accepted" ? (
          <CheckCircleIcon sx={{ fontSize: "0.9rem", color: "#10B981" }} />
        ) : project.status === "failed" ? (
          <ErrorIcon sx={{ fontSize: "0.9rem", color: "#EF4444" }} />
        ) : (
          <FolderIcon sx={{ fontSize: "0.9rem", color: "#8B949E" }} />
        )}
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500} noWrap>{project.title ?? "Sem título"}</Typography>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.25 }}>
          {project.status === "running" ? (
            <>
              <LinearProgress
                variant="determinate"
                value={projectPercent(project)}
                sx={{ flexGrow: 1, height: 3, borderRadius: 2, bgcolor: "divider" }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, fontSize: "0.62rem" }}>
                {project.taskDoneCount != null && project.taskCount
                  ? `${project.taskDoneCount}/${project.taskCount}`
                  : `${projectPercent(project)}%`}
              </Typography>
            </>
          ) : (
            <Typography variant="caption" color="text.secondary">
              {new Date(project.updatedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
            </Typography>
          )}
        </Stack>
      </Box>
      <Chip label={statusLabel(project.status)} size="small" color={statusColor(project.status)} />
    </Box>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
function DashboardPageInner() {
  const router   = useRouter();
  const projects = projectsStore.list;

  const active    = projects.filter((p) => p.status === "running").length;
  const completed = projects.filter((p) => p.status === "completed" || p.status === "accepted").length;
  const failed    = projects.filter((p) => p.status === "failed").length;
  const total     = projects.length;

  const recent = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  useEffect(() => { projectsStore.loadProjects(); }, []);

  const hour   = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";

  return (
    <Box>
      {/* ── Header ── */}
      <MotionBox {...fadeUp(0)} sx={{ mb: 3 }}>
        <Typography variant="h4" gutterBottom>
          {greeting}, {authStore.user?.name?.split(" ")[0] ?? ""}
        </Typography>
        <Typography color="text.secondary" variant="body2">
          {authStore.tenant
            ? `${authStore.tenant.name} · Plano ${authStore.tenant.plan.name}`
            : "Painel de controle Genesis"}
        </Typography>
      </MotionBox>

      {/* ── Stat cards ── */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Total de projetos" value={total} delay={1}
            icon={<FolderIcon sx={{ color: "#6366F1" }} />}
            gradient="linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Em execução" value={active} delay={2}
            icon={<PlayArrowIcon sx={{ color: "#10B981" }} />}
            gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Concluídos" value={completed} delay={3}
            icon={<CheckCircleIcon sx={{ color: "#F59E0B" }} />}
            gradient="linear-gradient(135deg, #F59E0B 0%, #D97706 100%)"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Com falha" value={failed} delay={4}
            icon={<ErrorIcon sx={{ color: "#EF4444" }} />}
            gradient="linear-gradient(135deg, #EF4444 0%, #DC2626 100%)"
          />
        </Grid>
      </Grid>

      {/* ── Main content ── */}
      <Grid container spacing={2}>
        {/* Recent projects */}
        <Grid size={{ xs: 12, md: 7 }}>
          <MotionCard {...fadeUp(5)}>
            <CardContent sx={{ pb: "0 !important" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0, pb: 1 }}>
                <Typography variant="subtitle1">Atividade recente</Typography>
                <Button size="small" endIcon={<ArrowForwardIcon />} onClick={() => router.push("/projects")}>
                  Ver todos
                </Button>
              </Stack>
            </CardContent>
            <Box sx={{ pb: 1 }}>
              {projectsStore.loading && (
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>Carregando…</Typography>
              )}
              {!projectsStore.loading && recent.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
                  Nenhum projeto ainda.
                </Typography>
              )}
              {recent.map((p) => (
                <RecentRow key={p.id} project={p} onClick={() => router.push(`/projects/${p.id}`)} />
              ))}
            </Box>
          </MotionCard>
        </Grid>

        {/* Quick actions */}
        <Grid size={{ xs: 12, md: 5 }}>
          <MotionCard {...fadeUp(6)} sx={{ height: "100%" }}>
            <CardContent>
              <Typography variant="subtitle1" gutterBottom>Ações rápidas</Typography>
              <Stack spacing={1.5} sx={{ mt: 1 }}>
                <Button
                  variant="contained" fullWidth startIcon={<SendIcon />}
                  onClick={() => router.push("/spec")}
                  sx={{ justifyContent: "flex-start", py: 1.25 }}
                >
                  Enviar nova spec
                </Button>
                <Button
                  variant="outlined" fullWidth startIcon={<FolderIcon />}
                  onClick={() => router.push("/projects")}
                  sx={{ justifyContent: "flex-start", py: 1.25 }}
                >
                  Ver meus projetos
                </Button>
                {active > 0 && (
                  <Box
                    sx={{
                      mt: 1, p: 1.5, borderRadius: 1,
                      background: "#10B98112",
                      border: "1px solid #10B98130",
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box
                        sx={{
                          width: 8, height: 8, borderRadius: "50%",
                          background: "#10B981",
                          animation: "pulse 1.5s infinite",
                          "@keyframes pulse": {
                            "0%, 100%": { opacity: 1 },
                            "50%": { opacity: 0.4 },
                          },
                        }}
                      />
                      <Typography variant="body2" color="success.main" fontWeight={500}>
                        {active} pipeline{active > 1 ? "s" : ""} em execução
                      </Typography>
                    </Stack>
                  </Box>
                )}
              </Stack>

              {/* Genesis branding */}
              <Box
                sx={{
                  mt: 3, p: 2, borderRadius: 1.5,
                  background: "linear-gradient(135deg, #6366F115 0%, #4F46E510 100%)",
                  border: "1px solid #6366F130",
                  textAlign: "center",
                }}
              >
                <AutoAwesomeIcon sx={{ color: "#6366F1", mb: 0.5 }} />
                <Typography variant="body2" fontWeight={600} color="primary">
                  Zentriz Genesis
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  AI-native software factory
                </Typography>
              </Box>
            </CardContent>
          </MotionCard>
        </Grid>
      </Grid>
    </Box>
  );
}

export default observer(DashboardPageInner);
