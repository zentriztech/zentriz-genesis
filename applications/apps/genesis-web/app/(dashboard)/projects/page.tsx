"use client";

import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import GridViewIcon from "@mui/icons-material/GridView";
import ListIcon from "@mui/icons-material/List";
import SendIcon from "@mui/icons-material/Send";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import { projectsStore } from "@/stores/projectsStore";
import type { Project } from "@/types";

const MotionCard = motion(Card);
const MotionBox  = motion(Box);

// ── Build lineage groups ──────────────────────────────────────────────────────
// Returns: rootProjects (with .children = subsequent versions)
interface ProjectGroup { root: Project; versions: Project[] }

function buildLineageGroups(projects: Project[]): ProjectGroup[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const groups: ProjectGroup[] = [];
  const handled = new Set<string>();

  for (const p of projects) {
    if (handled.has(p.id)) continue;
    if (!p.parentProjectId) {
      // root — find all children
      const children = projects
        .filter((c) => c.parentProjectId === p.id || (byId.get(c.parentProjectId ?? "")?.parentProjectId === p.id))
        .sort((a, b) => (a.versionNumber ?? 1) - (b.versionNumber ?? 1));
      children.forEach((c) => handled.add(c.id));
      handled.add(p.id);
      groups.push({ root: p, versions: [p, ...children] });
    }
  }
  // Orphans (parent deleted etc.)
  for (const p of projects) {
    if (!handled.has(p.id)) groups.push({ root: p, versions: [p] });
  }
  return groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho", spec_submitted: "Spec enviada", pending_conversion: "Convertendo",
  cto_charter: "Charter CTO", pm_backlog: "Backlog PM", dev_qa: "Dev/QA",
  devops: "DevOps", running: "Em execução", stopped: "Parado",
  completed: "Concluído", failed: "Falhou", accepted: "Aceito",
};

function statusColor(s: string): "default" | "success" | "error" | "info" | "warning" {
  if (s === "completed" || s === "accepted") return "success";
  if (s === "failed" || s === "stopped")     return "error";
  if (s === "running")                        return "info";
  if (["spec_submitted","cto_charter","pm_backlog","dev_qa","devops"].includes(s)) return "warning";
  return "default";
}

function stepPercent(s: string): number {
  const map: Record<string, number> = {
    draft: 0, spec_submitted: 14, pending_conversion: 20, cto_charter: 28,
    pm_backlog: 42, dev_qa: 65, devops: 85, running: 55,
    completed: 100, accepted: 100, failed: 0, stopped: 0,
  };
  return map[s] ?? 0;
}

function elapsedLabel(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}min`;
  return `${Math.floor(h / 24)}d`;
}

// ── New version button ────────────────────────────────────────────────────────
function NewVersionButton({ project }: { project: Project }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  if (project.status !== "accepted" && project.status !== "completed") return null;

  const handleNewVersion = async () => {
    setLoading(true);
    try {
      // Open spec upload page with parentProjectId pre-filled
      router.push(`/spec?parentProjectId=${project.id}&parentTitle=${encodeURIComponent(project.title ?? "")}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Tooltip title="Criar nova versão deste produto">
      <IconButton
        size="small"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation(); // prevent card click from firing
          handleNewVersion();
        }}
        sx={{ color: "primary.main", "&:hover": { bgcolor: "primary.main" + "18" } }}
      >
        <AddCircleOutlineIcon sx={{ fontSize: "0.9rem" }} />
      </IconButton>
    </Tooltip>
  );
}

// ── Project Card (grid view) ──────────────────────────────────────────────────
function ProjectCard({ project, delay = 0 }: { project: Project; delay?: number }) {
  const router  = useRouter();
  const pct     = stepPercent(project.status);
  const isRun   = project.status === "running";
  const isDone  = project.status === "completed" || project.status === "accepted";
  const isFail  = project.status === "failed" || project.status === "stopped";
  const elapsed = elapsedLabel(project.startedAt);

  const barColor = isDone ? "success" : isFail ? "error" : "primary";

  return (
    <MotionCard
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0, transition: { delay: delay * 0.06, duration: 0.3 } }}
      whileHover={{ y: -3, transition: { duration: 0.15 } }}
      sx={{ cursor: "pointer", height: "100%", display: "flex", flexDirection: "column" }}
      onClick={() => router.push(`/projects/${project.id}`)}
    >
      {/* Progress bar top */}
      <LinearProgress
        variant="determinate"
        value={pct}
        color={barColor}
        sx={{ height: 3, borderRadius: "8px 8px 0 0", bgcolor: "divider" }}
      />
      <CardContent sx={{ flexGrow: 1, pt: 1.5 }}>
        {/* Title + Version badge + Status */}
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0, flexGrow: 1 }}>
            {(project.versionNumber ?? 1) > 1 && (
              <Chip label={`v${project.versionNumber}`} size="small"
                sx={{ height: 16, fontSize: "0.6rem", bgcolor: "primary.main" + "22", color: "primary.main", flexShrink: 0 }} />
            )}
            <Typography variant="subtitle2" fontWeight={600} sx={{ lineHeight: 1.4 }} noWrap>
              {project.title ?? "Spec sem título"}
            </Typography>
          </Stack>
          <Stack direction="row" alignItems="center" spacing={0.25} sx={{ flexShrink: 0 }}>
            <NewVersionButton project={project} />
            <Chip
              label={STATUS_LABELS[project.status] ?? project.status}
              size="small"
              color={statusColor(project.status)}
              sx={{ fontSize: "0.65rem" }}
            />
          </Stack>
        </Stack>

        {/* Tipo de projeto + complexidade */}
        <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mb: 1, gap: 0.4 }}>
          {project.projectType && (
            <Chip size="small" label={project.projectType.replace(/_/g, " ")}
              sx={{ height: 16, fontSize: "0.58rem", bgcolor: "action.hover", textTransform: "capitalize" }} />
          )}
          {project.complexityHint && (
            <Chip size="small" label={project.complexityHint}
              sx={{ height: 16, fontSize: "0.58rem",
                bgcolor: { trivial: "#22c55e22", low: "#3b82f622", medium: "#f59e0b22", high: "#ef444422" }[project.complexityHint] ?? "action.hover",
                color:  { trivial: "#22c55e", low: "#3b82f6", medium: "#f59e0b", high: "#ef4444" }[project.complexityHint] ?? "text.secondary",
              }} />
          )}
        </Stack>

        {/* Running pulse indicator */}
        {isRun && (
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1 }}>
            <Box
              sx={{
                width: 6, height: 6, borderRadius: "50%", bgcolor: "info.main",
                animation: "pulse 1.4s ease-in-out infinite",
                "@keyframes pulse": { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.3 } },
              }}
            />
            <Typography variant="caption" color="info.main" fontWeight={500}>Pipeline ativo</Typography>
          </Stack>
        )}

        {/* Elapsed time */}
        {elapsed && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <AccessTimeIcon sx={{ fontSize: "0.75rem", color: "text.secondary" }} />
            <Typography variant="caption" color="text.secondary">{elapsed}</Typography>
          </Stack>
        )}
      </CardContent>

      {/* Footer */}
      <Box sx={{ px: 2, pb: 1.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="caption" color="text.secondary">
          Criado {new Date(project.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "2-digit" })}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.6rem" }}>
          Atualizado {new Date(project.updatedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
        </Typography>
      </Box>
    </MotionCard>
  );
}

// ── Project Row (list view) ───────────────────────────────────────────────────
function ProjectRow({ project, delay = 0 }: { project: Project; delay?: number }) {
  const router  = useRouter();
  const pct     = stepPercent(project.status);
  const isDone  = project.status === "completed" || project.status === "accepted";
  const isFail  = project.status === "failed" || project.status === "stopped";
  const barColor = isDone ? "success" : isFail ? "error" : "primary";

  return (
    <MotionBox
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0, transition: { delay: delay * 0.04, duration: 0.25 } }}
      onClick={() => router.push(`/projects/${project.id}`)}
      sx={{
        display: "flex", alignItems: "center", gap: 2, px: 2, py: 1.5,
        borderBottom: "1px solid", borderColor: "divider",
        cursor: "pointer", transition: "background 0.15s",
        "&:hover": { bgcolor: "action.hover" },
        "&:last-child": { borderBottom: "none" },
      }}
    >
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500} noWrap>{project.title ?? "Sem título"}</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
          <LinearProgress
            variant="determinate" value={pct} color={barColor}
            sx={{ width: 80, height: 4, borderRadius: 2, bgcolor: "divider" }}
          />
          <Typography variant="caption" color="text.secondary">{pct}%</Typography>
        </Stack>
      </Box>
      <Chip label={STATUS_LABELS[project.status] ?? project.status} size="small" color={statusColor(project.status)} />
      <Typography variant="caption" color="text.secondary" sx={{ width: 72, textAlign: "right", flexShrink: 0 }}>
        {new Date(project.updatedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
      </Typography>
      <IconButton size="small" onClick={(e) => { e.stopPropagation(); router.push(`/projects/${project.id}`); }}>
        <ArrowForwardIcon fontSize="small" />
      </IconButton>
    </MotionBox>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 10;

// FT-04: agrupa grupos por produto (product_id), depois por linhagem dentro de cada produto
interface ProductSection {
  productId: string | null;
  productName: string | null;
  groups: ProjectGroup[];
}

function buildProductSections(groups: ProjectGroup[], allProjects: Project[]): ProductSection[] {
  const productMap = new Map<string, string>(); // productId → name
  allProjects.forEach(p => {
    if (p.productId && !productMap.has(p.productId)) {
      const prod = (p as unknown as Record<string, unknown>).product as { id: string; name: string } | undefined;
      productMap.set(p.productId, prod?.name ?? `Produto ${p.productId.slice(0, 8)}`);
    }
  });

  const sections = new Map<string | null, ProjectGroup[]>();
  groups.forEach(g => {
    const key = g.root.productId ?? null;
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(g);
  });

  const result: ProductSection[] = [];
  // Produtos nomeados primeiro
  sections.forEach((gs, pid) => {
    if (pid !== null) result.push({ productId: pid, productName: productMap.get(pid) ?? null, groups: gs });
  });
  // Projetos standalone por último
  if (sections.has(null)) result.push({ productId: null, productName: null, groups: sections.get(null)! });
  return result;
}

function ProjectsPageInner() {
  const router   = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE); // FT-04: paginação
  const projects  = projectsStore.list;
  const running   = projects.filter((p) => p.status === "running");
  const rest      = projects.filter((p) => p.status !== "running");
  const sorted    = [...running, ...rest];
  const groups    = buildLineageGroups(sorted);
  // FT-04: todas as linhagens agrupadas por produto
  const productSections = buildProductSections(groups, sorted);
  // Paginação: contar linhagens total
  const totalGroups = groups.length;
  const visibleGroups = new Set(
    groups.slice(0, visibleCount).map(g => g.root.id)
  );

  useEffect(() => { projectsStore.loadProjects(); }, []);

  return (
    <Box>
      {/* ── Header ── */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h4">Meus projetos</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {projects.length} projeto{projects.length !== 1 ? "s" : ""} · {running.length} em execução
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup
            value={view} exclusive size="small"
            onChange={(_e, v) => { if (v) setView(v); }}
          >
            <ToggleButton value="grid"><Tooltip title="Cards"><GridViewIcon fontSize="small" /></Tooltip></ToggleButton>
            <ToggleButton value="list"><Tooltip title="Lista"><ListIcon fontSize="small" /></Tooltip></ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" startIcon={<SendIcon />} onClick={() => router.push("/spec")}>
            Nova spec
          </Button>
        </Stack>
      </Stack>

      {/* Loading */}
      {projectsStore.loading && (
        <LinearProgress sx={{ borderRadius: 1, mb: 2 }} />
      )}

      {/* Empty */}
      {!projectsStore.loading && sorted.length === 0 && (
        <Card sx={{ textAlign: "center", py: 6 }}>
          <CardContent>
            <Typography variant="h6" color="text.secondary" gutterBottom>Nenhum projeto ainda</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Envie uma spec para o Genesis criar seu primeiro produto.
            </Typography>
            <Button variant="contained" startIcon={<SendIcon />} onClick={() => router.push("/spec")}>
              Enviar spec
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Grid view — CSS flexbox direto, sem depender do MUI Grid */}
      <AnimatePresence mode="wait">
        {view === "grid" && groups.length > 0 && (
          <Box key="grid">
            {/* FT-04: renderizar por seção de produto */}
            {productSections.map((section) => {
              const sectionGroups = section.groups.filter(g => visibleGroups.has(g.root.id));
              if (sectionGroups.length === 0) return null;
              return (
                <Box key={section.productId ?? "standalone"} sx={{ mb: 3 }}>
                  {/* Cabeçalho de produto */}
                  {section.productId && (
                    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1.5 }}>
                      <Typography variant="caption" sx={{ fontWeight: 700, fontSize: "0.72rem", color: "primary.main" }}>
                        🧩 {section.productName ?? "Produto"}
                      </Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>
                        · {section.groups.reduce((acc, g) => acc + g.versions.length, 0)} projeto(s)
                      </Typography>
                    </Stack>
                  )}
                  {/* Grupos multi-versão */}
                  {sectionGroups.filter(g => g.versions.length > 1).map((group) => (
                    <Box key={group.root.id} sx={{ mb: 2 }}>
                      <Typography variant="caption" color="text.secondary"
                        sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem", display: "block", mb: 1 }}>
                        {group.root.title ?? "Produto"} · {group.versions.length} versões
                      </Typography>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                        {group.versions.map((p, i) => (
                          <Box key={p.id} sx={{ flex: "1 1 260px", maxWidth: { xs: "100%", sm: "calc(50% - 8px)", md: "calc(33.33% - 11px)" }, minWidth: 240 }}>
                            <ProjectCard project={p} delay={i} />
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  ))}
                  {/* Projetos individuais dentro do produto */}
                  {(() => {
                    const singles = sectionGroups.filter(g => g.versions.length === 1).map(g => g.root);
                    if (singles.length === 0) return null;
                    return (
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                        {singles.map((p, i) => (
                          <Box key={p.id} sx={{ flex: "1 1 260px", maxWidth: { xs: "100%", sm: "calc(50% - 8px)", md: "calc(33.33% - 11px)" }, minWidth: 240 }}>
                            <ProjectCard project={p} delay={i} />
                          </Box>
                        ))}
                      </Box>
                    );
                  })()}
                </Box>
              );
            })}
            {/* FT-04: Carregar Mais */}
            {visibleCount < totalGroups && (
              <Box sx={{ textAlign: "center", mt: 3 }}>
                <Button variant="outlined" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                  Carregar Mais ({totalGroups - visibleCount} restantes)
                </Button>
              </Box>
            )}
          </Box>
        )}

        {/* List view */}
        {view === "list" && sorted.length > 0 && (
          <Card key="list">
            {sorted.slice(0, visibleCount).map((p, i) => (
              <ProjectRow key={p.id} project={p} delay={i} />
            ))}
            {visibleCount < sorted.length && (
              <Box sx={{ textAlign: "center", p: 2 }}>
                <Button variant="outlined" size="small" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                  Carregar Mais
                </Button>
              </Box>
            )}
          </Card>
        )}
      </AnimatePresence>
    </Box>
  );
}

export default observer(ProjectsPageInner);
