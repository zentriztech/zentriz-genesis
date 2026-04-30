/**
 * useGraphData — transforma dialogue + tasks + artifacts + docs em nós e arestas.
 *
 * Grafo:
 *   AgentNode (agente que apareceu no diálogo)
 *     ├─→ DocNode   (documentos gerados durante planejamento: spec, charter, backlog, proposals)
 *     ├─→ TaskNode  (tasks do Monitor Loop)
 *     └─→ ArtifactNode (arquivos gerados em apps/ pelo Dev)
 */

import type { Node, Edge } from "@xyflow/react";
import type { DialogueEntry } from "@/components/LiveDialogue";
import { getAgentProfile } from "@/lib/agentProfiles";

// ── Types de dados extras nos nós ─────────────────────────────────────────────
export interface AgentNodeData extends Record<string, unknown> {
  nodeType: "agent";
  agentId: string;
  name: string;
  avatar: string;
  color: string;
  isActive: boolean;
  lastMessage?: string;
}

export interface TaskNodeData extends Record<string, unknown> {
  nodeType: "task";
  taskId: string;
  requirements?: string;
  status: string;
  ownerRole?: string;
}

export interface ArtifactNodeData extends Record<string, unknown> {
  nodeType: "artifact";
  path: string;
  ext: string;
  sizeBytes: number;
}

export interface ArtifactGroupNodeData extends Record<string, unknown> {
  nodeType: "artifactGroup";
  dir: string;
  files: { path: string; ext: string; sizeBytes: number }[];
  expanded: boolean;
  onToggle: () => void;
}

export interface DocNodeData extends Record<string, unknown> {
  nodeType: "doc";
  filename: string;
  title: string;
  creator: string;          // agent id
  createdAt: string;
  phase: "spec" | "cto" | "engineer" | "pm" | "qa" | "devops" | "other";
}

export type GraphNode = Node<AgentNodeData | TaskNodeData | ArtifactNodeData | ArtifactGroupNodeData | DocNodeData>;
export type GraphEdge = Edge;

// ── Pipeline stages (ordem de execução) ──────────────────────────────────────
const AGENT_X: Record<string, number> = {
  system: 0, cto: 1, engineer: 2, pm: 3, dev: 4, qa: 5, monitor: 6, devops: 7,
};

function agentX(id: string): number {
  return (AGENT_X[id.toLowerCase().replace(/_.*/, "")] ?? 4) * 170;
}

// ── Build graph from data ─────────────────────────────────────────────────────
export interface PlanningDoc {
  filename: string;
  title?: string;
  creator?: string;
  created_at?: string;
}

export interface GraphDataInput {
  dialogueEntries: DialogueEntry[];
  tasks: Array<{ id: string; taskId: string; ownerRole?: string; requirements?: string; status?: string }>;
  codeFiles: Array<{ path: string; sizeBytes: number; ext: string }>;
  planningDocs?: PlanningDoc[];  // from /api/projects/:id/artifacts manifest
  activeAgentId?: string;
  projectId?: string;            // para nomes de agentes por projeto
  expandedGroups?: Set<string>;          // which artifact group dirs are expanded
  onToggleGroup?: (dir: string) => void; // callback from parent
  filter?: GraphFilter;          // filtro de visibilidade
}

// ── Filtro de visibilidade do grafo ──────────────────────────────────────────
export interface GraphFilter {
  tasksDone:     boolean;   // DONE, QA_PASS
  tasksPending:  boolean;   // ASSIGNED, NEW, BLOCKED, QA_FAIL (IN_PROGRESS sempre visível)
  docsSpec:      boolean;
  docsCto:       boolean;
  docsEngineer:  boolean;
  docsPm:        boolean;
  docsQa:        boolean;
  docsDevops:    boolean;
  artifacts:     boolean;
}

export const DEFAULT_FILTER: GraphFilter = {
  tasksDone:    false,
  tasksPending: false,
  docsSpec:     true,
  docsCto:      true,
  docsEngineer: true,
  docsPm:       true,
  docsQa:       false,
  docsDevops:   false,
  artifacts:    false,
};

// Map filename patterns to phase and creator agent
function inferDocPhase(filename: string, creator?: string): DocNodeData["phase"] {
  const f = filename.toLowerCase();
  const c = (creator ?? "").toLowerCase();
  if (f.includes("spec") || c === "spec") return "spec";
  if (f.includes("cto") || c === "cto") return "cto";
  if (f.includes("engineer") || c === "engineer") return "engineer";
  if (f.includes("pm") || f.includes("backlog") || c === "pm") return "pm";
  if (f.includes("qa") || c === "qa") return "qa";
  if (f.includes("devops") || f.includes("runbook") || c === "devops") return "devops";
  return "other";
}

const PHASE_AGENT: Record<DocNodeData["phase"], string> = {
  spec: "system", cto: "cto", engineer: "engineer",
  pm: "pm", qa: "qa", devops: "devops", other: "system",
};

export function buildGraphData(input: GraphDataInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { dialogueEntries, tasks, codeFiles, activeAgentId, projectId, expandedGroups, onToggleGroup } = input;
  const f = { ...DEFAULT_FILTER, ...(input.filter ?? {}) };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenAgents = new Set<string>();
  const edgeSet    = new Set<string>();

  function addEdge(source: string, target: string, opts?: Partial<GraphEdge>) {
    const key = `${source}->${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ id: key, source, target, ...opts });
  }

  // ── 1. Agent nodes (from dialogue) ──────────────────────────────────────────
  const agentMessages: Record<string, string> = {};
  for (const entry of dialogueEntries) {
    const raw = entry.fromAgent.toLowerCase();
    const key = raw.replace(/[^a-z]/g, "_");
    if (!seenAgents.has(key)) seenAgents.add(key);
    agentMessages[key] = entry.summaryHuman?.slice(0, 80) ?? "";
  }

  const sortedAgents = Array.from(seenAgents).sort(
    (a, b) => (AGENT_X[a.replace(/_.*/, "")] ?? 99) - (AGENT_X[b.replace(/_.*/, "")] ?? 99),
  );

  for (let i = 0; i < sortedAgents.length; i++) {
    const key     = sortedAgents[i];
    const profile = getAgentProfile(key, projectId);
    const isActive = activeAgentId ? key === activeAgentId.toLowerCase().replace(/[^a-z]/g, "_") : false;
    nodes.push({
      id:       `agent-${key}`,
      type:     "agentNode",
      position: { x: agentX(key), y: 0 },
      data: {
        nodeType: "agent",
        agentId:  key,
        name:     profile.name,
        avatar:   profile.avatar,
        color:    profile.color,
        isActive,
        lastMessage: agentMessages[key],
      } satisfies AgentNodeData,
    });

    // Chain: agente[i] → agente[i+1]
    if (i > 0) {
      const prev = sortedAgents[i - 1];
      addEdge(`agent-${prev}`, `agent-${key}`, {
        animated: isActive,
        style: { stroke: "#6366F1", strokeWidth: isActive ? 2 : 1 },
      });
    }
  }

  // ── Monitor: ligado a todos os agentes com ida e volta ────────────────────────
  // O Monitor orquestra Dev → QA → DevOps. Se estiver presente no grafo,
  // conectá-lo a todos os outros agentes (exceto system/error) para mostrar
  // que ele coordena o pipeline inteiro — causa boa impressão visual.
  const MONITOR_ORCHESTRATED = ["dev", "dev_backend", "dev_web", "dev_backend_nodejs",
    "dev_backend_python", "qa", "qa_backend", "qa_web", "devops", "devops_docker"];
  const monitorKey = sortedAgents.find(k => k.startsWith("monitor"));
  if (monitorKey) {
    for (const agentKey of sortedAgents) {
      if (agentKey === monitorKey) continue;
      if (agentKey === "system" || agentKey === "error") continue;
      const base = agentKey.replace(/_.*/, "");
      if (!MONITOR_ORCHESTRATED.includes(base) && !MONITOR_ORCHESTRATED.includes(agentKey)) continue;
      const isMonitorActive = activeAgentId?.toLowerCase().includes("monitor");
      // ida: monitor → agente
      addEdge(`agent-${monitorKey}`, `agent-${agentKey}`, {
        animated: !!isMonitorActive,
        style: { stroke: "#5e35b155", strokeWidth: 1, strokeDasharray: "5 3" },
      });
      // volta: agente → monitor
      addEdge(`agent-${agentKey}`, `agent-${monitorKey}`, {
        animated: !!isMonitorActive,
        style: { stroke: "#5e35b133", strokeWidth: 1, strokeDasharray: "3 5" },
      });
    }
  }

  // ── Layout constants ──────────────────────────────────────────────────────────
  // Agents are placed in a horizontal row at Y=0.
  // Docs belonging to each agent alternate above (Y<0) and below (Y>0) that agent.
  // Tasks are placed in a grid below the agent row.
  // Artifact groups are placed to the right of the dev agent, alternating above/below.

  const AGENT_SPACING_X = 220;  // horizontal gap between agents
  const AGENT_Y         = 0;

  // Recompute agent X positions evenly spaced (override the rough AGENT_X map)
  const agentPositions = new Map<string, number>(); // key → x
  sortedAgents.forEach((key, i) => {
    agentPositions.set(key, i * AGENT_SPACING_X);
  });

  // Update already-added agent nodes with new positions
  for (const node of nodes) {
    if (node.type === "agentNode") {
      const key = (node.data as AgentNodeData).agentId;
      const x   = agentPositions.get(key);
      if (x !== undefined) node.position = { x, y: AGENT_Y };
    }
  }

  // ── 2. Doc nodes — grouped per agent, alternating above/below ────────────────
  const planningDocs = input.planningDocs ?? [];
  const skipPatterns = [".json", "spec__", "raw_response"];
  const phaseVisible: Record<DocNodeData["phase"], boolean> = {
    spec:     f.docsSpec,
    cto:      f.docsCto,
    engineer: f.docsEngineer,
    pm:       f.docsPm,
    qa:       f.docsQa,
    devops:   f.docsDevops,
    other:    false,  // nunca exibir "other" no grafo
  };
  const visibleDocs = planningDocs.filter((d) => {
    if (skipPatterns.some((p) => d.filename.toLowerCase().includes(p))) return false;
    return phaseVisible[inferDocPhase(d.filename, d.creator)] ?? false;
  });

  // Bucket docs by their owning agent
  const docsByAgent = new Map<string, typeof visibleDocs>();
  for (const doc of visibleDocs) {
    const phase    = inferDocPhase(doc.filename, doc.creator);
    const agentKey = PHASE_AGENT[phase];
    if (!docsByAgent.has(agentKey)) docsByAgent.set(agentKey, []);
    docsByAgent.get(agentKey)!.push(doc);
  }

  const DOC_H    = 56;   // approximate height of a docNode
  const DOC_W    = 170;  // approximate width
  const DOC_GAP  = 10;

  let globalDocIdx = 0;
  for (const agentKey of sortedAgents) {
    const agentX2 = agentPositions.get(agentKey) ?? 0;
    const agentDocs = docsByAgent.get(agentKey) ?? [];

    agentDocs.forEach((doc, localIdx) => {
      const nodeId    = `doc-${globalDocIdx++}`;
      const phase     = inferDocPhase(doc.filename, doc.creator);
      const isAbove   = localIdx % 2 === 0;           // alternate above/below
      const stackIdx  = Math.floor(localIdx / 2);     // how many on this side
      const ySign     = isAbove ? -1 : 1;
      const yOffset   = 120 + stackIdx * (DOC_H + DOC_GAP);
      const xOffset   = (localIdx % 2 === 0 ? 0 : DOC_W * 0.15); // slight stagger

      nodes.push({
        id:   nodeId,
        type: "docNode",
        position: {
          x: agentX2 - DOC_W * 0.3 + xOffset,
          y: AGENT_Y + ySign * yOffset,
        },
        data: {
          nodeType:  "doc",
          filename:  doc.filename,
          title:     doc.title ?? doc.filename,
          creator:   doc.creator ?? agentKey,
          createdAt: doc.created_at ?? "",
          phase,
        } satisfies DocNodeData,
      });

      addEdge(`agent-${agentKey}`, nodeId, {
        style: { stroke: "#F59E0B55", strokeWidth: 1, strokeDasharray: "4 3" },
      });
    });
  }

  // ── 3. Task nodes — grid below agent row ─────────────────────────────────────
  const TASK_ROW_Y  = 280;   // below the docs-above zone
  const TASK_COLS   = 4;
  const TASK_COL_W  = 180;
  const TASK_ROW_H  = 90;

  const ownerAgentMap: Record<string, string> = {
    DEV: "dev", DEV_WEB: "dev", DEV_BACKEND: "dev_backend",
    QA: "qa", QA_WEB: "qa", QA_BACKEND: "qa_backend",
    DEVOPS: "devops", DEVOPS_DOCKER: "devops_docker",
    PM: "pm", PM_WEB: "pm_web", CTO: "cto", ENGINEER: "engineer", MONITOR: "monitor",
  };

  const DONE_STATUSES    = new Set(["DONE", "QA_PASS"]);
  const ACTIVE_STATUSES  = new Set(["IN_PROGRESS", "WAITING_REVIEW"]);
  const filteredTasks = tasks.filter(t => {
    const s = t.status ?? "NEW";
    if (ACTIVE_STATUSES.has(s)) return true;          // IN_PROGRESS sempre visível
    if (DONE_STATUSES.has(s))   return f.tasksDone;
    return f.tasksPending;                             // NEW, ASSIGNED, BLOCKED, QA_FAIL
  });

  for (let idx = 0; idx < filteredTasks.length; idx++) {
    const task   = filteredTasks[idx];
    const col    = idx % TASK_COLS;
    const row    = Math.floor(idx / TASK_COLS);
    const nodeId = `task-${task.taskId}`;

    nodes.push({
      id:       nodeId,
      type:     "taskNode",
      position: { x: col * TASK_COL_W, y: TASK_ROW_Y + row * TASK_ROW_H },
      data: {
        nodeType:     "task",
        taskId:       task.taskId,
        requirements: task.requirements?.slice(0, 60),
        status:       task.status ?? "NEW",
        ownerRole:    task.ownerRole,
      } satisfies TaskNodeData,
    });

    const rawOwner = task.ownerRole?.toUpperCase() ?? "";
    const ownerKey = ownerAgentMap[rawOwner];
    if (ownerKey && seenAgents.has(ownerKey)) {
      addEdge(`agent-${ownerKey}`, nodeId, {
        style: { stroke: "#6366F166", strokeWidth: 1, strokeDasharray: "4 3" },
      });
    }
  }

  // ── 4. Artifact groups — right of dev agent, alternating above/below ─────────
  if (!f.artifacts) return { nodes, edges };  // artefatos desativados pelo filtro

  const showableFiles = codeFiles.filter(
    (f) => !f.path.includes("node_modules") && !f.path.endsWith(".lock")
  );

  const groupMap = new Map<string, typeof showableFiles>();
  for (const f of showableFiles) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    if (!groupMap.has(dir)) groupMap.set(dir, []);
    groupMap.get(dir)!.push(f);
  }

  const sortedDirs = Array.from(groupMap.keys()).sort((a, b) => {
    if (a === ".") return 1; if (b === ".") return -1;
    return a.localeCompare(b);
  });

  const devKey    = Array.from(seenAgents).find(k => k.startsWith("dev")) ?? null;
  const devAgentX = devKey ? (agentPositions.get(devKey) ?? 0) : (sortedAgents.length * AGENT_SPACING_X);
  const ART_X     = devAgentX + AGENT_SPACING_X * 0.6;
  const ART_COL_W = 200;
  const NODE_H_COLLAPSED = 72;

  sortedDirs.forEach((dir, idx) => {
    const files    = groupMap.get(dir)!;
    const nodeId   = `artifactGroup-${idx}`;
    const expanded = expandedGroups?.has(dir) ?? false;
    const nodeH    = expanded ? NODE_H_COLLAPSED + files.length * 28 : NODE_H_COLLAPSED;

    // Alternate: even indices above agent row, odd below
    const isAbove  = idx % 2 === 0;
    const stackIdx = Math.floor(idx / 2);
    const xPos     = ART_X + stackIdx * (ART_COL_W + 12);
    const yPos     = isAbove
      ? AGENT_Y - 120 - (expanded ? nodeH * 0.5 : 0)
      : AGENT_Y + 120;

    nodes.push({
      id:       nodeId,
      type:     "artifactGroupNode",
      position: { x: xPos, y: yPos },
      data: {
        nodeType: "artifactGroup",
        dir,
        files,
        expanded,
        onToggle: onToggleGroup ? () => onToggleGroup(dir) : () => {},
      } satisfies ArtifactGroupNodeData,
    });

    if (devKey) {
      addEdge(`agent-${devKey}`, nodeId, {
        style: { stroke: "#10B98144", strokeWidth: 1, strokeDasharray: "3 4" },
      });
    }
  });

  return { nodes, edges };
}
