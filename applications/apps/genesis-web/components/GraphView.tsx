"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  BackgroundVariant, type NodeTypes, type Connection,
  useReactFlow, ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import CloseIcon from "@mui/icons-material/Close";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import TuneIcon from "@mui/icons-material/Tune";
import { AgentNode }         from "@/components/graph/AgentNode";
import { TaskNode }          from "@/components/graph/TaskNode";
import { ArtifactGroupNode } from "@/components/graph/ArtifactGroupNode";
import { DocNode }           from "@/components/graph/DocNode";
import { ForceGraph }        from "@/components/graph/ForceGraph";
import { buildGraphData, DEFAULT_FILTER, type GraphFilter, type GraphNode, type GraphEdge, type PlanningDoc } from "@/lib/useGraphData";
import { apiGet } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";

// ── Task Detail Drawer (Hierarquia) ───────────────────────────────────────────
const STATUS_COLOR_GV: Record<string, string> = {
  DONE: "#10B981", QA_PASS: "#10B981", IN_PROGRESS: "#6366F1",
  WAITING_REVIEW: "#6366F1", QA_FAIL: "#EF4444", BLOCKED: "#EF4444",
  NEW: "#8B949E", ASSIGNED: "#F59E0B",
};
const STATUS_LABEL_GV: Record<string, string> = {
  DONE: "✓ Feito", QA_PASS: "✓ QA OK", IN_PROGRESS: "⟳ Em desenvolvimento",
  WAITING_REVIEW: "⟳ Aguardando Review", QA_FAIL: "✗ QA Falhou",
  BLOCKED: "⊘ Bloqueada", NEW: "◦ Nova", ASSIGNED: "→ Atribuída",
};

function TaskDetailDrawerView({ task, onClose }: { task: TaskItem | null; onClose: () => void }) {
  if (!task) return null;
  const color = STATUS_COLOR_GV[task.status ?? ""] ?? "#8B949E";
  const label = STATUS_LABEL_GV[task.status ?? ""] ?? task.status ?? "—";
  const lines = (task.requirements ?? "").split(/\n/).map(l => l.trim()).filter(Boolean);
  const isBullet = (l: string) => /^[-*•]/.test(l) || /^\d+[.)]\s/.test(l);
  const bullets = lines.filter(isBullet).map(l => l.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, ""));
  const prose   = lines.filter(l => !isBullet(l));
  const fmtDate = (iso?: string) => iso ? new Date(iso).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" }) : null;

  return (
    <Drawer anchor="right" open={!!task} onClose={onClose}
      PaperProps={{ sx: { width: 360, bgcolor: "#0D0F14", borderLeft: "1px solid #30363D", p: 0 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between"
        sx={{ px: 2, py: 1.5, borderBottom: "1px solid #30363D", flexShrink: 0 }}>
        <Stack spacing={0.25}>
          <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ fontSize: "0.65rem" }}>
            {task.module ? `${task.module} · ` : ""}{task.ownerRole ?? ""}
          </Typography>
          <Typography variant="body2" fontWeight={700} color="text.primary" sx={{ fontSize: "0.85rem" }}>{task.taskId}</Typography>
        </Stack>
        <IconButton size="small" onClick={onClose} sx={{ color: "text.secondary" }}>
          <CloseIcon sx={{ fontSize: "1rem" }} />
        </IconButton>
      </Stack>
      <Box sx={{ px: 2, py: 1.5, overflowY: "auto", flexGrow: 1 }}>
        <Box sx={{ display: "inline-block", mb: 2, px: 1.5, py: 0.4, borderRadius: 10,
          bgcolor: `${color}18`, border: `1px solid ${color}40`, color, fontSize: "0.7rem", fontWeight: 600 }}>
          {label}
        </Box>
        {bullets.length > 0 && (
          <>
            <Typography variant="caption" color="text.disabled"
              sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem", display: "block", mb: 0.75 }}>
              Requisitos
            </Typography>
            <Stack spacing={0.5} sx={{ mb: 2 }}>
              {bullets.map((b, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ width: 4, height: 4, borderRadius: "50%", bgcolor: color, mt: 0.6, flexShrink: 0 }} />
                  <Typography variant="caption" color="text.primary" sx={{ fontSize: "0.72rem", lineHeight: 1.5 }}>{b}</Typography>
                </Stack>
              ))}
            </Stack>
          </>
        )}
        {prose.length > 0 && (
          <>
            {bullets.length > 0 && <Divider sx={{ borderColor: "#30363D", mb: 1.5 }} />}
            <Typography variant="caption" color="text.disabled"
              sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem", display: "block", mb: 0.75 }}>
              {bullets.length === 0 ? "Descrição" : "Detalhes"}
            </Typography>
            {prose.map((p, i) => (
              <Typography key={i} variant="caption" color="text.secondary"
                sx={{ display: "block", fontSize: "0.72rem", lineHeight: 1.6, mb: 0.5 }}>{p}</Typography>
            ))}
          </>
        )}
        {bullets.length === 0 && prose.length === 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.7rem" }}>Sem requisitos registrados.</Typography>
        )}
        <Divider sx={{ borderColor: "#30363D", mt: 2, mb: 1.5 }} />
        <Stack spacing={0.75}>
          {task.ownerRole && (
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>Responsável</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem", fontFamily: "monospace" }}>{task.ownerRole}</Typography>
            </Stack>
          )}
          {fmtDate(task.createdAt) && (
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>Criada em</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem" }}>{fmtDate(task.createdAt)}</Typography>
            </Stack>
          )}
          {fmtDate(task.updatedAt) && task.updatedAt !== task.createdAt && (
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>Atualizada</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem" }}>{fmtDate(task.updatedAt)}</Typography>
            </Stack>
          )}
        </Stack>
      </Box>
    </Drawer>
  );
}

// ── Definição dos itens do filtro ──────────────────────────────────────────────
const FILTER_GROUPS: Array<{
  label: string;
  items: Array<{ key: keyof GraphFilter; label: string; note?: string }>;
}> = [
  {
    label: "Tasks",
    items: [
      { key: "tasksDone",    label: "Concluídas", note: "DONE / QA_PASS" },
      { key: "tasksPending", label: "Pendentes",  note: "NEW · ASSIGNED · BLOCKED · QA_FAIL" },
    ],
  },
  {
    label: "Documentos",
    items: [
      { key: "docsSpec",     label: "Spec" },
      { key: "docsCto",      label: "Arquivos do CTO" },
      { key: "docsEngineer", label: "Arquivos do Engineer" },
      { key: "docsPm",       label: "Arquivos do PM" },
      { key: "docsQa",       label: "QA Reports" },
      { key: "docsDevops",   label: "Docs de Implantação" },
    ],
  },
  {
    label: "Artefatos",
    items: [
      { key: "artifacts", label: "Arquivos gerados (código)" },
    ],
  },
];

// ── Node type registry ─────────────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  agentNode:         AgentNode,
  taskNode:          TaskNode,
  artifactGroupNode: ArtifactGroupNode,
  docNode:           DocNode,
};

type TaskItem    = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string; createdAt?: string; updatedAt?: string };
type CodeFile    = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };
type GraphMode = "hierarchy" | "force";

interface GraphViewProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number | string;
  planningDocs?: PlanningDoc[];
  filter?: GraphFilter;
}

// ── Hierarchy (React Flow) — inner component that can call useReactFlow ─────────
function HierarchyGraphInner({ projectId, pollIntervalMs = 8000, height = 480, planningDocs, filter, onClickTask }: GraphViewProps & { onClickTask?: (taskId: string) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const [loading, setLoading]     = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const { fitView } = useReactFlow();

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);

  const onToggleGroup = useCallback((dir: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [dialogue, tasksData, codeFilesData] = await Promise.all([
        apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`).catch(() => [] as DialogueEntry[]),
        apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`).catch(() => [] as TaskItem[]),
        apiGet<CodeFilesResponse>(`/api/projects/${projectId}/code-files`).catch(() => ({ files: [], appsRoot: null, totalFiles: 0 })),
      ]);
      const lastWorking = [...(Array.isArray(dialogue) ? dialogue : [])].reverse().find((e) => e.eventType === "agent_working");
      const { nodes: newNodes, edges: newEdges } = buildGraphData({
        dialogueEntries: Array.isArray(dialogue) ? dialogue : [],
        tasks: Array.isArray(tasksData) ? tasksData : [],
        codeFiles: (codeFilesData as CodeFilesResponse).files ?? [],
        planningDocs: planningDocs ?? [],
        activeAgentId: lastWorking?.fromAgent ?? undefined,
        projectId,
        expandedGroups,
        onToggleGroup,
        onClickTask,
        filter,
      });
      setNodes(newNodes);
      setEdges(newEdges);
      setTimeout(() => fitView({ padding: 0.2 }), 100);
    } catch { /* silent */ } finally { setLoading(false); }
  // expandedGroups in deps: rebuild when a group is toggled
  }, [projectId, planningDocs, filter, expandedGroups, onToggleGroup, setNodes, setEdges, fitView]);

  useEffect(() => {
    refresh();
    if (pollIntervalMs > 0) { const t = setInterval(refresh, pollIntervalMs); return () => clearInterval(t); }
  }, [refresh, pollIntervalMs]);

  const flowStyle = useMemo(() => ({ background: "#0D0F14", borderRadius: 8, border: "1px solid #30363D" }), []);

  if (loading) return (
    <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1 }}>
      <Typography variant="body2" color="text.secondary">Construindo grafo…</Typography>
    </Box>
  );
  if (nodes.length === 0) return (
    <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, flexDirection: "column", gap: 1 }}>
      <Typography variant="body2" color="text.secondary">Nenhum dado de grafo ainda.</Typography>
    </Box>
  );
  return (
    <Box sx={{ height, borderRadius: 1, overflow: "hidden" }}>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2 }}
        style={flowStyle} defaultEdgeOptions={{ style: { stroke: "#6366F155", strokeWidth: 1.5 } }}
        proOptions={{ hideAttribution: true }}>
        <Background color="#30363D" variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }} showInteractive={false} />
        <MiniMap nodeStrokeColor="#6366F1" nodeColor="#161B22" maskColor="#0D0F14CC"
          style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }} />
      </ReactFlow>
    </Box>
  );
}

function HierarchyGraph(props: GraphViewProps & { onClickTask?: (taskId: string) => void }) {
  return <ReactFlowProvider><HierarchyGraphInner {...props} /></ReactFlowProvider>;
}

// ── Dropdown de filtro ────────────────────────────────────────────────────────
function FilterDropdown({ filter, onChange }: { filter: GraphFilter; onChange: (f: GraphFilter) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const activeCount = Object.entries(filter).filter(([k, v]) => {
    if (k === "tasksDone" || k === "tasksPending") return v === true;
    return v === true;
  }).length;
  const defaultCount = Object.values(DEFAULT_FILTER).filter(Boolean).length;
  const isDirty = activeCount !== defaultCount ||
    Object.keys(filter).some(k => filter[k as keyof GraphFilter] !== DEFAULT_FILTER[k as keyof GraphFilter]);

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ position: "relative" }}>
        <Tooltip title="Filtrar o que aparece no grafo">
          <Chip
            ref={anchorRef}
            label={
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <TuneIcon sx={{ fontSize: "0.75rem" }} />
                <span>Filtros{isDirty ? " •" : ""}</span>
              </Stack>
            }
            size="small"
            onClick={() => setOpen(o => !o)}
            sx={{
              bgcolor: isDirty ? "#6366F122" : "#161B22EE",
              color: isDirty ? "#6366F1" : "#8B949E",
              border: "1px solid", borderColor: isDirty ? "#6366F155" : "#30363D",
              fontSize: "0.65rem", height: 24, cursor: "pointer",
              transition: "all 0.2s ease",
            }}
          />
        </Tooltip>

        {open && (
          <Paper elevation={8} sx={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 1400,
            bgcolor: "#161B22", border: "1px solid #30363D", borderRadius: 1.5,
            minWidth: 240, p: 1.5,
          }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="caption" fontWeight={700} color="text.primary" sx={{ fontSize: "0.7rem" }}>
                Exibir no grafo
              </Typography>
              <Chip
                label="Padrão"
                size="small"
                onClick={() => onChange({ ...DEFAULT_FILTER })}
                sx={{ fontSize: "0.58rem", height: 18, cursor: "pointer", bgcolor: "#30363D", color: "#8B949E" }}
              />
            </Stack>

            {FILTER_GROUPS.map((group, gi) => (
              <Box key={group.label}>
                {gi > 0 && <Divider sx={{ my: 0.75, borderColor: "#30363D" }} />}
                <Typography variant="caption" color="text.disabled"
                  sx={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", mb: 0.25 }}>
                  {group.label}
                </Typography>
                <FormGroup>
                  {group.items.map(item => (
                    <FormControlLabel
                      key={item.key}
                      control={
                        <Checkbox
                          size="small"
                          checked={filter[item.key]}
                          onChange={e => onChange({ ...filter, [item.key]: e.target.checked })}
                          sx={{ p: 0.4, color: "#484F58", "&.Mui-checked": { color: "#6366F1" } }}
                        />
                      }
                      label={
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Typography variant="caption" sx={{ fontSize: "0.7rem" }}>{item.label}</Typography>
                          {item.note && (
                            <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.58rem" }}>
                              {item.note}
                            </Typography>
                          )}
                        </Stack>
                      }
                      sx={{ mx: 0, mb: 0.1 }}
                    />
                  ))}
                </FormGroup>
              </Box>
            ))}

            <Typography variant="caption" color="text.disabled"
              sx={{ display: "block", mt: 1, fontSize: "0.58rem", lineHeight: 1.4 }}>
              IN_PROGRESS sempre visível
            </Typography>
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  );
}

// ── Toolbar compartilhado ─────────────────────────────────────────────────────
function GraphToolbar({
  mode, onModeChange, filter, onFilterChange, onFullscreen,
}: {
  mode: GraphMode;
  onModeChange: (m: GraphMode) => void;
  filter: GraphFilter;
  onFilterChange: (f: GraphFilter) => void;
  onFullscreen?: () => void;
}) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography variant="caption" color="text.secondary"
        sx={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Visualização do pipeline
      </Typography>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <ToggleButtonGroup value={mode} exclusive size="small"
          onChange={(_e, v) => { if (v) onModeChange(v as GraphMode); }}
          sx={{ "& .MuiToggleButton-root": { py: 0.4, px: 1, fontSize: "0.7rem", textTransform: "none", gap: 0.5 } }}>
          <ToggleButton value="force">
            <Tooltip title="Física livre — layout Padrão">
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <BubbleChartIcon sx={{ fontSize: "0.9rem" }} /><span>Padrão</span>
              </Stack>
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="hierarchy">
            <Tooltip title="Hierarquia">
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <AccountTreeIcon sx={{ fontSize: "0.9rem" }} /><span>Hierarquia</span>
              </Stack>
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>
        <FilterDropdown filter={filter} onChange={onFilterChange} />
        {onFullscreen && (
          <Tooltip title="Tela cheia">
            <IconButton size="small" onClick={onFullscreen}
              sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 0.4 }}>
              <FullscreenIcon sx={{ fontSize: "1rem" }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Stack>
  );
}

// ── Main GraphView with mode toggle + fullscreen ──────────────────────────────
function GraphViewInner({ projectId, pollIntervalMs = 8000, height = 500, planningDocs }: GraphViewProps) {
  const [mode, setMode]         = useState<GraphMode>("force");
  const [fullscreen, setFullscreen] = useState(false);
  const [filter, setFilter]     = useState<GraphFilter>({ ...DEFAULT_FILTER });
  // Task detail drawer — compartilhado entre Padrão e Hierarquia
  const [drawerTask, setDrawerTask] = useState<TaskItem | null>(null);
  const taskMapRef = useRef<Map<string, TaskItem>>(new Map());

  // Mantém o taskMap atualizado via polling
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const tasks = await apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`);
        if (active && Array.isArray(tasks)) tasks.forEach(t => taskMapRef.current.set(t.taskId, t));
      } catch { /* silent */ }
    };
    load();
    const t = pollIntervalMs > 0 ? setInterval(load, pollIntervalMs) : null;
    return () => { active = false; if (t) clearInterval(t); };
  }, [projectId, pollIntervalMs]);

  const handleClickTask = useCallback((taskId: string) => {
    const t = taskMapRef.current.get(taskId);
    if (t) setDrawerTask(t);
  }, []);

  // When height="100%" the outer Box fills its flex parent; otherwise use numeric px
  const isFill  = height === "100%";
  const h       = typeof height === "number" ? height : 500;

  const graphContent = (fsHeight: number | string) => {
    const numH = typeof fsHeight === "number" ? fsHeight : h;
    return mode === "force"
      ? <ForceGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={numH} planningDocs={planningDocs} filter={filter} />
      : <HierarchyGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={fsHeight} planningDocs={planningDocs} filter={filter} onClickTask={handleClickTask} />;
  };

  return (
    <>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, ...(isFill && { height: "100%", minHeight: 0 }) }}>
        <GraphToolbar mode={mode} onModeChange={setMode} filter={filter} onFilterChange={setFilter} onFullscreen={() => setFullscreen(true)} />
        {graphContent(isFill ? "100%" : h)}
      </Box>

      {/* Fullscreen dialog */}
      <Dialog open={fullscreen} onClose={() => setFullscreen(false)} fullScreen
        PaperProps={{ sx: { bgcolor: "#0D0F14", m: 0 } }}>
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", height: "100vh" }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between"
            sx={{ px: 2, py: 1, borderBottom: "1px solid #30363D", flexShrink: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" fontWeight={600} color="text.primary">Grafo do Pipeline</Typography>
              <GraphToolbar mode={mode} onModeChange={setMode} filter={filter} onFilterChange={setFilter} />
            </Stack>
            <Tooltip title="Sair de tela cheia">
              <IconButton onClick={() => setFullscreen(false)} size="small">
                <FullscreenExitIcon />
              </IconButton>
            </Tooltip>
          </Stack>
          <Box sx={{ flexGrow: 1, overflow: "hidden", height: 0 }}>
            {graphContent("100%")}
          </Box>
        </DialogContent>
      </Dialog>

      {/* Task detail drawer — Hierarquia */}
      <TaskDetailDrawerView task={drawerTask} onClose={() => setDrawerTask(null)} />
    </>
  );
}

export const GraphView = observer(GraphViewInner);
