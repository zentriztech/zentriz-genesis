"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";
import type { DialogueEntry } from "@/components/LiveDialogue";
import type { PlanningDoc } from "@/lib/useGraphData";
import dynamic from "next/dynamic";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem = { id: string; taskId: string; ownerRole?: string; requirements?: string; status?: string };
type CodeFile  = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };

interface FGNode {
  id: string; label: string;
  type: "agent" | "task" | "artifact" | "doc";
  color: string; size: number; isActive?: boolean; detail?: string;
}
interface FGLink { source: string | FGNode; target: string | FGNode; color: string }
interface GraphData { nodes: FGNode[]; links: FGLink[] }
type NodeWithPos = FGNode & { fx?: number; fy?: number; x?: number; y?: number; vx?: number; vy?: number };

// ── Layout modes ──────────────────────────────────────────────────────────────
type LayoutMode = "free" | "flow" | "brain" | "radial" | "pipeline";
const LAYOUT_CYCLE: LayoutMode[] = ["free", "flow", "brain", "radial", "pipeline"];
const LAYOUT_META: Record<LayoutMode, { label: string; tip: string; icon: string }> = {
  free:     { icon: "🌌", label: "Obsidian",  tip: "Física livre — clique no fundo para próximo layout" },
  flow:     { icon: "🌊", label: "Fluxo",     tip: "Pipeline orgânico — esquerda→direita com curvas" },
  brain:    { icon: "🧠", label: "Cérebro",   tip: "Agentes no núcleo, conexões bidirecionais" },
  radial:   { icon: "⭕", label: "Radial",    tip: "CTO no centro, camadas por tipo" },
  pipeline: { icon: "➡️", label: "Pipeline",  tip: "Esquerda→direita por fase do pipeline" },
};

// Pares de agentes que têm relação bidirecional forte (consulta ↔ resposta)
const BIDIRECTIONAL_PAIRS = new Set([
  // CTO ↔ Engineer ↔ PM (planejamento)
  "cto|engineer", "engineer|cto",
  "cto|pm", "pm|cto",
  // Monitor/Sistema ↔ todos os agentes de execução
  "monitor|cto",    "cto|monitor",
  "monitor|engineer","engineer|monitor",
  "monitor|pm",     "pm|monitor",
  "monitor|dev",    "dev|monitor",
  "monitor|qa",     "qa|monitor",
  "monitor|devops", "devops|monitor",
  "system|cto",     "cto|system",
  "system|engineer","engineer|system",
  "system|pm",      "pm|system",
  // PM ↔ Dev e PM ↔ QA (backlog/validação)
  "pm|dev", "dev|pm",
  "pm|qa",  "qa|pm",
]);

// ── Colors ────────────────────────────────────────────────────────────────────
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
const PHASE_AGENT_KEY: Record<string, string> = {
  spec: "system", cto: "cto", engineer: "engineer",
  pm: "pm", qa: "qa", devops: "devops", other: "system",
};
const PHASE_COLOR_FG: Record<string, string> = {
  spec: "#8B949E", cto: "#1976d2", engineer: "#2e7d32",
  pm: "#ed6c02", qa: "#43a047", devops: "#0d47a1", other: "#484F58",
};

function inferPhaseFG(filename: string, creator?: string): string {
  const f = filename.toLowerCase(); const c = (creator ?? "").toLowerCase();
  if (f.includes("spec") || c === "spec") return "spec";
  if (f.includes("cto") || c === "cto") return "cto";
  if (f.includes("engineer") || c === "engineer") return "engineer";
  if (f.includes("pm") || f.includes("backlog") || c === "pm") return "pm";
  if (f.includes("qa") || c === "qa") return "qa";
  if (f.includes("devops") || f.includes("runbook") || c === "devops") return "devops";
  return "other";
}

// ── Build raw graph data ──────────────────────────────────────────────────────
function buildForceData(
  dialogue: DialogueEntry[], tasks: TaskItem[], codeFiles: CodeFile[],
  activeAgentId?: string, planningDocs: PlanningDoc[] = [],
): GraphData {
  const nodes: FGNode[] = []; const links: FGLink[] = [];
  const seenAgents = new Map<string, FGNode>(); const linkSet = new Set<string>();

  const addLink = (s: string, t: string, color = "#6366F140") => {
    const key = `${s}|${t}`;
    if (!linkSet.has(key)) { linkSet.add(key); links.push({ source: s, target: t, color }); }
  };

  for (const e of dialogue) {
    for (const raw of [e.fromAgent, e.toAgent]) {
      if (!raw) continue;
      const key = raw.toLowerCase().replace(/[^a-z_]/g, "_");
      if (seenAgents.has(key)) continue;
      const profile = getAgentProfile(key);
      const isActive = activeAgentId?.toLowerCase().replace(/[^a-z_]/g, "_") === key;
      const rolePrefix = (profile.role ?? "").toUpperCase().replace(/\s+/g, "-");
      const humanName  = profile.name.replace(/^IA-/, "");
      const nodeLabel  = rolePrefix ? `${rolePrefix}-IA-${humanName}` : profile.name;
      const node: FGNode = {
        id: `agent-${key}`, label: nodeLabel, type: "agent",
        color: profile.color, size: isActive ? 10 : 7, isActive,
        detail: profile.avatar,
      };
      seenAgents.set(key, node); nodes.push(node);
    }
    const fk = e.fromAgent.toLowerCase().replace(/[^a-z_]/g, "_");
    const tk = e.toAgent.toLowerCase().replace(/[^a-z_]/g, "_");
    if (fk !== tk && seenAgents.has(fk) && seenAgents.has(tk)) {
      addLink(`agent-${fk}`, `agent-${tk}`, getAgentProfile(fk).color + "60");
    }
  }

  const skipDocs = [".json", "spec__", "raw_response"];
  const visibleDocs = planningDocs.filter(d => !skipDocs.some(p => d.filename.toLowerCase().includes(p)));
  for (let i = 0; i < visibleDocs.length; i++) {
    const doc = visibleDocs[i];
    const phase = inferPhaseFG(doc.filename, doc.creator);
    const color = PHASE_COLOR_FG[phase] ?? "#484F58";
    const agentKey = PHASE_AGENT_KEY[phase] ?? "system";
    const shortName = (doc.filename.split("/").pop() ?? doc.filename).replace(/\.md$/i, "");
    const label = (doc.title ?? shortName).slice(0, 30);
    const nodeId = `doc-${i}`;
    nodes.push({ id: nodeId, label, type: "doc", color, size: 3.5, detail: phase });
    if (seenAgents.has(agentKey)) addLink(`agent-${agentKey}`, nodeId, color + "70");
  }

  const ownerMap: Record<string, string> = {
    DEV: "dev", DEV_WEB: "dev", DEV_BACKEND: "dev", DEV_BACKEND_NODEJS: "dev",
    QA: "qa", QA_WEB: "qa", QA_BACKEND: "qa", QA_BACKEND_NODEJS: "qa",
    DEVOPS: "devops", DEVOPS_DOCKER: "devops", PM: "pm", PM_WEB: "pm",
    PM_BACKEND: "pm", PM_MOBILE: "pm", CTO: "cto", ENGINEER: "engineer", MONITOR: "monitor",
  };
  const agentKeyInDialogue = (ownerRole: string) => {
    const mapped = ownerMap[(ownerRole ?? "").toUpperCase()];
    if (!mapped) return undefined;
    if (seenAgents.has(mapped)) return mapped;
    for (const k of Array.from(seenAgents.keys()))
      if (k.startsWith(mapped) || mapped.startsWith(k.replace(/_.*/, ""))) return k;
    return undefined;
  };

  for (const t of tasks) {
    const color = TASK_COLOR[t.status ?? ""] ?? "#4B5563";
    nodes.push({ id: `task-${t.taskId}`, label: t.taskId, type: "task", color, size: 4, detail: t.status ?? "NEW" });
    const ownerKey = agentKeyInDialogue(t.ownerRole ?? "");
    if (ownerKey) addLink(`agent-${ownerKey}`, `task-${t.taskId}`, color + "70");
  }

  const showable = codeFiles.filter(f => !f.path.includes("node_modules") && !f.path.endsWith(".lock")).slice(0, 20);
  const devAgentKey = Array.from(seenAgents.keys()).find(k => k.startsWith("dev")) ?? null;
  for (let i = 0; i < showable.length; i++) {
    const f = showable[i];
    const color = EXT_COLOR[f.ext] ?? "#8B949E";
    nodes.push({ id: `artifact-${i}`, label: f.path.split("/").pop() ?? f.path, type: "artifact", color, size: 2.5, detail: f.path });
    if (devAgentKey) addLink(`agent-${devAgentKey}`, `artifact-${i}`, color + "50");
  }

  return { nodes, links };
}

// ── Layout position computation ───────────────────────────────────────────────
function computePositions(
  nodes: FGNode[], layout: LayoutMode, W: number, H: number,
): Map<string, { fx: number; fy: number }> | null {
  if (layout === "free" || layout === "flow") return null; // physics handles both free modes

  const map = new Map<string, { fx: number; fy: number }>();
  const cx = 0; const cy = 0;
  const agents    = nodes.filter(n => n.type === "agent");
  const tasks     = nodes.filter(n => n.type === "task");
  const docs      = nodes.filter(n => n.type === "doc");
  const artifacts = nodes.filter(n => n.type === "artifact");
  const rScale    = Math.min(W * 0.45, H * 0.85);

  if (layout === "brain") {
    // Agents: tight inner ellipse (brain core)
    const aR = Math.max(rScale * 0.13, 40);
    agents.forEach((n, i) => {
      const angle = agents.length === 1 ? 0 : (i / agents.length) * 2 * Math.PI;
      map.set(n.id, { fx: cx + aR * Math.cos(angle) * 1.3, fy: cy + aR * Math.sin(angle) * 0.8 });
    });
    // Tasks: first neuron ring
    const tR = Math.max(rScale * 0.32, 100);
    tasks.forEach((n, i) => {
      const angle = (i / Math.max(tasks.length, 1)) * 2 * Math.PI;
      map.set(n.id, { fx: cx + tR * Math.cos(angle), fy: cy + tR * Math.sin(angle) });
    });
    // Docs: second ring
    const dR = Math.max(rScale * 0.52, 160);
    docs.forEach((n, i) => {
      const angle = (i / Math.max(docs.length, 1)) * 2 * Math.PI + Math.PI / 5;
      map.set(n.id, { fx: cx + dR * Math.cos(angle), fy: cy + dR * Math.sin(angle) });
    });
    // Artifacts: outer ring
    const arR = Math.max(rScale * 0.70, 210);
    artifacts.forEach((n, i) => {
      const angle = (i / Math.max(artifacts.length, 1)) * 2 * Math.PI + Math.PI / 8;
      map.set(n.id, { fx: cx + arR * Math.cos(angle), fy: cy + arR * Math.sin(angle) });
    });

  } else if (layout === "radial") {
    const ctoNode = agents.find(n => n.id.includes("cto")) ?? agents[0];
    const others  = agents.filter(n => n !== ctoNode);
    if (ctoNode) map.set(ctoNode.id, { fx: cx, fy: cy });
    const aR = Math.max(rScale * 0.20, 60);
    others.forEach((n, i) => {
      const angle = (i / Math.max(others.length, 1)) * 2 * Math.PI;
      map.set(n.id, { fx: cx + aR * Math.cos(angle), fy: cy + aR * Math.sin(angle) });
    });
    const tR = Math.max(rScale * 0.38, 120);
    tasks.forEach((n, i) => {
      const angle = (i / Math.max(tasks.length, 1)) * 2 * Math.PI;
      map.set(n.id, { fx: cx + tR * Math.cos(angle), fy: cy + tR * Math.sin(angle) });
    });
    const dR = Math.max(rScale * 0.55, 170);
    docs.forEach((n, i) => {
      const angle = (i / Math.max(docs.length, 1)) * 2 * Math.PI + 0.5;
      map.set(n.id, { fx: cx + dR * Math.cos(angle), fy: cy + dR * Math.sin(angle) });
    });
    const arR = Math.max(rScale * 0.70, 220);
    artifacts.forEach((n, i) => {
      const angle = (i / Math.max(artifacts.length, 1)) * 2 * Math.PI + 0.2;
      map.set(n.id, { fx: cx + arR * Math.cos(angle), fy: cy + arR * Math.sin(angle) });
    });

  } else if (layout === "pipeline") {
    const phaseX: Record<string, number> = {
      system: -3.5, spec: -3.5, cto: -2.5, engineer: -1.5, pm: -0.5, monitor: 0.3,
      dev: 1.5, dev_backend: 1.5, dev_web: 1.5,
      qa: 2.5, qa_backend: 2.5, qa_web: 2.5, devops: 3.5,
    };
    const colW = Math.min(rScale * 0.22, 100);

    const agentCols = new Map<number, FGNode[]>();
    for (const n of agents) {
      const key = n.id.replace("agent-", "");
      let phase = -2.5;
      for (const [p, x] of Object.entries(phaseX))
        if (key === p || key.startsWith(p + "_")) { phase = x; break; }
      const col = Math.round(phase * 10);
      if (!agentCols.has(col)) agentCols.set(col, []);
      agentCols.get(col)!.push(n);
    }
    for (const [col, nodesInCol] of Array.from(agentCols.entries())) {
      nodesInCol.forEach((n, i) => {
        map.set(n.id, {
          fx: cx + (col / 10) * colW,
          fy: cy + (i - (nodesInCol.length - 1) / 2) * 45,
        });
      });
    }

    const devColX = cx + 1.5 * colW;
    const taskSpan = Math.min(H * 0.38, 200);
    tasks.forEach((n, i) => {
      map.set(n.id, {
        fx: devColX + (i % 3 - 1) * 22,
        fy: cy - taskSpan / 2 + (i / Math.max(tasks.length - 1, 1)) * taskSpan,
      });
    });

    const phaseDocX: Record<string, number> = {
      spec: -3.5, cto: -2.5, engineer: -1.5, pm: -0.5, qa: 2.5, devops: 3.5, other: 0.5,
    };
    docs.forEach((n, i) => {
      const x = phaseDocX[n.detail ?? "other"] ?? 0.5;
      map.set(n.id, { fx: cx + x * colW + 12, fy: cy + (i % 4 - 1.5) * 28 + 45 });
    });

    const arColX = cx + 3.8 * colW;
    artifacts.forEach((n, i) => {
      map.set(n.id, {
        fx: arColX + (i % 2) * 22,
        fy: cy - (artifacts.length / 2) * 16 + i * 16,
      });
    });
  }

  return map;
}

// ── Component ─────────────────────────────────────────────────────────────────
interface ForceGraphProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number;
  planningDocs?: PlanningDoc[];
}

export function ForceGraph({ projectId, pollIntervalMs = 8000, height = 500, planningDocs = [] }: ForceGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading]     = useState(true);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("free");
  // Start at 0 — ResizeObserver will set the real size; canvas won't render until measured
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [tooltip, setTooltip]     = useState<{ label: string; detail?: string } | null>(null);
  const [justCycled, setJustCycled] = useState(false);
  // Animação de partículas — pulsa quando há agente ativo
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  // Pulso animado — valor 0..1 que oscila para o efeito de luz no agente ativo
  const pulseRef        = useRef<number>(0);
  const rafRef          = useRef<number>(0);

  const containerRef   = useRef<HTMLDivElement>(null);
  const prevSignature  = useRef<string>("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef          = useRef<any>(null);

  // ── ResizeObserver — tracks real container size ───────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setContainerSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Fetch & build graph ───────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const [dialogue, tasks, codeFilesData] = await Promise.all([
        apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`).catch(() => [] as DialogueEntry[]),
        apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`).catch(() => [] as TaskItem[]),
        apiGet<CodeFilesResponse>(`/api/projects/${projectId}/code-files`).catch(() => ({ files: [], appsRoot: null, totalFiles: 0 })),
      ]);
      const lastWorking  = [...(Array.isArray(dialogue) ? dialogue : [])].reverse().find(e => e.eventType === "agent_working");
      const activeAgentId = lastWorking?.fromAgent;
      setActiveAgent(activeAgentId ? activeAgentId.toLowerCase().replace(/[^a-z_]/g, "_") : null);
      const data = buildForceData(
        Array.isArray(dialogue) ? dialogue : [],
        Array.isArray(tasks) ? tasks : [],
        (codeFilesData as CodeFilesResponse).files ?? [],
        activeAgentId, planningDocs,
      );
      const sig = [
        data.nodes.map(n => `${n.id}:${n.isActive ? "A" : ""}:${n.detail ?? ""}`).sort().join("|"),
        data.links.length,
      ].join("§");
      if (sig === prevSignature.current) return;
      prevSignature.current = sig;

      setGraphData(prev => {
        const prevNodeMap = new Map(prev.nodes.map(n => [n.id, n]));
        const merged = data.nodes.map(n => {
          const ex = prevNodeMap.get(n.id) as NodeWithPos | undefined;
          // Preserve physics position (x,y,vx,vy) AND layout pins (fx,fy)
          if (ex) return { ...ex, isActive: n.isActive, detail: n.detail, color: n.color };
          return n;
        });
        return { nodes: merged, links: data.links };
      });
    } catch { /* silent */ } finally { setLoading(false); }
  }, [projectId, planningDocs]);

  useEffect(() => {
    refresh();
    if (pollIntervalMs > 0) { const t = setInterval(refresh, pollIntervalMs); return () => clearInterval(t); }
  }, [refresh, pollIntervalMs]);

  // ── RAF loop para pulso do agente ativo ───────────────────────────────────
  useEffect(() => {
    if (!activeAgent) { pulseRef.current = 0; return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      pulseRef.current = (Math.sin((now - t0) / 400) + 1) / 2; // 0..1, ~2.5Hz
      fgRef.current?.refresh?.(); // força repaint do canvas sem re-render React
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeAgent]);

  // ── Apply layout whenever mode or container size changes ──────────────────
  useEffect(() => {
    if (graphData.nodes.length === 0) return;
    const positions = computePositions(graphData.nodes, layoutMode, containerSize.width, containerSize.height);

    setGraphData(prev => {
      // Ao trocar de layout, resetar links para strings puras (IDs) para forçar
      // o ForceGraph2D a re-resolver source/target do zero.
      // Sem isso, links resolvidos para objetos de nós anteriores ficam apontando
      // para nós com posições erradas após a mutação de fx/fy.
      const freshLinks = prev.links.map(l => ({
        ...l,
        source: typeof l.source === "object" ? (l.source as FGNode).id : l.source as string,
        target: typeof l.target === "object" ? (l.target as FGNode).id : l.target as string,
      }));
      return {
      ...prev,
      links: freshLinks,
      nodes: prev.nodes.map(n => {
        const nw = n as NodeWithPos;
        if (!positions) {
          // Free: strip fx/fy so physics takes over
          const copy = { ...nw };
          delete (copy as NodeWithPos).fx;
          delete (copy as NodeWithPos).fy;
          return copy as FGNode;
        }
        const pos = positions.get(n.id);
        return pos ? { ...nw, fx: pos.fx, fy: pos.fy } : { ...nw };
      }),
    }; }); // fechamento do setGraphData

    // Reheat physics so nodes animate to new positions
    setTimeout(() => fgRef.current?.d3ReheatSimulation?.(), 30);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, containerSize.width, containerSize.height]);

  // ── Cycle layout on background click ─────────────────────────────────────
  const handleBackgroundClick = useCallback(() => {
    setLayoutMode(prev => {
      const idx = LAYOUT_CYCLE.indexOf(prev);
      // Último da lista → volta ao primeiro ("free") em vez de wrap implícito
      return LAYOUT_CYCLE[(idx + 1) % LAYOUT_CYCLE.length];
    });
    setJustCycled(true);
    setTimeout(() => setJustCycled(false), 1200);
  }, []);

  // Reset explícito para "free" (clique duplo no badge ou botão)
  const handleResetLayout = useCallback(() => {
    setLayoutMode("free");
    setJustCycled(true);
    setTimeout(() => setJustCycled(false), 1200);
    setTimeout(() => fgRef.current?.d3ReheatSimulation?.(), 30);
  }, []);

  // ── Enriquecer links: bidirecional + espessura + partículas por relação ──
  const displayLinks = useMemo(() => {
    const existing = new Set(graphData.links.map(l => {
      const s = typeof l.source === "object" ? (l.source as FGNode).id : l.source as string;
      const t = typeof l.target === "object" ? (l.target as FGNode).id : l.target as string;
      return `${s}|${t}`;
    }));

    // Sempre adicionar links reversos para pares bidirecionais (não só no brain)
    const reversed: FGLink[] = [];
    for (const l of graphData.links) {
      const s = typeof l.source === "object" ? (l.source as FGNode).id : l.source as string;
      const t = typeof l.target === "object" ? (l.target as FGNode).id : l.target as string;
      const sk = s.replace("agent-", ""); const tk = t.replace("agent-", "");
      if (s.startsWith("agent-") && t.startsWith("agent-") &&
          (BIDIRECTIONAL_PAIRS.has(`${sk}|${tk}`) || BIDIRECTIONAL_PAIRS.has(`${tk}|${sk}`)) &&
          !existing.has(`${t}|${s}`)) {
        reversed.push({ source: t, target: s, color: l.color });
      }
    }

    return [...graphData.links, ...reversed].map(l => {
      const s = typeof l.source === "object" ? (l.source as FGNode).id : l.source as string;
      const t = typeof l.target === "object" ? (l.target as FGNode).id : l.target as string;
      const isAgentLink = s.startsWith("agent-") && t.startsWith("agent-");
      const sk = s.replace("agent-", ""); const tk = t.replace("agent-", "");
      const isBidi = BIDIRECTIONAL_PAIRS.has(`${sk}|${tk}`);
      // Link fica mais vivo quando o agente de origem ou destino está ativo
      const isHot = activeAgent && (sk === activeAgent || tk === activeAgent);
      return {
        ...l,
        _width:     isBidi ? 2.5 : isAgentLink ? 1.5 : 1,
        _particles: isBidi ? (isHot ? 6 : 3) : isAgentLink ? (isHot ? 4 : 2) : 1,
        _pWidth:    isBidi ? (isHot ? 3.5 : 2) : 1.5,
        _color:     isHot ? (l.color.slice(0, 7) + "FF") : l.color,
      };
    });
  }, [graphData.links, activeAgent]);

  // ── Node canvas painter ───────────────────────────────────────────────────
  const paintNode = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as FGNode & { x?: number; y?: number };
    if (!isFinite(n.x ?? NaN) || !isFinite(n.y ?? NaN)) return;
    const x = n.x as number; const y = n.y as number;
    const r = (n.size ?? 5) * (n.isActive ? 1.4 : 1);
    const pulse = pulseRef.current; // 0..1 oscilando via RAF

    if (n.isActive) {
      // Halo pulsante — 3 anéis concêntricos com opacidade variável
      const haloR1 = r * (2.2 + pulse * 1.0);
      const haloR2 = r * (3.5 + pulse * 1.5);
      const haloR3 = r * (5.0 + pulse * 2.0);
      const alpha1 = Math.round((0.45 + pulse * 0.35) * 255).toString(16).padStart(2, "0");
      const alpha2 = Math.round((0.25 + pulse * 0.20) * 255).toString(16).padStart(2, "0");
      const alpha3 = Math.round((0.10 + pulse * 0.10) * 255).toString(16).padStart(2, "0");

      // Anel 1 — mais próximo, mais denso
      ctx.beginPath(); ctx.arc(x, y, haloR1, 0, 2 * Math.PI);
      const g1 = ctx.createRadialGradient(x, y, r, x, y, haloR1);
      g1.addColorStop(0, n.color + alpha1); g1.addColorStop(1, n.color + "00");
      ctx.fillStyle = g1; ctx.fill();

      // Anel 2 — médio
      ctx.beginPath(); ctx.arc(x, y, haloR2, 0, 2 * Math.PI);
      const g2 = ctx.createRadialGradient(x, y, haloR1 * 0.6, x, y, haloR2);
      g2.addColorStop(0, n.color + alpha2); g2.addColorStop(1, n.color + "00");
      ctx.fillStyle = g2; ctx.fill();

      // Anel 3 — externo, suave
      ctx.beginPath(); ctx.arc(x, y, haloR3, 0, 2 * Math.PI);
      const g3 = ctx.createRadialGradient(x, y, haloR2 * 0.7, x, y, haloR3);
      g3.addColorStop(0, n.color + alpha3); g3.addColorStop(1, n.color + "00");
      ctx.fillStyle = g3; ctx.fill();

      // Borda pulsante brilhante
      ctx.beginPath(); ctx.arc(x, y, r + 1.5 + pulse * 2, 0, 2 * Math.PI);
      ctx.strokeStyle = n.color + Math.round((0.6 + pulse * 0.4) * 255).toString(16).padStart(2, "0");
      ctx.lineWidth = 1.5 + pulse * 1.5; ctx.stroke();
    }

    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = n.type === "agent" ? n.color : n.color + "CC";
    ctx.fill();

    if (n.type === "agent") {
      ctx.strokeStyle = n.color; ctx.lineWidth = n.isActive ? 2 : 0.8; ctx.stroke();
    }

    const drawCentered = (text: string, cx2: number, cy2: number, fontSize: number, font: string) => {
      ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(text);
      const ascent  = m.actualBoundingBoxAscent  ?? fontSize * 0.7;
      const descent = m.actualBoundingBoxDescent ?? fontSize * 0.2;
      ctx.fillText(text, cx2, cy2 + (ascent - descent) / 2);
    };

    if (n.type === "agent") {
      const es = Math.max(r * 1.05, 6);
      ctx.fillStyle = "#FFFFFF";
      drawCentered(n.detail ?? "🤖", x, y, es, `${es}px serif`);
    } else if (n.type === "task") {
      const icon = n.detail === "DONE" || n.detail === "QA_PASS" ? "✓"
        : n.detail === "IN_PROGRESS" || n.detail === "WAITING_REVIEW" ? "⟳"
        : n.detail === "QA_FAIL" || n.detail === "BLOCKED" ? "✗" : "·";
      const ts = Math.max(r * 0.85, 4); ctx.fillStyle = "#E6EDF3";
      drawCentered(icon, x, y, ts, `bold ${ts}px Inter, sans-serif`);
    } else if (n.type === "doc") {
      const iconMap: Record<string, string> = { cto: "🎯", engineer: "⚙️", pm: "📋", qa: "✅", devops: "🐳", spec: "📄", other: "📁" };
      const ds = Math.max(r * 0.85, 4);
      drawCentered(iconMap[n.detail ?? "other"] ?? "📁", x, y, ds, `${ds}px serif`);
    }

    const fontSize = Math.max(10 / globalScale, 1.5);
    if (globalScale > 0.6 || n.type === "agent") {
      ctx.font = `${n.type === "agent" ? "bold " : ""}${fontSize}px Inter, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = n.type === "agent" ? "#E6EDF3" : n.color;
      ctx.fillText(n.label, x, y + r + fontSize * 1.1);
    }
  }, []);

  // Canvas dims: use measured size; fall back to prop only if observer hasn't fired yet
  const canvasW = containerSize.width  || 800;
  const canvasH = containerSize.height || height;

  if (loading) {
    return (
      <Box ref={containerRef} sx={{ height: "100%", minHeight: height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1 }}>
        <Typography variant="body2" color="text.secondary">Inicializando física…</Typography>
      </Box>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <Box ref={containerRef} sx={{ height: "100%", minHeight: height, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#0D0F14", borderRadius: 1, flexDirection: "column", gap: 1 }}>
        <Typography variant="body2" color="text.secondary">Sem dados ainda.</Typography>
        <Typography variant="caption" color="text.secondary">O grafo cresce conforme os agentes trabalham.</Typography>
      </Box>
    );
  }

  const meta = LAYOUT_META[layoutMode];

  return (
    <Box
      ref={containerRef}
      sx={{ height: "100%", minHeight: height, bgcolor: "#0D0F14", borderRadius: 1, overflow: "hidden", position: "relative" }}
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={{ nodes: graphData.nodes as object[], links: displayLinks as object[] }}
        width={canvasW}
        height={canvasH}
        backgroundColor="#0D0F14"
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => "replace"}
        linkColor={(link) => (link as FGLink & { _color?: string })._color ?? (link as FGLink).color}
        linkWidth={(link) => (link as FGLink & { _width?: number })._width ?? 1}
        linkCurvature={(link) => {
          const s = typeof (link as FGLink).source === "object" ? ((link as FGLink).source as FGNode).id : (link as FGLink).source as string;
          const t = typeof (link as FGLink).target === "object" ? ((link as FGLink).target as FGNode).id : (link as FGLink).target as string;
          const sk = s.replace("agent-", ""); const tk = t.replace("agent-", "");
          const isBidi = BIDIRECTIONAL_PAIRS.has(`${sk}|${tk}`);
          // flow: curvas orgânicas em todos os links de agente; bidi: mais curvado
          if (layoutMode === "flow") return isBidi ? 0.4 : 0.15;
          return isBidi ? 0.2 : 0;
        }}
        linkDirectionalParticles={(link) => (link as FGLink & { _particles?: number })._particles ?? 1}
        linkDirectionalParticleWidth={(link) => (link as FGLink & { _pWidth?: number })._pWidth ?? 1.5}
        linkDirectionalParticleColor={(link) => (link as FGLink & { _color?: string })._color ?? (link as FGLink).color}
        linkDirectionalParticleSpeed={0.005}
        linkDirectionalArrowLength={(link) => {
          const s = typeof (link as FGLink).source === "object" ? ((link as FGLink).source as FGNode).id : (link as FGLink).source as string;
          const t = typeof (link as FGLink).target === "object" ? ((link as FGLink).target as FGNode).id : (link as FGLink).target as string;
          return s.startsWith("agent-") && t.startsWith("agent-") ? 5 : 0;
        }}
        linkDirectionalArrowRelPos={0.85}
        nodeRelSize={1}
        d3AlphaDecay={layoutMode === "free" || layoutMode === "flow" ? 0.02 : 0.025}
        d3VelocityDecay={layoutMode === "free" || layoutMode === "flow" ? 0.3 : 0.45}
        cooldownTicks={layoutMode === "free" || layoutMode === "flow" ? 120 : 100}
        onBackgroundClick={handleBackgroundClick}
        onNodeHover={(node) => {
          if (!node) { setTooltip(null); return; }
          const n = node as FGNode;
          setTooltip({ label: n.label, detail: n.detail });
        }}
        onNodeClick={(node) => {
          const n = node as FGNode;
          setTooltip({ label: n.label, detail: n.detail });
        }}
      />

      {/* Layout badge — top right — clicável para reset */}
      <Box sx={{ position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5 }}>
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
          {/* Botão reset — só aparece quando não está em "free" */}
          {layoutMode !== "free" && (
            <Chip
              label="↩ reset"
              size="small"
              onClick={handleResetLayout}
              sx={{
                bgcolor: "#161B22EE", color: "#6366F1",
                border: "1px solid #6366F155", fontSize: "0.6rem", height: 22,
                cursor: "pointer",
                "&:hover": { bgcolor: "#6366F122", borderColor: "#6366F1" },
                transition: "all 0.2s ease",
              }}
            />
          )}
          <Chip
            label={`${meta.icon} ${meta.label}`}
            size="small"
            sx={{
              bgcolor: justCycled ? "#6366F1" : "#161B22EE",
              color: justCycled ? "#fff" : "#8B949E",
              border: "1px solid",
              borderColor: justCycled ? "#6366F1" : "#30363D",
              fontSize: "0.65rem", height: 22,
              pointerEvents: "none",
              transition: "all 0.3s ease",
            }}
          />
        </Box>
        <Typography variant="caption" sx={{ color: "#484F58", fontSize: "0.58rem", textAlign: "right", maxWidth: 160, lineHeight: 1.3, pointerEvents: "none" }}>
          {justCycled ? meta.tip : "clique no fundo para próximo layout"}
        </Typography>
      </Box>

      {/* Tooltip */}
      {tooltip && (
        <Box sx={{ position: "absolute", top: 8, left: 8, bgcolor: "#161B22EE", border: "1px solid #30363D", borderRadius: 1, px: 1.5, py: 1, maxWidth: 220, pointerEvents: "none" }}>
          <Typography variant="caption" fontWeight={600} color="text.primary">{tooltip.label}</Typography>
          {tooltip.detail && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>{tooltip.detail}</Typography>
          )}
        </Box>
      )}

      {/* Legend */}
      <Box sx={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 1.5, flexWrap: "wrap", pointerEvents: "none" }}>
        {[
          { color: "#6366F1", label: "Agente" }, { color: "#10B981", label: "Task OK" },
          { color: "#EF4444", label: "Task Fail" }, { color: "#61DAFB", label: "Artefato" },
        ].map(item => (
          <Box key={item.label} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: item.color }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.6rem" }}>{item.label}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
