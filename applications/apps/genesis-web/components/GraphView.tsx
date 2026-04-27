"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  BackgroundVariant, type NodeTypes, type Connection,
  useReactFlow, ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import { AgentNode }         from "@/components/graph/AgentNode";
import { TaskNode }          from "@/components/graph/TaskNode";
import { ArtifactGroupNode } from "@/components/graph/ArtifactGroupNode";
import { DocNode }           from "@/components/graph/DocNode";
import { ForceGraph }        from "@/components/graph/ForceGraph";
import { buildGraphData, type GraphNode, type GraphEdge, type PlanningDoc } from "@/lib/useGraphData";
import { apiGet } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";

// ── Node type registry ─────────────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  agentNode:         AgentNode,
  taskNode:          TaskNode,
  artifactGroupNode: ArtifactGroupNode,
  docNode:           DocNode,
};

type TaskItem    = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string };
type CodeFile    = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };
type GraphMode = "hierarchy" | "force";

interface GraphViewProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number | string;
  planningDocs?: PlanningDoc[];
}

// ── Hierarchy (React Flow) — inner component that can call useReactFlow ─────────
function HierarchyGraphInner({ projectId, pollIntervalMs = 8000, height = 480, planningDocs }: GraphViewProps) {
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
        expandedGroups,
        onToggleGroup,
      });
      setNodes(newNodes);
      setEdges(newEdges);
      setTimeout(() => fitView({ padding: 0.2 }), 100);
    } catch { /* silent */ } finally { setLoading(false); }
  // expandedGroups in deps: rebuild when a group is toggled
  }, [projectId, planningDocs, expandedGroups, onToggleGroup, setNodes, setEdges, fitView]);

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

function HierarchyGraph(props: GraphViewProps) {
  return <ReactFlowProvider><HierarchyGraphInner {...props} /></ReactFlowProvider>;
}

// ── Main GraphView with mode toggle + fullscreen ──────────────────────────────
function GraphViewInner({ projectId, pollIntervalMs = 8000, height = 500, planningDocs }: GraphViewProps) {
  const [mode, setMode]         = useState<GraphMode>("force");
  const [fullscreen, setFullscreen] = useState(false);
  const h = typeof height === "number" ? height : 500;

  const graphContent = (fsHeight: number | string) => {
    // ForceGraph mede o próprio container via ResizeObserver — height é apenas fallback inicial
    const numH = typeof fsHeight === "number" ? fsHeight : h;
    return mode === "force"
      ? <ForceGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={numH} planningDocs={planningDocs} />
      : <HierarchyGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={fsHeight} planningDocs={planningDocs} />;
  };

  return (
    <>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {/* Toolbar */}
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="caption" color="text.secondary"
            sx={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Visualização do pipeline
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <ToggleButtonGroup value={mode} exclusive size="small"
              onChange={(_e, v) => { if (v) setMode(v as GraphMode); }}
              sx={{ "& .MuiToggleButton-root": { py: 0.4, px: 1, fontSize: "0.7rem", textTransform: "none", gap: 0.5 } }}>
              <ToggleButton value="force">
                <Tooltip title="Física livre — estilo Obsidian">
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <BubbleChartIcon sx={{ fontSize: "0.9rem" }} /><span>Obsidian</span>
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
            <Tooltip title="Tela cheia">
              <IconButton size="small" onClick={() => setFullscreen(true)}
                sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 0.4 }}>
                <FullscreenIcon sx={{ fontSize: "1rem" }} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        {graphContent(h)}
      </Box>

      {/* Fullscreen dialog */}
      <Dialog open={fullscreen} onClose={() => setFullscreen(false)} fullScreen
        PaperProps={{ sx: { bgcolor: "#0D0F14", m: 0 } }}>
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column", height: "100vh" }}>
          {/* Toolbar inside fullscreen */}
          <Stack direction="row" alignItems="center" justifyContent="space-between"
            sx={{ px: 2, py: 1, borderBottom: "1px solid #30363D", flexShrink: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" fontWeight={600} color="text.primary">Grafo do Pipeline</Typography>
              <ToggleButtonGroup value={mode} exclusive size="small"
                onChange={(_e, v) => { if (v) setMode(v as GraphMode); }}
                sx={{ "& .MuiToggleButton-root": { py: 0.3, px: 1, fontSize: "0.7rem", textTransform: "none" } }}>
                <ToggleButton value="force">
                  <BubbleChartIcon sx={{ fontSize: "0.85rem", mr: 0.5 }} />Obsidian
                </ToggleButton>
                <ToggleButton value="hierarchy">
                  <AccountTreeIcon sx={{ fontSize: "0.85rem", mr: 0.5 }} />Hierarquia
                </ToggleButton>
              </ToggleButtonGroup>
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
    </>
  );
}

export const GraphView = observer(GraphViewInner);
