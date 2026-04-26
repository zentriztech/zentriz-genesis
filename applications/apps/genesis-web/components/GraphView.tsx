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
import Typography from "@mui/material/Typography";
import { AgentNode }    from "@/components/graph/AgentNode";
import { TaskNode }     from "@/components/graph/TaskNode";
import { ArtifactNode } from "@/components/graph/ArtifactNode";
import { buildGraphData, type GraphNode, type GraphEdge } from "@/lib/useGraphData";
import { apiGet } from "@/lib/api";
import type { DialogueEntry } from "@/components/LiveDialogue";

// ── Node type registry ────────────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  agentNode:    AgentNode,
  taskNode:     TaskNode,
  artifactNode: ArtifactNode,
};

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem    = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string };
type CodeFile    = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };

interface GraphViewProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number | string;
}

// ── Component ─────────────────────────────────────────────────────────────────
function GraphViewInner({ projectId, pollIntervalMs = 8000, height = 480 }: GraphViewProps) {
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
        .reverse()
        .find((e) => e.eventType === "agent_working");
      const activeAgentId = lastWorking?.fromAgent ?? undefined;

      const { nodes: newNodes, edges: newEdges } = buildGraphData({
        dialogueEntries: Array.isArray(dialogue) ? dialogue : [],
        tasks: Array.isArray(tasksData) ? tasksData : [],
        codeFiles: (codeFilesData as CodeFilesResponse).files ?? [],
        activeAgentId,
      });

      setNodes(newNodes);
      setEdges(newEdges);
    } catch {
      // silently fail — graph just won't update
    } finally {
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

  // Dark background color for the flow
  const flowStyle = useMemo(() => ({
    background: "#0D0F14",
    borderRadius: 8,
    border: "1px solid #30363D",
  }), []);

  if (loading) {
    return (
      <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, border: "1px solid #30363D" }}>
        <Typography variant="body2" color="text.secondary">Construindo grafo…</Typography>
      </Box>
    );
  }

  if (nodes.length === 0) {
    return (
      <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, border: "1px solid #30363D", flexDirection: "column", gap: 1 }}>
        <Typography variant="body2" color="text.secondary">Nenhum dado de grafo ainda.</Typography>
        <Typography variant="caption" color="text.secondary">O grafo será preenchido conforme os agentes trabalham.</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height, borderRadius: 1, overflow: "hidden" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        style={flowStyle}
        defaultEdgeOptions={{
          style: { stroke: "#6366F155", strokeWidth: 1.5 },
          animated: false,
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#30363D" variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls
          style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }}
          showInteractive={false}
        />
        <MiniMap
          nodeStrokeColor="#6366F1"
          nodeColor="#161B22"
          maskColor="#0D0F14CC"
          style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6 }}
        />
      </ReactFlow>
    </Box>
  );
}

export const GraphView = observer(GraphViewInner);
