"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";
import type { DialogueEntry } from "@/components/LiveDialogue";
import dynamic from "next/dynamic";

// ── react-force-graph-2d é browser-only (usa canvas) ─────────────────────────
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem = { id: string; taskId: string; ownerRole?: string; requirements?: string; status?: string };
type CodeFile  = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };

interface FGNode {
  id: string;
  label: string;
  type: "agent" | "task" | "artifact";
  color: string;
  size: number;
  isActive?: boolean;
  detail?: string;
}
interface FGLink { source: string; target: string; color: string }
interface GraphData { nodes: FGNode[]; links: FGLink[] }

// ── Status → color ────────────────────────────────────────────────────────────
const TASK_COLOR: Record<string, string> = {
  DONE: "#10B981", QA_PASS: "#10B981",
  IN_PROGRESS: "#6366F1", WAITING_REVIEW: "#6366F1",
  QA_FAIL: "#EF4444", BLOCKED: "#EF4444",
  NEW: "#4B5563", ASSIGNED: "#F59E0B",
};

const EXT_COLOR: Record<string, string> = {
  tsx: "#61DAFB", ts: "#3178C6", js: "#F7DF1E",
  css: "#1572B6", json: "#F59E0B", md: "#8B949E", sh: "#10B981", py: "#3776AB",
};

// ── Build graph data ──────────────────────────────────────────────────────────
function buildForceData(
  dialogue: DialogueEntry[],
  tasks: TaskItem[],
  codeFiles: CodeFile[],
  activeAgentId?: string,
): GraphData {
  const nodes: FGNode[] = [];
  const links: FGLink[] = [];
  const seenAgents = new Map<string, FGNode>();
  const linkSet    = new Set<string>();

  const addLink = (s: string, t: string, color = "#6366F140") => {
    const key = `${s}|${t}`;
    if (!linkSet.has(key)) { linkSet.add(key); links.push({ source: s, target: t, color }); }
  };

  // ── 1. Agents (from dialogue) ──────────────────────────────────────────────
  for (const e of dialogue) {
    for (const raw of [e.fromAgent, e.toAgent]) {
      if (!raw) continue;
      const key      = raw.toLowerCase().replace(/[^a-z_]/g, "_");
      if (seenAgents.has(key)) continue;
      const profile  = getAgentProfile(key);
      const isActive = activeAgentId?.toLowerCase().replace(/[^a-z_]/g, "_") === key;
      const node: FGNode = {
        id: `agent-${key}`, label: profile.name, type: "agent",
        color: profile.color, size: isActive ? 10 : 7,
        isActive, detail: profile.personality,
      };
      seenAgents.set(key, node);
      nodes.push(node);
    }
    // edge: from → to
    const fk = e.fromAgent.toLowerCase().replace(/[^a-z_]/g, "_");
    const tk = e.toAgent.toLowerCase().replace(/[^a-z_]/g, "_");
    if (fk !== tk && seenAgents.has(fk) && seenAgents.has(tk)) {
      const fromProfile = getAgentProfile(fk);
      addLink(`agent-${fk}`, `agent-${tk}`, fromProfile.color + "60");
    }
  }

  // ── 2. Tasks ───────────────────────────────────────────────────────────────
  // Map owner roles to the agent key as it appears in dialogue (fromAgent normalized)
  const ownerMap: Record<string, string> = {
    DEV: "dev", DEV_WEB: "dev", DEV_BACKEND: "dev", DEV_BACKEND_NODEJS: "dev",
    QA: "qa", QA_WEB: "qa", QA_BACKEND: "qa", QA_BACKEND_NODEJS: "qa",
    DEVOPS: "devops", DEVOPS_DOCKER: "devops",
    PM: "pm", PM_WEB: "pm", PM_BACKEND: "pm", PM_MOBILE: "pm",
    CTO: "cto", ENGINEER: "engineer", MONITOR: "monitor",
  };
  // Also build reverse map: agentKey → canonical key seen in dialogue
  const agentKeyInDialogue = (ownerRole: string): string | undefined => {
    const mapped = ownerMap[(ownerRole ?? "").toUpperCase()];
    if (!mapped) return undefined;
    // Check if this key or a prefix-match exists in seenAgents
    if (seenAgents.has(mapped)) return mapped;
    for (const k of Array.from(seenAgents.keys())) {
      if (k.startsWith(mapped) || mapped.startsWith(k.replace(/_.*/, ""))) return k;
    }
    return undefined;
  };

  for (const t of tasks) {
    const color = TASK_COLOR[t.status ?? ""] ?? "#4B5563";
    nodes.push({
      id: `task-${t.taskId}`, label: t.taskId, type: "task", color, size: 4,
      detail: t.requirements?.slice(0, 80),
    });
    const ownerKey = agentKeyInDialogue(t.ownerRole ?? "");
    if (ownerKey) {
      addLink(`agent-${ownerKey}`, `task-${t.taskId}`, color + "70");
    }
  }

  // ── 3. Artifacts (top 20 code files) ──────────────────────────────────────
  const MAX = 20;
  const showable = codeFiles
    .filter((f) => !f.path.includes("node_modules") && !f.path.endsWith(".lock"))
    .slice(0, MAX);

  // Find the dev agent key from seenAgents (could be "dev", "dev_backend", etc.)
  const devAgentKey = Array.from(seenAgents.keys()).find((k) => k.startsWith("dev")) ?? null;

  for (let i = 0; i < showable.length; i++) {
    const f     = showable[i];
    const color = EXT_COLOR[f.ext] ?? "#8B949E";
    const name  = f.path.split("/").pop() ?? f.path;
    nodes.push({
      id: `artifact-${i}`, label: name, type: "artifact", color, size: 2.5,
      detail: f.path,
    });
    if (devAgentKey) {
      addLink(`agent-${devAgentKey}`, `artifact-${i}`, color + "50");
    }
  }

  return { nodes, links };
}

// ── Component ─────────────────────────────────────────────────────────────────
interface ForceGraphProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number;
}

export function ForceGraph({ projectId, pollIntervalMs = 8000, height = 500 }: ForceGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading]     = useState(true);
  const [tooltip, setTooltip]     = useState<{ label: string; detail?: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [dialogue, tasks, codeFilesData] = await Promise.all([
        apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`).catch(() => [] as DialogueEntry[]),
        apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`).catch(() => [] as TaskItem[]),
        apiGet<CodeFilesResponse>(`/api/projects/${projectId}/code-files`).catch(() => ({ files: [], appsRoot: null, totalFiles: 0 })),
      ]);

      const lastWorking = [...(Array.isArray(dialogue) ? dialogue : [])]
        .reverse().find((e) => e.eventType === "agent_working");
      const activeAgentId = lastWorking?.fromAgent;

      const data = buildForceData(
        Array.isArray(dialogue) ? dialogue : [],
        Array.isArray(tasks) ? tasks : [],
        (codeFilesData as CodeFilesResponse).files ?? [],
        activeAgentId,
      );

      setGraphData(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
    if (pollIntervalMs > 0) {
      const t = setInterval(refresh, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [refresh, pollIntervalMs]);

  // ── Node canvas painter ────────────────────────────────────────────────────
  const paintNode = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as FGNode & { x?: number; y?: number };
    // Guard: physics hasn't assigned coordinates yet — skip this frame
    if (!isFinite(n.x ?? NaN) || !isFinite(n.y ?? NaN)) return;
    const x = n.x as number;
    const y = n.y as number;
    const r = (n.size ?? 5) * (n.isActive ? 1.4 : 1);

    // Glow for active agent
    if (n.isActive) {
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, 2 * Math.PI);
      const grd = ctx.createRadialGradient(x, y, r, x, y, r * 2.2);
      grd.addColorStop(0, n.color + "60");
      grd.addColorStop(1, n.color + "00");
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Main circle
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.type === "agent" ? n.color : n.color + "CC";
    ctx.fill();

    // Ring for agents
    if (n.type === "agent") {
      ctx.strokeStyle = n.color;
      ctx.lineWidth   = n.isActive ? 1.5 : 0.8;
      ctx.stroke();
    }

    // Label (only when zoomed in enough)
    const fontSize = Math.max(10 / globalScale, 1.5);
    if (globalScale > 0.6 || n.type === "agent") {
      ctx.font = `${n.type === "agent" ? "bold " : ""}${fontSize}px Inter, sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle    = n.type === "agent" ? "#E6EDF3" : n.color;
      ctx.fillText(n.label, x, y + r + fontSize * 1.1);
    }
  }, []);

  if (loading) {
    return (
      <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1 }}>
        <Typography variant="body2" color="text.secondary">Inicializando física…</Typography>
      </Box>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <Box sx={{ height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, flexDirection: "column", gap: 1 }}>
        <Typography variant="body2" color="text.secondary">Sem dados ainda.</Typography>
        <Typography variant="caption" color="text.secondary">O grafo cresce conforme os agentes trabalham.</Typography>
      </Box>
    );
  }

  const containerWidth = containerRef.current?.offsetWidth ?? 800;

  return (
    <Box ref={containerRef} sx={{ height, bgcolor: "#0D0F14", borderRadius: 1, overflow: "hidden", position: "relative" }}>
      <ForceGraph2D
        graphData={graphData as { nodes: object[]; links: object[] }}
        width={containerWidth}
        height={height}
        backgroundColor="#0D0F14"
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => "replace"}
        linkColor={(link) => (link as FGLink).color}
        linkWidth={1}
        linkDirectionalParticles={2}
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleColor={(link) => (link as FGLink).color}
        nodeRelSize={1}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        cooldownTicks={120}
        onNodeHover={(node) => {
          if (!node) { setTooltip(null); return; }
          const n = node as FGNode & { x: number; y: number };
          setTooltip({ label: n.label, detail: n.detail, x: 12, y: 12 });
        }}
        onNodeClick={(node) => {
          const n = node as FGNode;
          setTooltip({ label: n.label, detail: n.detail, x: 12, y: 12 });
        }}
      />

      {/* Tooltip overlay */}
      {tooltip && (
        <Box
          sx={{
            position: "absolute", top: tooltip.y, left: tooltip.x,
            bgcolor: "#161B22EE", border: "1px solid #30363D",
            borderRadius: 1, px: 1.5, py: 1, maxWidth: 220, pointerEvents: "none",
          }}
        >
          <Typography variant="caption" fontWeight={600} color="text.primary">{tooltip.label}</Typography>
          {tooltip.detail && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
              {tooltip.detail}
            </Typography>
          )}
        </Box>
      )}

      {/* Legend */}
      <Box sx={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 1.5, flexWrap: "wrap" }}>
        {[
          { color: "#6366F1", label: "Agente" },
          { color: "#10B981", label: "Task OK" },
          { color: "#EF4444", label: "Task Fail" },
          { color: "#61DAFB", label: "Artefato" },
        ].map((item) => (
          <Box key={item.label} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: item.color }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.6rem" }}>{item.label}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
