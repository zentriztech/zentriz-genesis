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

export interface DocNodeData extends Record<string, unknown> {
  nodeType: "doc";
  filename: string;
  title: string;
  creator: string;          // agent id
  createdAt: string;
  phase: "spec" | "cto" | "engineer" | "pm" | "qa" | "devops" | "other";
}

export type GraphNode = Node<AgentNodeData | TaskNodeData | ArtifactNodeData | DocNodeData>;
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
}

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
  const { dialogueEntries, tasks, codeFiles, activeAgentId } = input;
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
    const profile = getAgentProfile(key);
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

  // ── 2. Doc nodes (planning phase documents — between agents and tasks) ────────
  const planningDocs = input.planningDocs ?? [];
  // Skip raw JSON dumps and spec upload files
  const skipPatterns = [".json", "spec__", "raw_response"];
  const visibleDocs = planningDocs.filter((d) =>
    !skipPatterns.some((p) => d.filename.toLowerCase().includes(p))
  );

  const DOC_START_X = 900; // to the right of agent chain
  const DOC_ROW_Y   = 0;
  const DOC_ROW_H   = 70;

  for (let idx = 0; idx < visibleDocs.length; idx++) {
    const doc   = visibleDocs[idx];
    const phase = inferDocPhase(doc.filename, doc.creator);
    const agentKey = PHASE_AGENT[phase];
    const nodeId = `doc-${idx}`;

    nodes.push({
      id: nodeId,
      type: "docNode",
      position: { x: DOC_START_X, y: DOC_ROW_Y + idx * DOC_ROW_H },
      data: {
        nodeType: "doc",
        filename: doc.filename,
        title: doc.title ?? doc.filename,
        creator: doc.creator ?? agentKey,
        createdAt: doc.created_at ?? "",
        phase,
      } satisfies DocNodeData,
    });

    // Edge: agent → doc
    if (seenAgents.has(agentKey)) {
      addEdge(`agent-${agentKey}`, nodeId, {
        style: { stroke: "#F59E0B55", strokeWidth: 1, strokeDasharray: "4 3" },
      });
    }
  }

  // ── 4. Task nodes (below agents) ─────────────────────────────────────────────
  const TASK_ROW_Y   = 160;
  const TASK_COLS    = 4;
  const TASK_COL_W   = 180;
  const TASK_ROW_H   = 90;

  const ownerAgentMap: Record<string, string> = {
    DEV: "dev", DEV_WEB: "dev", DEV_BACKEND: "dev_backend",
    QA: "qa", QA_WEB: "qa", QA_BACKEND: "qa_backend",
    DEVOPS: "devops", DEVOPS_DOCKER: "devops_docker",
    PM: "pm", PM_WEB: "pm_web", CTO: "cto", ENGINEER: "engineer", MONITOR: "monitor",
  };

  for (let idx = 0; idx < tasks.length; idx++) {
    const task    = tasks[idx];
    const col     = idx % TASK_COLS;
    const row     = Math.floor(idx / TASK_COLS);
    const nodeId  = `task-${task.taskId}`;

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

    // Edge: ownerAgent → task
    const rawOwner = task.ownerRole?.toUpperCase() ?? "";
    const ownerKey = ownerAgentMap[rawOwner];
    if (ownerKey && seenAgents.has(ownerKey)) {
      addEdge(`agent-${ownerKey}`, nodeId, {
        style: { stroke: "#6366F166", strokeWidth: 1, strokeDasharray: "4 3" },
      });
    }
  }

  // ── 3. Artifact nodes (show top N, right side) ───────────────────────────────
  const ART_START_Y  = 160;
  const ART_COL_X    = TASK_COLS * TASK_COL_W + 40;
  const ART_ROW_H    = 50;
  const MAX_ARTS     = 12;

  // Show only code files (filter out config/lock)
  const showable = codeFiles
    .filter((f) => !f.path.includes("node_modules") && !f.path.endsWith(".lock"))
    .slice(0, MAX_ARTS);

  for (let idx = 0; idx < showable.length; idx++) {
    const file   = showable[idx];
    const nodeId = `artifact-${idx}`;
    nodes.push({
      id:       nodeId,
      type:     "artifactNode",
      position: { x: ART_COL_X, y: ART_START_Y + idx * ART_ROW_H },
      data: {
        nodeType:  "artifact",
        path:      file.path,
        ext:       file.ext,
        sizeBytes: file.sizeBytes,
      } satisfies ArtifactNodeData,
    });

    // Edge: dev agent → artifact (if visible)
    if (seenAgents.has("dev")) {
      addEdge("agent-dev", nodeId, {
        style: { stroke: "#10B98144", strokeWidth: 1, strokeDasharray: "3 4" },
      });
    }
  }

  return { nodes, edges };
}
