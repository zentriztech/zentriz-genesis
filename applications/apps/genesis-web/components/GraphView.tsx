"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react-lite";
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  BackgroundVariant, type NodeTypes, type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import BubbleChartIcon from "@mui/icons-material/BubbleChart";
import { AgentNode }    from "@/components/graph/AgentNode";
import { TaskNode }     from "@/components/graph/TaskNode";
import { ArtifactNode } from "@/components/graph/ArtifactNode";
import { ForceGraph }   from "@/components/graph/ForceGraph";
import { buildGraphData, type GraphNode, type GraphEdge } from "@/lib/useGraphData";
import { apiGet } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";
// ── Node type registry ─────────────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  agentNode:    AgentNode,
  taskNode:     TaskNode,
  artifactNode: ArtifactNode,
};

// ── Types ──────────────────────────────────────────────────────────────────────
type TaskItem    = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string };
type CodeFile    = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };

type GraphMode = "hierarchy" | "force";

interface GraphViewProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number | string;
}

// ── Hierarchy (React Flow) ─────────────────────────────────────────────────────
function HierarchyGraph({ projectId, pollIntervalMs = 8000, height = 480 }: GraphViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const [loading, setLoading] = useState(true);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);

  const refresh = useCallback(async () => {
    try {
      const [dialogue, tasksData, codeFilesData] = await Promise.all([
        apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`).catch(() => [] as DialogueEntry[]),
        apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`).catch(() => [] as TaskItem[]),
        apiGet<CodeFilesResponse>(`/api/projects/${projectId}/code-files`).catch(() => ({ files: [], appsRoot: null, totalFiles: 0 })),
      ]);

      const lastWorking = [...(Array.isArray(dialogue) ? dialogue : [])]
        .reverse().find((e) => e.eventType === "agent_working");
      const activeAgentId = lastWorking?.fromAgent ?? undefined;

      const { nodes: newNodes, edges: newEdges } = buildGraphData({
        dialogueEntries: Array.isArray(dialogue) ? dialogue : [],
        tasks: Array.isArray(tasksData) ? tasksData : [],
        codeFiles: (codeFilesData as CodeFilesResponse).files ?? [],
        activeAgentId,
      });

      setNodes(newNodes);
      setEdges(newEdges);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [projectId, setNodes, setEdges]);

  useEffect(() => {
    refresh();
    if (pollIntervalMs > 0) {
      const t = setInterval(refresh, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [refresh, pollIntervalMs]);

  const flowStyle = useMemo(() => ({
    background: "#0D0F14", borderRadius: 8, border: "1px solid #30363D",
  }), []);

  if (loading) return (
    <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, border: "1px solid #30363D" }}>
      <Typography variant="body2" color="text.secondary">Construindo grafo…</Typography>
    </Box>
  );

  if (nodes.length === 0) return (
    <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, border: "1px solid #30363D", flexDirection: "column", gap: 1 }}>
      <Typography variant="body2" color="text.secondary">Nenhum dado de grafo ainda.</Typography>
      <Typography variant="caption" color="text.secondary">O grafo cresce conforme os agentes trabalham.</Typography>
    </Box>
  );

  return (
    <Box sx={{ height, borderRadius: 1, overflow: "hidden" }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2 }}
        style={flowStyle}
        defaultEdgeOptions={{ style: { stroke: "#6366F155", strokeWidth: 1.5 }, animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#30363D" variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }} showInteractive={false} />
        <MiniMap nodeStrokeColor="#6366F1" nodeColor="#161B22" maskColor="#0D0F14CC"
          style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }} />
      </ReactFlow>
    </Box>
  );
}

// ── Main GraphView with mode toggle ───────────────────────────────────────────
function GraphViewInner({ projectId, pollIntervalMs = 8000, height = 500 }: GraphViewProps) {
  const [mode, setMode] = useState<GraphMode>("force");
  const h = typeof height === "number" ? height : 500;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, height: h + 44 }}>
      {/* Mode toggle bar */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Visualização do pipeline
        </Typography>
        <ToggleButtonGroup
          value={mode} exclusive size="small"
          onChange={(_e, v) => { if (v) setMode(v as GraphMode); }}
          sx={{ "& .MuiToggleButton-root": { py: 0.4, px: 1, fontSize: "0.7rem", textTransform: "none", gap: 0.5 } }}
        >
          <ToggleButton value="force">
            <Tooltip title="Física livre — estilo Obsidian">
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <BubbleChartIcon sx={{ fontSize: "0.9rem" }} />
                <span>Obsidian</span>
              </Stack>
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="hierarchy">
            <Tooltip title="Hierarquia — Agentes → Tasks → Artefatos">
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <AccountTreeIcon sx={{ fontSize: "0.9rem" }} />
                <span>Hierarquia</span>
              </Stack>
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {/* Graph canvas */}
      {mode === "force" ? (
        <ForceGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={h} />
      ) : (
        <HierarchyGraph projectId={projectId} pollIntervalMs={pollIntervalMs} height={h} />
      )}
    </Box>
  );
}

export const GraphView = observer(GraphViewInner);
