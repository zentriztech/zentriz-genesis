"use client";

import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import FolderIcon from "@mui/icons-material/Folder";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import SendIcon from "@mui/icons-material/Send";
import { authStore } from "@/stores/authStore";
import { projectsStore } from "@/stores/projectsStore";
import { apiGet } from "@/lib/api";
import type { Project, Product } from "@/types";

const MotionCard = motion(Card);
const MotionBox  = motion(Box);
const fadeUp = (i: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { delay: i * 0.06, duration: 0.3 } },
});

// Percentual real: usa task counts quando running
function projectPercent(p: Project): number {
  if (p.status === "completed" || p.status === "accepted") return 100;
  if (p.status === "failed" || p.status === "stopped") return 0;
  if (p.status === "running" && p.taskCount && p.taskCount > 0) {
    return Math.round(15 + ((p.taskDoneCount ?? 0) / p.taskCount) * 70);
  }
  const m: Record<string, number> = {
    draft: 0, spec_submitted: 10, pending_conversion: 18, cto_charter: 25, pm_backlog: 38, running: 45,
  };
  return m[p.status] ?? 0;
}

function productPercent(projects: Project[]): number {
  if (projects.length === 0) return 0;
  const sum = projects.reduce((acc, p) => acc + projectPercent(p), 0);
  return Math.round(sum / projects.length);
}

function statusLabel(s: string) {
  const m: Record<string, string> = {
    running: "em execução", completed: "concluído", accepted: "aceito",
    failed: "falhou", stopped: "parado", draft: "rascunho",
    spec_submitted: "spec enviada", cto_charter: "charter", pm_backlog: "backlog",
  };
  return m[s] ?? s;
}
function statusColor(s: string): "default" | "success" | "error" | "info" | "warning" {
  if (s === "completed" || s === "accepted") return "success";
  if (s === "failed" || s === "stopped")     return "error";
  if (s === "running")                        return "info";
  if (["spec_submitted","cto_charter","pm_backlog"].includes(s)) return "warning";
  return "default";
}

// ── Linha de projeto dentro de um produto ─────────────────────────────────────
function ProductProjectRow({ project, onClick }: { project: Project; onClick: () => void }) {
  const pct = projectPercent(project);
  const isDone = project.status === "completed" || project.status === "accepted";
  const isRun  = project.status === "running";
  const isFail = project.status === "failed" || project.status === "stopped";
  const isPending = !isDone && !isRun && !isFail;

  return (
    <Box
      onClick={onClick}
      sx={{
        display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 0.75,
        cursor: "pointer", transition: "background 0.12s",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {/* Dot indicador */}
      <Box sx={{
        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
        bgcolor: isDone ? "success.main" : isRun ? "info.main" : isFail ? "error.main" : "text.disabled",
        ...(isRun ? {
          animation: "pulse 1.4s ease-in-out infinite",
          "@keyframes pulse": { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.35 } },
        } : {}),
      }} />

      {/* Nome */}
      <Typography variant="caption" sx={{ flexGrow: 1, fontWeight: isRun ? 600 : 400, fontSize: "0.72rem" }} noWrap>
        {project.title}
      </Typography>

      {/* Progresso / status */}
      {isRun ? (
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flexShrink: 0, minWidth: 80 }}>
          <LinearProgress variant="determinate" value={pct}
            sx={{ width: 48, height: 3, borderRadius: 2, bgcolor: "divider" }} />
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.6rem", minWidth: 24, textAlign: "right" }}>
            {project.taskDoneCount != null && project.taskCount
              ? `${project.taskDoneCount}/${project.taskCount}`
              : `${pct}%`}
          </Typography>
        </Stack>
      ) : (
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.6rem", flexShrink: 0, minWidth: 60, textAlign: "right" }}>
          {isDone ? "100%" : isPending ? "—" : `${pct}%`}
        </Typography>
      )}
    </Box>
  );
}

// ── Card de produto ────────────────────────────────────────────────────────────
function ProductCard({ product, projects, delay, onFilter }: {
  product: Product;
  projects: Project[];
  delay: number;
  onFilter: (id: string) => void;
}) {
  const router = useRouter();
  const pct = productPercent(projects);
  const hasRunning = projects.some(p => p.status === "running");
  const allDone = projects.length > 0 && projects.every(p => p.status === "accepted" || p.status === "completed");
  const hasFailed = projects.some(p => p.status === "failed");

  // Projetos ordenados por execution_order (já vem ordenado da API)
  const ordered = [...projects].sort((a, b) => (a.executionOrder ?? 0) - (b.executionOrder ?? 0));

  return (
    <MotionCard {...fadeUp(delay)} sx={{ mb: 2, overflow: "visible" }}>
      {/* Barra de progresso topo */}
      <LinearProgress
        variant="determinate"
        value={pct}
        color={allDone ? "success" : hasFailed ? "error" : hasRunning ? "info" : "primary"}
        sx={{ height: 3, borderRadius: "8px 8px 0 0", bgcolor: "divider" }}
      />
      <CardContent sx={{ pt: 1.5, pb: "8px !important" }}>
        {/* Header produto */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            <Typography
              variant="caption"
              onClick={() => onFilter(product.id)}
              sx={{
                fontWeight: 700, fontSize: "0.78rem", cursor: "pointer",
                color: hasRunning ? "success.main" : "primary.main",
                "&:hover": { textDecoration: "underline" },
              }}
            >
              🧩 {product.name}
            </Typography>
            {hasRunning && (
              <Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: "success.main",
                animation: "pulse 1.4s infinite",
                "@keyframes pulse": { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.35 } },
              }} />
            )}
          </Stack>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.62rem" }}>
              {projects.length} projeto{projects.length !== 1 ? "s" : ""}
            </Typography>
            <Typography variant="caption" fontWeight={700}
              sx={{ fontSize: "0.72rem", color: allDone ? "success.main" : hasRunning ? "info.main" : "text.secondary" }}>
              {pct}%
            </Typography>
          </Stack>
        </Stack>

        <Divider sx={{ mb: 0.5, opacity: 0.5 }} />

        {/* Lista de projetos */}
        <Box sx={{ mx: -2 }}>
          {ordered.map(p => (
            <ProductProjectRow
              key={p.id}
              project={p}
              onClick={() => router.push(`/projects/${p.id}`)}
            />
          ))}
        </Box>
      </CardContent>
    </MotionCard>
  );
}

// ── Linha de projeto avulso ────────────────────────────────────────────────────
function StandaloneRow({ project, onClick }: { project: Project; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: "flex", alignItems: "center", gap: 2, px: 2, py: 1.25,
        borderRadius: 1, cursor: "pointer", transition: "background 0.15s",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box sx={{
        width: 32, height: 32, borderRadius: "8px", flexShrink: 0,
        background: project.status === "running" ? "#6366F122"
          : project.status === "completed" || project.status === "accepted" ? "#10B98122" : "#8B949E22",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {project.status === "running" ? <PlayArrowIcon sx={{ fontSize: "0.9rem", color: "#6366F1" }} />
          : project.status === "completed" || project.status === "accepted" ? <CheckCircleIcon sx={{ fontSize: "0.9rem", color: "#10B981" }} />
          : project.status === "failed" ? <ErrorIcon sx={{ fontSize: "0.9rem", color: "#EF4444" }} />
          : <FolderIcon sx={{ fontSize: "0.9rem", color: "#8B949E" }} />}
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500} noWrap>{project.title ?? "Sem título"}</Typography>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.25 }}>
          {project.status === "running" ? (
            <>
              <LinearProgress variant="determinate" value={projectPercent(project)}
                sx={{ flexGrow: 1, height: 3, borderRadius: 2, bgcolor: "divider" }} />
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

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, gradient, delay = 0 }: {
  label: string; value: string | number; icon: React.ReactNode; gradient: string; delay?: number;
}) {
  return (
    <MotionCard {...fadeUp(delay)} whileHover={{ y: -2, transition: { duration: 0.15 } }} sx={{ overflow: "hidden" }}>
      <Box sx={{ height: 3, background: gradient }} />
      <CardContent sx={{ pt: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {label}
            </Typography>
            <Typography variant="h4" fontWeight={700} sx={{ mt: 0.5, lineHeight: 1 }}>{value}</Typography>
          </Box>
          <Box sx={{ width: 40, height: 40, borderRadius: "10px", background: gradient + "22",
            display: "flex", alignItems: "center", justifyContent: "center", "& svg": { fontSize: "1.25rem" } }}>
            {icon}
          </Box>
        </Stack>
      </CardContent>
    </MotionCard>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
const STANDALONE_PAGE_SIZE = 10;

function DashboardPageInner() {
  const router   = useRouter();
  const projects = projectsStore.list;
  const [products, setProducts] = useState<Product[]>([]);
  const [standaloneVisible, setStandaloneVisible] = useState(STANDALONE_PAGE_SIZE);

  const active    = projects.filter(p => p.status === "running").length;
  const completed = projects.filter(p => p.status === "completed" || p.status === "accepted").length;
  const failed    = projects.filter(p => p.status === "failed").length;
  const total     = projects.length;

  useEffect(() => {
    projectsStore.loadProjects();
    apiGet<Product[]>("/api/products")
      .then(prods => setProducts(prods))
      .catch(() => {});
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";

  // Mapear produtos com projetos, ordenar por updated_at (mais recentes / com running primeiro)
  const productMap = new Map<string, Product>(products.map(p => [p.id, p]));
  const projectsByProduct = new Map<string, Project[]>();
  const standaloneProjects: Project[] = [];

  for (const p of projects) {
    if (p.productId && productMap.has(p.productId)) {
      if (!projectsByProduct.has(p.productId)) projectsByProduct.set(p.productId, []);
      projectsByProduct.get(p.productId)!.push(p);
    } else {
      standaloneProjects.push(p);
    }
  }

  // Produtos ordenados: com running primeiro, depois por updatedAt desc
  const sortedProducts = products
    .filter(prod => projectsByProduct.has(prod.id))
    .sort((a, b) => {
      const aRunning = (projectsByProduct.get(a.id) ?? []).some(p => p.status === "running");
      const bRunning = (projectsByProduct.get(b.id) ?? []).some(p => p.status === "running");
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      const aDate = Math.max(...(projectsByProduct.get(a.id) ?? []).map(p => new Date(p.updatedAt).getTime()), 0);
      const bDate = Math.max(...(projectsByProduct.get(b.id) ?? []).map(p => new Date(p.updatedAt).getTime()), 0);
      return bDate - aDate;
    });

  // Projetos avulsos ordenados por updated_at desc
  const sortedStandalone = [...standaloneProjects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <Box>
      {/* ── Header ── */}
      <MotionBox {...fadeUp(0)} sx={{ mb: 3 }}>
        <Typography variant="h4" gutterBottom>
          {greeting}, {authStore.user?.name?.split(" ")[0] ?? ""}
        </Typography>
        <Typography color="text.secondary" variant="body2">
          {authStore.tenant ? `${authStore.tenant.name} · Plano ${authStore.tenant.plan.name}` : "Painel de controle Genesis"}
        </Typography>
      </MotionBox>

      {/* ── Stat cards ── */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Total de projetos" value={total} delay={1}
            icon={<FolderIcon sx={{ color: "#6366F1" }} />}
            gradient="linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Em execução" value={active} delay={2}
            icon={<PlayArrowIcon sx={{ color: "#10B981" }} />}
            gradient="linear-gradient(135deg, #10B981 0%, #059669 100%)" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Concluídos" value={completed} delay={3}
            icon={<CheckCircleIcon sx={{ color: "#F59E0B" }} />}
            gradient="linear-gradient(135deg, #F59E0B 0%, #D97706 100%)" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <StatCard label="Com falha" value={failed} delay={4}
            icon={<ErrorIcon sx={{ color: "#EF4444" }} />}
            gradient="linear-gradient(135deg, #EF4444 0%, #DC2626 100%)" />
        </Grid>
      </Grid>

      {/* ── Layout principal ── */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 8 }}>

          {/* ── Seção Produtos ── */}
          {sortedProducts.length > 0 && (
            <Box sx={{ mb: 3 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem" }}>
                  Produtos ({sortedProducts.length})
                </Typography>
              </Stack>
              {sortedProducts.map((prod, i) => (
                <ProductCard
                  key={prod.id}
                  product={prod}
                  projects={projectsByProduct.get(prod.id) ?? []}
                  delay={5 + i}
                  onFilter={(id) => router.push(`/projects?product=${id}`)}
                />
              ))}
            </Box>
          )}

          {/* ── Seção Projetos avulsos ── */}
          {sortedStandalone.length > 0 && (
            <MotionCard {...fadeUp(5 + sortedProducts.length)}>
              <CardContent sx={{ pb: "0 !important" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ pb: 1 }}>
                  <Typography variant="caption" color="text.secondary"
                    sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem" }}>
                    Projetos avulsos
                  </Typography>
                  <Button size="small" endIcon={<ArrowForwardIcon />} onClick={() => router.push("/projects")}>
                    Ver todos
                  </Button>
                </Stack>
              </CardContent>
              <Box sx={{ pb: 1 }}>
                {sortedStandalone.slice(0, standaloneVisible).map(p => (
                  <StandaloneRow key={p.id} project={p} onClick={() => router.push(`/projects/${p.id}`)} />
                ))}
                {standaloneVisible < sortedStandalone.length && (
                  <Box sx={{ px: 2, py: 1 }}>
                    <Button size="small" variant="text" onClick={() => setStandaloneVisible(v => v + STANDALONE_PAGE_SIZE)}>
                      Carregar mais ({sortedStandalone.length - standaloneVisible} restantes)
                    </Button>
                  </Box>
                )}
              </Box>
            </MotionCard>
          )}

          {!projectsStore.loading && sortedProducts.length === 0 && sortedStandalone.length === 0 && (
            <Card sx={{ textAlign: "center", py: 4 }}>
              <CardContent>
                <Typography color="text.secondary">Nenhum projeto ainda.</Typography>
                <Button variant="contained" startIcon={<SendIcon />} sx={{ mt: 2 }} onClick={() => router.push("/spec")}>
                  Enviar primeira spec
                </Button>
              </CardContent>
            </Card>
          )}
        </Grid>

        {/* ── Ações rápidas ── */}
        <Grid size={{ xs: 12, md: 4 }}>
          <MotionCard {...fadeUp(6)} sx={{ position: "sticky", top: 16 }}>
            <CardContent>
              <Typography variant="subtitle1" gutterBottom>Ações rápidas</Typography>
              <Stack spacing={1.5} sx={{ mt: 1 }}>
                <Button variant="contained" fullWidth startIcon={<SendIcon />}
                  onClick={() => router.push("/spec")} sx={{ justifyContent: "flex-start", py: 1.25 }}>
                  Enviar nova spec
                </Button>
                <Button variant="outlined" fullWidth startIcon={<FolderIcon />}
                  onClick={() => router.push("/projects")} sx={{ justifyContent: "flex-start", py: 1.25 }}>
                  Ver meus projetos
                </Button>
                {active > 0 && (
                  <Box sx={{ mt: 1, p: 1.5, borderRadius: 1, background: "#10B98112", border: "1px solid #10B98130" }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box sx={{ width: 8, height: 8, borderRadius: "50%", background: "#10B981",
                        animation: "pulse 1.5s infinite",
                        "@keyframes pulse": { "0%, 100%": { opacity: 1 }, "50%": { opacity: 0.4 } } }} />
                      <Typography variant="body2" color="success.main" fontWeight={500}>
                        {active} pipeline{active > 1 ? "s" : ""} em execução
                      </Typography>
                    </Stack>
                  </Box>
                )}
              </Stack>
              <Box sx={{ mt: 3, p: 2, borderRadius: 1.5,
                background: "linear-gradient(135deg, #6366F115 0%, #4F46E510 100%)",
                border: "1px solid #6366F130", textAlign: "center" }}>
                <AutoAwesomeIcon sx={{ color: "#6366F1", mb: 0.5 }} />
                <Typography variant="body2" fontWeight={600} color="primary">Zentriz Genesis</Typography>
                <Typography variant="caption" color="text.secondary">AI-native software factory</Typography>
              </Box>
            </CardContent>
          </MotionCard>
        </Grid>
      </Grid>
    </Box>
  );
}

export default observer(DashboardPageInner);
