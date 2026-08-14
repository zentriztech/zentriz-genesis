"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import { apiGet } from "@/lib/api";
import { getAgentProfile } from "@/lib/agentProfiles";
import type { DialogueEntry } from "@/components/LiveDialogue";
import { useDialogueStream } from "@/lib/useDialogueStream";
import { DEFAULT_FILTER, type PlanningDoc, type GraphFilter } from "@/lib/useGraphData";
import { forceCollide } from "d3-force";
import dynamic from "next/dynamic";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskItem = { id: string; taskId: string; module?: string; ownerRole?: string; requirements?: string; status?: string; createdAt?: string; updatedAt?: string };
type CodeFile  = { path: string; sizeBytes: number; ext: string };
type CodeFilesResponse = { files: CodeFile[]; appsRoot: string | null; totalFiles: number };

interface FGNode {
  id: string; label: string;
  type: "agent" | "task" | "artifact" | "doc";
  role?: string;              // role base (system/cto/…) para nós de agente
  color: string; size: number; detail?: string;
  fx?: number; fy?: number;   // constelação: agentes do roster são FIXADOS
  // runtime (mutado pela engine — NÃO entra na assinatura de rebuild)
  x?: number; y?: number; vx?: number; vy?: number;
}
interface FGLink {
  source: string | FGNode; target: string | FGNode;
  color: string;
  kind?: "spoke" | "flow" | "orch" | "satellite"; // backbone estrutural × satélite
  // runtime (mutado no evento ao vivo — repintado durante a partícula do pacote)
  __packetColor?: string; __hotUntil?: number;
}
interface GraphData { nodes: FGNode[]; links: FGLink[] }
type NodeWithPos = FGNode;

// ── Roster canônico — SEMPRE presente (desacoplado do diálogo/stream) ──────────
// O grafo é uma CONSTELAÇÃO fixa do time de agentes de AI do Genesis: o núcleo
// (Genesis/system) no centro e o pipeline em órbita. Tasks/docs/artefatos entram
// como satélites que gravitam ao redor do dono. Isso garante que os agentes nunca
// "somem" — o diálogo apenas ACENDE atividade (pulso + pacotes), nunca cria os nós.
const CORE_ROLE = "system";
const RING_ROLES = ["cto", "engineer", "pm", "dev", "qa", "devops", "monitor"] as const;
const ROSTER_ROLES: string[] = [CORE_ROLE, ...RING_ROLES];
const ROSTER_SET = new Set<string>(ROSTER_ROLES);

const RING_RADIUS = 190; // raio da órbita (unidades de grafo; zoomToFit escala p/ caber)
const CORE_SIZE = 11;    // núcleo Genesis — o maior/mais luminoso
const RING_SIZE = 7.5;   // agentes do pipeline
const HUB_SIZE  = 8.5;   // monitor — 2º hub (orquestra a execução)

// ── Modelos de layout — o usuário troca no switcher OU clicando no fundo. ──────
// Em TODOS os modos o roster de 8 agentes está sempre presente (nunca "somem");
// muda só a geometria. A camada de luz (streams sinápticos) é comum a todos.
// Reúne as DUAS gerações: os modelos que já existiam (cérebro, radial, pipeline,
// fluxo, livre) — agora melhorados — MAIS os novos (neurônio, constelação).
export type LayoutMode =
  | "neural" | "constellation" | "brain" | "radial" | "pipeline" | "flow" | "free";
const LAYOUT_CYCLE: LayoutMode[] =
  ["neural", "constellation", "brain", "radial", "pipeline", "flow", "free"];
const LAYOUT_META: Record<LayoutMode, { icon: string; label: string; tip: string }> = {
  neural:        { icon: "🧠", label: "Neurônio",    tip: "Cérebro orgânico — anel irregular + sinapses curvas vivas" },
  constellation: { icon: "🌌", label: "Constelação", tip: "Time em órbita estável e limpa ao redor do núcleo" },
  brain:         { icon: "🧬", label: "Cérebro",     tip: "Dois hemisférios — núcleo no centro, lobos à esquerda/direita" },
  radial:        { icon: "⭕", label: "Radial",       tip: "Núcleo no centro, camadas concêntricas por tipo (cebola)" },
  pipeline:      { icon: "➡️", label: "Pipeline",     tip: "Esquerda → direita pela fase, em colunas alinhadas" },
  flow:          { icon: "🌊", label: "Fluxo",        tip: "Colunas por fase, mas com dispersão orgânica + arestas curvas" },
  free:          { icon: "✦",  label: "Livre",        tip: "Física livre (Obsidian) — assenta e congela sozinho" },
};

// Cor base do tráfego sináptico AMBIENTE (repouso) — azul-elétrico frio, tipo HUD.
const AMBIENT_STREAM_COLOR = "#5FB8FF";

// Posição fixa (fx/fy) de cada agente na constelação: núcleo no centro; anel
// começando no topo (-90°) em sentido horário, na ordem do pipeline.
function rosterPosition(role: string): { fx: number; fy: number } {
  if (role === CORE_ROLE) return { fx: 0, fy: 0 };
  const i = RING_ROLES.indexOf(role as (typeof RING_ROLES)[number]);
  const idx = i < 0 ? 0 : i;
  const angle = -Math.PI / 2 + (idx / RING_ROLES.length) * 2 * Math.PI;
  return { fx: RING_RADIUS * Math.cos(angle), fy: RING_RADIUS * Math.sin(angle) };
}

// Topologia do mesh (backbone SEMPRE desenhado, faint em repouso). Reflete como o
// time realmente conversa: núcleo↔brain-trust, monitor↔execução, handoff PM→Dev.
const TEAM_EDGES: Array<[string, string, NonNullable<FGLink["kind"]>]> = [
  ["system", "cto", "spoke"], ["system", "engineer", "spoke"],
  ["system", "pm", "spoke"], ["system", "monitor", "spoke"],
  ["cto", "engineer", "flow"], ["cto", "pm", "flow"], ["engineer", "pm", "flow"],
  ["pm", "dev", "flow"],
  ["monitor", "dev", "orch"], ["monitor", "qa", "orch"], ["monitor", "devops", "orch"],
  ["dev", "qa", "flow"], ["qa", "devops", "flow"],
];

// Normaliza um nome de agente para a chave usada nos ids de nó (agent-<key>).
const normKey = (raw?: string) => (raw ?? "").toLowerCase().replace(/[^a-z_]/g, "_");

// Mapeia qualquer agente (inclusive especializados: dev_backend_python, qa_web…)
// para a role base do roster. Fora do roster (spec/error/vazio) → cai no núcleo.
function baseRole(raw?: string): string {
  const k = normKey(raw);
  if (ROSTER_SET.has(k)) return k;
  const stem = k.replace(/_.*$/, "");
  if (ROSTER_SET.has(stem)) return stem;
  return CORE_ROLE;
}

// Cor do "pacote" de mensagem por tipo de evento — é o que dá leitura instantânea
// ao observador: verde = entrega, vermelho = erro, índigo = trabalhando, azul = passo.
const EVENT_PACKET_COLOR: Record<string, string> = {
  error: "#F26D6D",
  product_ready: "#2FBF71",
  product: "#2FBF71",
  agent_working: "#7C93F0",
  step: "#4FA8E8",
};

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
  planningDocs: PlanningDoc[] = [], compactArtifacts = false, filter?: GraphFilter,
): GraphData {
  const f: GraphFilter = { ...DEFAULT_FILTER, ...(filter ?? {}) };
  const nodes: FGNode[] = []; const links: FGLink[] = [];
  const linkSet = new Set<string>();

  const linkKey = (s: string, t: string) => [s, t].sort().join("|"); // não-direcionado
  const addLink = (s: string, t: string, color: string, kind: NonNullable<FGLink["kind"]>) => {
    const k = linkKey(s, t);
    if (s === t || linkSet.has(k)) return;
    linkSet.add(k); links.push({ source: s, target: t, color, kind });
  };

  // 1) ROSTER canônico — SEMPRE presente, fixado na constelação.
  for (const role of ROSTER_ROLES) {
    const profile = getAgentProfile(role);
    const pos = rosterPosition(role);
    const size = role === CORE_ROLE ? CORE_SIZE : role === "monitor" ? HUB_SIZE : RING_SIZE;
    const human = profile.name.replace(/^IA-/, "");
    const rolePrefix = (profile.role ?? "").toUpperCase().replace(/\s+/g, "-");
    const label = rolePrefix ? `${rolePrefix}·${human}` : profile.name;
    nodes.push({
      id: `agent-${role}`, label, type: "agent", role,
      color: role === CORE_ROLE ? "#4C8DFF" : profile.color, // núcleo mais luminoso
      // Semente de posição (x/y); o PIN (fx/fy) é aplicado por computeLayout conforme o modo.
      size, detail: profile.avatar, x: pos.fx, y: pos.fy,
    });
  }

  // 2) BACKBONE estrutural (sempre desenhado, faint).
  for (const [a, b, kind] of TEAM_EDGES) addLink(`agent-${a}`, `agent-${b}`, "#5A6480", kind);

  // 3) Pares OBSERVADOS no diálogo (mapeados p/ role base) — enriquecem o mesh e
  //    garantem que o pacote ao vivo sempre tenha uma aresta para percorrer.
  for (const e of dialogue) {
    const a = baseRole(e.fromAgent); const b = baseRole(e.toAgent);
    if (a !== b) addLink(`agent-${a}`, `agent-${b}`, "#5A6480", "flow");
  }

  // Semente de posição perto do dono (satélites nascem próximos e assentam rápido).
  const seededNear = (role: string, i: number, spread: number) => {
    const base = rosterPosition(role);
    const a = (i * 2.399963) % (2 * Math.PI); // ângulo áureo determinístico
    const rad = 34 + (i % 4) * 10 + spread;
    return { x: base.fx + Math.cos(a) * rad, y: base.fy + Math.sin(a) * rad };
  };

  // 4) DOCS (satélites) — por fase, ligados ao agente da fase.
  const phaseVisible: Record<string, boolean> = {
    spec: f.docsSpec, cto: f.docsCto, engineer: f.docsEngineer,
    pm: f.docsPm, qa: f.docsQa, devops: f.docsDevops, other: false,
  };
  const skipDocs = [".json", "spec__", "raw_response"];
  const visibleDocs = planningDocs.filter(d => {
    if (skipDocs.some(p => d.filename.toLowerCase().includes(p))) return false;
    return phaseVisible[inferPhaseFG(d.filename, d.creator)] ?? false;
  });
  for (let i = 0; i < visibleDocs.length; i++) {
    const doc = visibleDocs[i];
    const phase = inferPhaseFG(doc.filename, doc.creator);
    const color = PHASE_COLOR_FG[phase] ?? "#484F58";
    const owner = baseRole(PHASE_AGENT_KEY[phase] ?? CORE_ROLE);
    const shortName = (doc.filename.split("/").pop() ?? doc.filename).replace(/\.md$/i, "");
    const label = (doc.title ?? shortName).slice(0, 30);
    const nodeId = `doc-${i}`;
    const seed = seededNear(owner, i, 8);
    nodes.push({ id: nodeId, label, type: "doc", color, size: 3.2, detail: phase, x: seed.x, y: seed.y });
    addLink(`agent-${owner}`, nodeId, color + "66", "satellite");
  }

  // 5) TASKS (satélites) — por dono, cor por status.
  const DONE_STATUSES   = new Set(["DONE", "QA_PASS"]);
  const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "WAITING_REVIEW"]);
  const ownerMap: Record<string, string> = {
    DEV: "dev", DEV_WEB: "dev", DEV_BACKEND: "dev", DEV_BACKEND_NODEJS: "dev",
    QA: "qa", QA_WEB: "qa", QA_BACKEND: "qa", QA_BACKEND_NODEJS: "qa",
    DEVOPS: "devops", DEVOPS_DOCKER: "devops", PM: "pm", PM_WEB: "pm",
    PM_BACKEND: "pm", PM_MOBILE: "pm", CTO: "cto", ENGINEER: "engineer", MONITOR: "monitor",
  };
  let ti = 0;
  for (const t of tasks) {
    const s = t.status ?? "NEW";
    if (!ACTIVE_STATUSES.has(s)) {
      if (DONE_STATUSES.has(s)  && !f.tasksDone)    continue;
      if (!DONE_STATUSES.has(s) && !f.tasksPending)  continue;
    }
    const color = TASK_COLOR[s] ?? "#4B5563";
    const owner = baseRole(ownerMap[(t.ownerRole ?? "").toUpperCase()] ?? "dev");
    const seed = seededNear(owner, ti++, 4);
    nodes.push({ id: `task-${t.taskId}`, label: t.taskId, type: "task", color, size: 4, detail: s, x: seed.x, y: seed.y });
    addLink(`agent-${owner}`, `task-${t.taskId}`, color + "66", "satellite");
  }

  // 6) ARTEFATOS (satélites de código) — ligados ao Dev.
  if (!f.artifacts) return { nodes, links };
  const allFiles = codeFiles.filter(f2 => !f2.path.includes("node_modules") && !f2.path.endsWith(".lock"));
  const devRole = "dev";

  if (compactArtifacts && allFiles.length > 0) {
    // Modo compacto: 5 artefatos recentes + 1 nó agregador com o restante.
    const MAX_SHOWN = 5;
    const shown = allFiles.slice(-MAX_SHOWN);
    const hidden = allFiles.length - shown.length;
    for (let i = 0; i < shown.length; i++) {
      const fi = shown[i];
      const color = EXT_COLOR[fi.ext] ?? "#8B949E";
      const seed = seededNear(devRole, i, 16);
      nodes.push({ id: `artifact-${i}`, label: fi.path.split("/").pop() ?? fi.path, type: "artifact", color, size: 2.4, detail: fi.path, x: seed.x, y: seed.y });
      addLink(`agent-${devRole}`, `artifact-${i}`, color + "44", "satellite");
    }
    if (hidden > 0) {
      const label = hidden >= 500 ? "500+" : hidden >= 100 ? `${Math.floor(hidden / 100) * 100}+` : hidden >= 10 ? `${Math.floor(hidden / 10) * 10}+` : `${hidden}+`;
      const seed = seededNear(devRole, 6, 26);
      nodes.push({ id: "artifact-group", label: `${label} arquivos`, type: "artifact", color: "#484F58", size: 5, detail: `${allFiles.length} arquivos no projeto`, x: seed.x, y: seed.y });
      addLink(`agent-${devRole}`, "artifact-group", "#484F5866", "satellite");
    }
  } else {
    // Modo completo: até 20 artefatos individuais.
    const showable = allFiles.slice(0, 20);
    for (let i = 0; i < showable.length; i++) {
      const fi = showable[i];
      const color = EXT_COLOR[fi.ext] ?? "#8B949E";
      const seed = seededNear(devRole, i, 16);
      nodes.push({ id: `artifact-${i}`, label: fi.path.split("/").pop() ?? fi.path, type: "artifact", color, size: 2.4, detail: fi.path, x: seed.x, y: seed.y });
      addLink(`agent-${devRole}`, `artifact-${i}`, color + "44", "satellite");
    }
  }

  return { nodes, links };
}

// ── Geometria por modelo ────────────────────────────────────────────────────
// Retorna o mapa de PINS por id de nó para o modo dado. Cada pin pode fixar fx,
// fy ou ambos: modos "físicos" (free) retornam vazio (a engine assenta e congela
// sozinha); "flow" fixa só fx (colunas por fase) e deixa fy livre → dispersão
// orgânica vertical; os demais fixam ambos. Chave: os agentes SEMPRE existem,
// então todo modo mostra o time — a diferença é só a disposição.
type Pin = { fx?: number; fy?: number };
// Colunas por fase (esq→dir) — compartilhado por pipeline (rígido) e flow (orgânico).
const PHASE_COL: Record<string, number> = {
  system: -3, cto: -2, engineer: -1.35, pm: -0.45, monitor: 0.45, dev: 1.25, qa: 2.2, devops: 3,
};
function computeLayout(mode: LayoutMode, nodes: FGNode[]): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  const agents = nodes.filter(n => n.type === "agent");
  const byRole = (role: string) => agents.find(a => a.role === role);

  if (mode === "free") return pins; // física livre — sem pins

  if (mode === "constellation") {
    for (const a of agents) { const p = rosterPosition(a.role ?? CORE_ROLE); pins.set(a.id, { fx: p.fx, fy: p.fy }); }
    return pins;
  }

  if (mode === "neural") {
    // Cérebro orgânico: núcleo no centro; anel com raio/ângulo IRREGULARES (jitter
    // determinístico) e eixo Y comprimido → silhueta de rede neural, não círculo perfeito.
    const core = byRole(CORE_ROLE); if (core) pins.set(core.id, { fx: 0, fy: 0 });
    RING_ROLES.forEach((role, i) => {
      const a = byRole(role); if (!a) return;
      const base = -Math.PI / 2 + (i / RING_ROLES.length) * 2 * Math.PI;
      const jitterA = (((i * 2.3999632) % 1) - 0.5) * 0.5;   // ±0.25 rad determinístico
      const rad = RING_RADIUS * (0.80 + ((i * 7) % 5) / 11);  // raio irregular 0.80..1.16
      pins.set(a.id, { fx: Math.cos(base + jitterA) * rad, fy: Math.sin(base + jitterA) * rad * 0.84 });
    });
    return pins;
  }

  if (mode === "brain") {
    // Dois hemisférios: núcleo ao centro; metade dos agentes num lobo à esquerda,
    // metade num lobo à direita, cada um numa coluna que se curva para fora (bow) →
    // silhueta clássica de cérebro. Satélites flutuam (física) ao redor do dono.
    const core = byRole(CORE_ROLE); if (core) pins.set(core.id, { fx: 0, fy: 0 });
    const ring = RING_ROLES.filter(r => byRole(r));
    const half = Math.ceil(ring.length / 2);
    ring.forEach((role, i) => {
      const a = byRole(role); if (!a) return;
      const left = i < half;
      const idxIn = left ? i : i - half;
      const cntIn = Math.max(left ? half : ring.length - half, 1);
      const t = cntIn <= 1 ? 0 : (idxIn / (cntIn - 1)) * 2 - 1; // -1..1 ao longo do lobo
      const bow = Math.cos((t * Math.PI) / 2);                   // 1 no centro, 0 nas pontas
      const fx = (left ? -1 : 1) * (RING_RADIUS * 0.42 + bow * RING_RADIUS * 0.34);
      pins.set(a.id, { fx, fy: t * RING_RADIUS * 0.92 });
    });
    return pins;
  }

  if (mode === "radial") {
    const core = byRole(CORE_ROLE) ?? agents[0]; if (core) pins.set(core.id, { fx: 0, fy: 0 });
    const others = agents.filter(a => a !== core);
    others.forEach((a, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(others.length, 1)) * 2 * Math.PI;
      pins.set(a.id, { fx: Math.cos(ang) * (RING_RADIUS * 0.60), fy: Math.sin(ang) * (RING_RADIUS * 0.60) });
    });
    // Satélites em camadas concêntricas por tipo (leitura "cebola").
    const ring = (arr: FGNode[], r: number, off: number) => arr.forEach((n, i) => {
      const ang = off + (i / Math.max(arr.length, 1)) * 2 * Math.PI;
      pins.set(n.id, { fx: Math.cos(ang) * r, fy: Math.sin(ang) * r });
    });
    ring(nodes.filter(n => n.type === "task"),     RING_RADIUS * 1.12, 0.30);
    ring(nodes.filter(n => n.type === "doc"),      RING_RADIUS * 1.48, 0.70);
    ring(nodes.filter(n => n.type === "artifact"), RING_RADIUS * 1.82, 0.15);
    return pins;
  }

  if (mode === "flow") {
    // Colunas por fase, mas fixando SÓ fx → os agentes alinham em colunas esq→dir
    // enquanto o eixo Y fica livre (física distribui verticalmente) → fluxo orgânico.
    const COLW = 90;
    agents.forEach(a => { const c = PHASE_COL[a.role ?? "system"] ?? 0; pins.set(a.id, { fx: c * COLW }); });
    return pins;
  }

  // pipeline — agentes em colunas por fase (esq→dir), fy=0 → linha rígida alinhada.
  const COLW = 96;
  agents.forEach(a => { const c = PHASE_COL[a.role ?? "system"] ?? 0; pins.set(a.id, { fx: c * COLW, fy: 0 }); });
  return pins;
}

// Aplica (ou remove) os pins no array de nós dado, mutando fx/fy in-place. Usado
// no rebuild (nós já são cópias frescas). Um pin pode fixar só fx (flow) → o eixo
// não-fixado é liberado (delete) para a física agir.
function applyLayout(mode: LayoutMode, nodes: FGNode[]): void {
  const pins = computeLayout(mode, nodes);
  for (const n of nodes) {
    const p = pins.get(n.id);
    if (p && p.fx !== undefined) n.fx = p.fx; else delete n.fx;
    if (p && p.fy !== undefined) n.fy = p.fy; else delete n.fy;
  }
}

// Fase determinística [0,1) por aresta (des-sincroniza os streams).
function linkPhase(l: FGLink): number {
  const idOf = (x: string | FGNode) => (typeof x === "object" ? x.id : x);
  const s = idOf(l.source) + "→" + idOf(l.target);
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h / 997;
}

// ── Task status colors (shared) ───────────────────────────────────────────────
const STATUS_CHIP_COLOR: Record<string, string> = {
  DONE: "#10B981", QA_PASS: "#10B981", IN_PROGRESS: "#6366F1",
  WAITING_REVIEW: "#6366F1", QA_FAIL: "#EF4444", BLOCKED: "#EF4444",
  NEW: "#8B949E", ASSIGNED: "#F59E0B",
};
const STATUS_LABEL_FG: Record<string, string> = {
  DONE: "✓ Feito", QA_PASS: "✓ QA OK", IN_PROGRESS: "⟳ Em desenvolvimento",
  WAITING_REVIEW: "⟳ Aguardando Review", QA_FAIL: "✗ QA Falhou",
  BLOCKED: "⊘ Bloqueada", NEW: "◦ Nova", ASSIGNED: "→ Atribuída",
};

// ── Task Detail Drawer ────────────────────────────────────────────────────────
function TaskDetailDrawer({ task, onClose }: { task: TaskItem | null; onClose: () => void }) {
  if (!task) return null;
  const color  = STATUS_CHIP_COLOR[task.status ?? ""] ?? "#8B949E";
  const label  = STATUS_LABEL_FG[task.status ?? ""] ?? task.status ?? "—";

  // Divide requirements em tópicos: linhas que começam com -, *, número., ou são linhas com conteúdo
  const lines = (task.requirements ?? "").split(/\n/).map(l => l.trim()).filter(Boolean);
  const isBullet = (l: string) => /^[-*•]/.test(l) || /^\d+[.)]\s/.test(l);
  const bullets = lines.filter(isBullet).map(l => l.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, ""));
  const prose   = lines.filter(l => !isBullet(l));

  const fmtDate = (iso?: string) => iso ? new Date(iso).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" }) : null;

  return (
    <Drawer
      anchor="right"
      open={!!task}
      onClose={onClose}
      PaperProps={{ sx: { width: 360, bgcolor: "#0D0F14", borderLeft: "1px solid #30363D", p: 0 } }}
    >
      {/* Header */}
      <Stack direction="row" alignItems="center" justifyContent="space-between"
        sx={{ px: 2, py: 1.5, borderBottom: "1px solid #30363D", flexShrink: 0 }}>
        <Stack spacing={0.25}>
          <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ fontSize: "0.65rem" }}>
            {task.module ? `${task.module} · ` : ""}{task.ownerRole ?? ""}
          </Typography>
          <Typography variant="body2" fontWeight={700} color="text.primary" sx={{ fontSize: "0.85rem" }}>
            {task.taskId}
          </Typography>
        </Stack>
        <IconButton size="small" onClick={onClose} sx={{ color: "text.secondary" }}>
          <CloseIcon sx={{ fontSize: "1rem" }} />
        </IconButton>
      </Stack>

      <Box sx={{ px: 2, py: 1.5, overflowY: "auto", flexGrow: 1 }}>
        {/* Status */}
        <Box sx={{ display: "inline-block", mb: 2, px: 1.5, py: 0.4, borderRadius: 10,
          bgcolor: `${color}18`, border: `1px solid ${color}40`, color, fontSize: "0.7rem", fontWeight: 600 }}>
          {label}
        </Box>

        {/* Requisitos — tópicos */}
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
                  <Typography variant="caption" color="text.primary" sx={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                    {b}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </>
        )}

        {/* Texto livre (não bullet) */}
        {prose.length > 0 && (
          <>
            {bullets.length > 0 && <Divider sx={{ borderColor: "#30363D", mb: 1.5 }} />}
            <Typography variant="caption" color="text.disabled"
              sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.6rem", display: "block", mb: 0.75 }}>
              {bullets.length === 0 ? "Descrição" : "Detalhes"}
            </Typography>
            {prose.map((p, i) => (
              <Typography key={i} variant="caption" color="text.secondary"
                sx={{ display: "block", fontSize: "0.72rem", lineHeight: 1.6, mb: 0.5 }}>
                {p}
              </Typography>
            ))}
          </>
        )}

        {/* Sem conteúdo */}
        {bullets.length === 0 && prose.length === 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.7rem" }}>
            Sem requisitos registrados.
          </Typography>
        )}

        {/* Meta */}
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

// ── Component ─────────────────────────────────────────────────────────────────
interface ForceGraphProps {
  projectId: string;
  pollIntervalMs?: number;
  height?: number | string;
  planningDocs?: PlanningDoc[];
  filter?: GraphFilter;
}

export function ForceGraph({ projectId, pollIntervalMs = 8000, height = 500, planningDocs = [], filter }: ForceGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading]     = useState(true);
  // Start at 0 — ResizeObserver will set the real size; canvas won't render until measured
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [tooltip, setTooltip]     = useState<{ label: string; detail?: string } | null>(null);
  const [activeAgent, setActiveAgent] = useState<string | null>(null); // role base ativa (pulso)
  const [layoutMode, setLayoutMode]   = useState<LayoutMode>("neural"); // modelo atual
  const layoutModeRef = useRef<LayoutMode>("neural");                   // p/ ler em rebuild sem closure velha
  useEffect(() => { layoutModeRef.current = layoutMode; }, [layoutMode]);
  // "▶ animar": revela os nós um a um (null = mostra todos). O intervalo é guardado
  // p/ limpar no unmount e não vazar timer se o componente sair no meio da animação.
  const [revealCount, setRevealCount] = useState<number | null>(null);
  const revealIvRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const revealEndRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (revealIvRef.current)  clearInterval(revealIvRef.current);
    if (revealEndRef.current) clearTimeout(revealEndRef.current);
  }, []);
  const lastScaleRef  = useRef<number>(1); // globalScale capturado no paint (p/ dimensionar cometas)
  // Task drawer — abre ao clicar num nó de task
  const [taskDrawer, setTaskDrawer] = useState<TaskItem | null>(null);
  const taskMapRef = useRef<Map<string, TaskItem>>(new Map());

  const filterRef = useRef(filter);
  useEffect(() => { filterRef.current = filter; }, [filter]);

  // planningDocs via ref → rebuild/refresh ficam com identidade ESTÁVEL. Sem isto, um
  // caller que passe `docs ?? []` (nova referência a cada render) recriava rebuild→refresh,
  // e o efeito de poll re-disparava a cada render do pai (tempestade de 3 fetches) e ainda
  // rodava refresh() mesmo com pollIntervalMs=0 (projeto ocioso). Ref mantém o efeito 1×/mount.
  const planningDocsRef = useRef(planningDocs);
  useEffect(() => { planningDocsRef.current = planningDocs; }, [planningDocs]);

  // Pulso animado (0..1) para o halo do agente ativo. activeKeyRef é lido pelo painter
  // SEM disparar rebuild — mudar o agente ativo não re-simula a física.
  const activeKeyRef  = useRef<string | null>(null);
  const lastWorkAtRef = useRef<number>(0);
  useEffect(() => { activeKeyRef.current = activeAgent; }, [activeAgent]);

  const containerRef   = useRef<HTMLDivElement>(null);
  const prevSignature  = useRef<string>("");
  const needsFitRef    = useRef<boolean>(true);
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

  // Fontes cacheadas. O diálogo tem DUAS origens unidas no rebuild:
  //  • histórico via refresh() (funciona mesmo com projeto ocioso/stream desligado)
  //  • ao vivo via useDialogueStream (deltas enquanto o projeto roda).
  const dialogueHistRef = useRef<DialogueEntry[]>([]);
  const dialogueLiveRef = useRef<DialogueEntry[]>([]);
  const tasksRef        = useRef<TaskItem[]>([]);
  const filesRef        = useRef<CodeFile[]>([]);

  // ── Rebuild (SEM rede): monta a constelação a partir das fontes cacheadas ───
  const rebuild = useCallback(() => {
    // União dedup por id (histórico + ao vivo); ordena por created p/ "último working".
    const byId = new Map<string, DialogueEntry>();
    for (const e of dialogueHistRef.current) byId.set(e.id, e);
    for (const e of dialogueLiveRef.current) byId.set(e.id, e);
    const dialogue = Array.from(byId.values()).sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const tasks = tasksRef.current;
    const files = filesRef.current;

    // Agente ativo = último "agent_working" (só alimenta o pulso, não a estrutura).
    const lastWorking = [...dialogue].reverse().find(e => e.eventType === "agent_working");
    if (lastWorking) {
      const key = baseRole(lastWorking.fromAgent);
      setActiveAgent(prev => (prev === key ? prev : key));
      lastWorkAtRef.current = performance.now();
    }

    // Mapa fresco a cada rebuild (não acumula tasks obsoletas entre sessões longas).
    taskMapRef.current = new Map(tasks.map(t => [`task-${t.taskId}`, t]));
    const data = buildForceData(dialogue, tasks, files, planningDocsRef.current, false, filterRef.current);

    // Assinatura: ids + detail (cobre status/cor de task) + nº de links. NÃO inclui
    // "ativo" (isso é só pulso via ref) → evita re-simular a cada fala.
    const sig = [
      data.nodes.map(n => `${n.id}:${n.detail ?? ""}:${n.color}`).sort().join("|"),
      data.links.length,
    ].join("§");
    if (sig === prevSignature.current) return;
    prevSignature.current = sig;

    setGraphData(prev => {
      const prevNodeMap = new Map(prev.nodes.map(n => [n.id, n]));
      const merged = data.nodes.map(n => {
        const ex = prevNodeMap.get(n.id) as NodeWithPos | undefined;
        if (ex) {
          // Preserva posição física (x,y,vx,vy); atualiza só o visual/rotulagem.
          return { ...ex, color: n.color, detail: n.detail, size: n.size, label: n.label, role: n.role };
        }
        return n;
      });
      const countChanged = merged.length !== prev.nodes.length;
      // Reaplica os pins do modo atual aos nós frescos (idempotente, sem re-simular).
      applyLayout(layoutModeRef.current, merged);
      if (countChanged) {
        needsFitRef.current = true;
        // Nós entraram/saíram → reaquece a simulação uma vez para assentar.
        try { fgRef.current?.d3ReheatSimulation?.(); } catch { /* engine pode não estar montada */ }
      }
      // Merge de links por chave não-direcionada: REUSA o objeto de link anterior quando a
      // aresta persiste, para carregar as flags "quentes" em voo (__hotUntil/__packetColor)
      // através de um rebuild por mudança de status de task. CRÍTICO: force-graph resolve
      // source/target string→objeto in-place (mjs:857) e o d3-force só re-resolve se NÃO for
      // objeto — então reafirmamos os ids-STRING frescos no objeto reusado, senão a aresta
      // ficaria presa a um nó órfão (o merge de nós cria novas referências). Assim a física
      // re-resolve corretamente contra os nós novos e nada fica detached.
      const idOf = (x: string | FGNode) => (typeof x === "object" ? x.id : x);
      const prevLinkMap = new Map(prev.links.map(l => [[idOf(l.source), idOf(l.target)].sort().join("|"), l]));
      const mergedLinks = data.links.map(l => {
        const ex = prevLinkMap.get([idOf(l.source), idOf(l.target)].sort().join("|"));
        if (ex) { ex.source = l.source; ex.target = l.target; ex.color = l.color; ex.kind = l.kind; return ex; }
        return l;
      });
      return { nodes: merged, links: mergedLinks };
    });
  }, []);

  // ── Poll de tasks/arquivos + histórico de diálogo (robusto p/ projeto ocioso) ─
  const refresh = useCallback(async () => {
    try {
      const [tasks, codeFilesData, dlg] = await Promise.all([
        apiGet<TaskItem[]>(`/api/projects/${projectId}/tasks`).catch(() => [] as TaskItem[]),
        apiGet<CodeFilesResponse>(`/api/projects/${projectId}/code-files`).catch(() => ({ files: [], appsRoot: null, totalFiles: 0 })),
        apiGet<DialogueEntry[]>(`/api/projects/${projectId}/dialogue`).catch(() => [] as DialogueEntry[]),
      ]);
      tasksRef.current = Array.isArray(tasks) ? tasks : [];
      filesRef.current = (codeFilesData as CodeFilesResponse).files ?? [];
      dialogueHistRef.current = Array.isArray(dlg) ? dlg : [];
      rebuild();
    } catch { /* silent */ } finally { setLoading(false); }
  }, [projectId, rebuild]);

  // ── Stream ao vivo do diálogo: dispara o "pacote" na aresta real ───────────
  const handleLiveEvent = useCallback((entry: DialogueEntry) => {
    const fk = baseRole(entry.fromAgent);
    const tk = baseRole(entry.toAgent);
    // Reage NA HORA: acende o halo no agente que começou a trabalhar.
    if (entry.eventType === "agent_working") {
      setActiveAgent(fk);
      lastWorkAtRef.current = performance.now();
    }
    if (!fk || !tk || fk === tk) return;
    // graphData() do react-force-graph devolve os objetos de link REAIS que a engine anima.
    const g = fgRef.current?.graphData?.() as GraphData | undefined;
    if (!g) return;
    const fromId = `agent-${fk}`; const toId = `agent-${tk}`;
    const idOf = (x: string | FGNode) => (typeof x === "object" ? x.id : x);
    const link = g.links.find(l => {
      const s = idOf(l.source); const t = idOf(l.target);
      return (s === fromId && t === toId) || (s === toId && t === fromId);
    }) as FGLink | undefined;
    if (!link) return; // aresta ainda não existe — o próximo rebuild a cria (par observado)
    const color = EVENT_PACKET_COLOR[entry.eventType ?? ""] ?? "#9AA4C0";
    link.__packetColor = color;
    // A janela "quente" precisa esfriar ENQUANTO a partícula ainda voa (é o que mantém
    // o canvas repintando quando não há agente ativo). Partícula a speed 0.012 cruza em
    // ~83 frames (~0.7s a 120Hz, ~1.4s a 60Hz); 650ms fica sob a menor janela → o
    // esfriamento é sempre pintado, sem aresta "presa acesa" após a engine congelar.
    link.__hotUntil = performance.now() + 650;
    try {
      fgRef.current?.emitParticle?.(link);
      fgRef.current?.emitParticle?.(link);
    } catch { /* engine ainda não montada */ }
  }, []);

  const { entries: liveEntries, connected: liveConnected } = useDialogueStream({
    projectId,
    enabled: pollIntervalMs > 0,
    onEvent: handleLiveEvent,
  });

  // Diálogo ao vivo mudou → atualiza a fonte viva e rebuild (early-return se nada mudou).
  useEffect(() => {
    dialogueLiveRef.current = liveEntries;
    rebuild();
  }, [liveEntries, rebuild]);

  // Poll de tasks/arquivos/histórico.
  useEffect(() => {
    refresh();
    if (pollIntervalMs > 0) { const t = setInterval(refresh, pollIntervalMs); return () => clearInterval(t); }
  }, [refresh, pollIntervalMs]);

  // filter mudou → invalida cache e força rebuild imediato.
  useEffect(() => {
    prevSignature.current = "";
    rebuild();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // ── Expiração do agente ativo (auto-desliga após 6s sem novo "working"). ─────
  // O pulso/breathing é derivado de performance.now() DENTRO de paintNode; o canvas
  // repinta sozinho porque há sempre fótons ambientes nas arestas (item confirmado
  // na engine: um link com __photons força doRedraw mesmo com a física congelada).
  useEffect(() => {
    if (!activeAgent) return;
    const t = setInterval(() => {
      if (performance.now() - lastWorkAtRef.current > 6000) setActiveAgent(null);
    }, 1000);
    return () => clearInterval(t);
  }, [activeAgent]);

  // ── Troca de modelo — repinta DE VERDADE. ───────────────────────────────────
  // Lição custosa: mutar fx/fy nos nós que a engine já segura + d3ReheatSimulation()
  // NÃO reposicionava de forma confiável (a identidade de graphData.nodes não muda,
  // o wrapper react-force-graph não re-ingere). O mecanismo que SEMPRE funcionou é
  // trocar a PROP graphData por um NOVO array de nós (com os fx/fy do modo, ou sem
  // eles) — o que força o wrapper a re-ingerir e reposicionar — E resetar os links
  // para ids-STRING, pois o force-graph só re-resolve source/target string→objeto se
  // NÃO forem objeto; reusar objetos resolvidos apontaria para os nós velhos (órfãos).
  useEffect(() => {
    setGraphData(prev => {
      if (!prev.nodes.length) return prev;
      const pins = computeLayout(layoutMode, prev.nodes);
      const nodes = prev.nodes.map(n => {
        const copy: FGNode = { ...n }; // novo objeto → nova identidade do array
        const p = pins.get(n.id);
        if (p && p.fx !== undefined) copy.fx = p.fx; else delete copy.fx;
        if (p && p.fy !== undefined) copy.fy = p.fy; else delete copy.fy;
        return copy;
      });
      const idOf = (x: string | FGNode) => (typeof x === "object" ? x.id : x);
      const links = prev.links.map(l => ({ ...l, source: idOf(l.source), target: idOf(l.target) }));
      return { nodes, links };
    });
    // Não é preciso reaquecer à mão: ao re-ingerir o novo graphData, o force-graph já
    // faz forceLayout.stop().alpha(1) + 40 warmup ticks (mjs:862,910) → os fx/fy do modo
    // são aplicados e o layout assenta. Só marcamos o reenquadramento pós-assentamento.
    needsFitRef.current = true;
  }, [layoutMode]);

  // ── Configuração de forças — física que ASSENTA e congela (SEM reheat loop) ──
  useEffect(() => {
    if (graphData.nodes.length === 0) return;
    let tries = 0;
    const configure = () => {
      const g = fgRef.current;
      if (!g) { if (tries++ < 6) setTimeout(configure, 60); return; } // fgRef pode não estar pronto
      try {
        g.d3Force("charge")?.strength(-160).distanceMax(340);
        const linkF = g.d3Force("link");
        if (linkF) {
          linkF.distance((l: FGLink) => (l.kind === "satellite" ? 44 : 132))
               .strength((l: FGLink) => (l.kind === "satellite" ? 0.55 : 0.03));
        }
        // Sem força de centro: agentes já são fixados; satélites ancoram nos links.
        g.d3Force("center", null);
        g.d3Force("collide", forceCollide((n: FGNode) => (n.size ?? 4) + 3.5).strength(0.9));
        g.d3ReheatSimulation?.();
      } catch { /* força pode não existir ainda — o retry acima cobre */ }
    };
    configure();
  }, [graphData.nodes.length]);

  // ── Clique no fundo → próximo modelo de layout (o gesto que o Jean gostava). ─
  // A troca dispara o efeito de layoutMode: repõe graphData (repinta) + reaquece.
  const handleBackgroundClick = useCallback(() => {
    setLayoutMode(prev => LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(prev) + 1) % LAYOUT_CYCLE.length]);
  }, []);

  // ── "▶ animar" — revela o mesh nó a nó (agentes → tasks → docs → artefatos). ─
  const handleAnimate = useCallback(() => {
    const total = graphData.nodes.length;
    if (!total) return;
    if (revealIvRef.current)  clearInterval(revealIvRef.current);
    if (revealEndRef.current) clearTimeout(revealEndRef.current);
    const delay = Math.max(15, Math.min(80, Math.round(2000 / total)));
    setRevealCount(0);
    let count = 0;
    revealIvRef.current = setInterval(() => {
      count++;
      setRevealCount(count);
      if (count >= total) {
        if (revealIvRef.current) clearInterval(revealIvRef.current);
        revealIvRef.current = null;
        revealEndRef.current = setTimeout(() => setRevealCount(null), 400); // volta a "mostrar todos"
      }
    }, delay);
    try { fgRef.current?.d3ReheatSimulation?.(); } catch { /* engine montando */ }
  }, [graphData.nodes.length]);

  // Ordem de revelação estável (agente → task → doc → artefato).
  const revealOrder: Record<FGNode["type"], number> = useMemo(
    () => ({ agent: 0, task: 1, doc: 2, artifact: 3 }), []);
  const sortedNodes = useMemo(
    () => [...graphData.nodes].sort((a, b) => revealOrder[a.type] - revealOrder[b.type]),
    [graphData.nodes, revealOrder]);
  // Nós visíveis: todos (revealCount=null) ou o prefixo revelado. Mesma referência
  // quando não está animando → zero churn no caminho normal.
  const visibleNodes = useMemo(
    () => (revealCount === null ? graphData.nodes : sortedNodes.slice(0, revealCount)),
    [graphData.nodes, sortedNodes, revealCount]);
  // Links visíveis: no caminho normal, os objetos REAIS (fótons/rajadas preservados).
  // Durante a revelação, só arestas com AMBAS as pontas visíveis, resetadas p/ ids-string.
  const displayLinks = useMemo(() => {
    if (revealCount === null) return graphData.links;
    const idOf = (x: string | FGNode) => (typeof x === "object" ? x.id : x);
    const vis = new Set(visibleNodes.map(n => n.id));
    return graphData.links
      .filter(l => vis.has(idOf(l.source)) && vis.has(idOf(l.target)))
      .map(l => ({ ...l, source: idOf(l.source), target: idOf(l.target) }));
  }, [graphData.links, visibleNodes, revealCount]);

  // Wrapper do graphData MEMOIZADO: identidade estável enquanto nós/links não mudam.
  // Sem isto, o literal `{nodes,links}` era recriado a cada render (hover/tooltip/pulso)
  // → react-kapsule re-ingeria e reaquecia a física (alpha=1 + 40 warmup ticks) sem
  // necessidade, sabotando o "assenta e congela". Numa TROCA de modelo real, visibleNodes/
  // displayLinks viram arrays novos → o memo recalcula → re-ingest acontece (troca segue OK).
  const fgData = useMemo(
    () => ({ nodes: visibleNodes as object[], links: displayLinks as object[] }),
    [visibleNodes, displayLinks],
  );

  // ── Aparência das arestas por tipo (backbone × satélite) + estado "quente" ────
  // Backbone (spoke/flow/orch) sempre visível dá estrutura ao mesh em repouso.
  // Uma aresta fica "quente" (__hotUntil) enquanto o pacote a atravessa.
  const linkColorFn = useCallback((link: object) => {
    const l = link as FGLink;
    if ((l.__hotUntil ?? 0) > performance.now()) return (l.__packetColor ?? l.color) + "F0";
    if (l.kind === "satellite") return "#2B3242";      // satélites: traço tênue
    if (l.kind === "orch")      return "#4B5570";
    return l.color;                                     // spoke/flow: backbone
  }, []);
  const linkWidthFn = useCallback((link: object) => {
    const l = link as FGLink;
    if ((l.__hotUntil ?? 0) > performance.now()) return 2.4;
    if (l.kind === "satellite") return 0.5;
    if (l.kind === "spoke")     return 1.4;
    return 1;
  }, []);
  const linkCurveFn = useCallback((link: object) => {
    const l = link as FGLink;
    const m = layoutModeRef.current;
    if (m === "neural" || m === "brain") {
      // Sinapses curvas — dá o ar de dendritos; satélites retos p/ não poluir.
      if (l.kind === "satellite") return 0;
      return 0.14 + linkPhase(l) * 0.22; // curva variando por aresta (0.14..0.36)
    }
    if (m === "flow") {
      // Fluxo orgânico: todas as arestas do backbone curvam (dá o ar de correnteza).
      if (l.kind === "satellite") return 0;
      return 0.22 + linkPhase(l) * 0.14;
    }
    if (l.kind === "flow" || l.kind === "orch") return 0.18; // curva orgânica no pipeline
    return 0; // spoke/satellite retos = leitura estrutural limpa
  }, []);

  // ── STREAMS: nº de fótons por aresta (tráfego sináptico ambiente). ───────────
  // Backbone (spoke/flow/orch) recebe 1 fóton contínuo (loop eterno) → o "cérebro
  // em repouso" nunca fica morto. Satélites não streamam (leitura limpa). Bursts de
  // evento entram por emitParticle (aditivos, one-shot) por cima destes.
  const particleCountFn = useCallback((link: object) => {
    const l = link as FGLink;
    return l.kind === "satellite" ? 0 : 1;
  }, []);
  const particleSpeedFn = useCallback((link: object) => {
    const l = link as FGLink;
    return (l.__hotUntil ?? 0) > performance.now() ? 0.016 : 0.0045; // quente=rápido, ambiente=lento
  }, []);
  const particleOffsetFn = useCallback((link: object) => linkPhase(link as FGLink), []);

  // ── Cometa por partícula — o efeito JARVIS. Recebe (x,y) exatos do fóton. ────
  // Desenha, com blend ADITIVO: rastro (gradiente ao longo da aresta) + cabeça
  // (glow radial) + núcleo branco. Cor por estado da aresta: quente=cor do evento,
  // repouso=azul-elétrico ambiente. Renderiza SOB os nós (ordem da engine) — as
  // luzes correm por trás dos neurônios, que brilham por cima.
  const particleCanvasObject = useCallback(
    (x: number, y: number, link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (!isFinite(x) || !isFinite(y)) return;
      const l = link as FGLink;
      const src = l.source as FGNode; const tgt = l.target as FGNode;
      const now = performance.now();
      const hot = (l.__hotUntil ?? 0) > now;
      const color = hot ? (l.__packetColor ?? AMBIENT_STREAM_COLOR) : AMBIENT_STREAM_COLOR;
      const scale = globalScale || lastScaleRef.current || 1;
      const headR = (hot ? 2.8 : 1.6) / Math.sqrt(scale);

      // Direção do movimento (source→target) p/ orientar o rastro atrás da cabeça.
      let dx = (tgt?.x ?? x) - (src?.x ?? x);
      let dy = (tgt?.y ?? y) - (src?.y ?? y);
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const tailLen = (hot ? 15 : 8) / Math.sqrt(scale);
      const tx = x - dx * tailLen; const ty = y - dy * tailLen;

      ctx.save();
      ctx.globalCompositeOperation = "lighter"; // acúmulo luminoso = look de energia
      // rastro
      const tg = ctx.createLinearGradient(x, y, tx, ty);
      tg.addColorStop(0, color + "CC"); tg.addColorStop(1, color + "00");
      ctx.strokeStyle = tg; ctx.lineWidth = headR * 1.25; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
      // cabeça (glow)
      const hg = ctx.createRadialGradient(x, y, 0, x, y, headR * 2.6);
      hg.addColorStop(0, color + "FF"); hg.addColorStop(0.4, color + "AA"); hg.addColorStop(1, color + "00");
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(x, y, headR * 2.6, 0, 2 * Math.PI); ctx.fill();
      // núcleo branco
      ctx.fillStyle = "#FFFFFF"; ctx.beginPath(); ctx.arc(x, y, headR * 0.55, 0, 2 * Math.PI); ctx.fill();
      ctx.restore();
    }, []);

  // ── Fundo: gradiente radial profundo + starfield sutil (sob os nós) ────────
  const paintBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = ctx.canvas.width; const H = ctx.canvas.height; // device px
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // espaço de tela
    const bg = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.75);
    bg.addColorStop(0, "#141B2B");
    bg.addColorStop(1, "#0A0C11");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // starfield determinístico (sem Math.random) — pontos discretos, muito sutis
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    const step = 54;
    for (let gx = (W % step) / 2; gx < W; gx += step)
      for (let gy = (H % step) / 2; gy < H; gy += step) {
        const jx = ((gx * 13.13 + gy * 7.7) % 13) - 6.5;
        const jy = ((gx * 5.31 + gy * 9.19) % 13) - 6.5;
        ctx.beginPath(); ctx.arc(gx + jx, gy + jy, 0.7, 0, 2 * Math.PI); ctx.fill();
      }
    ctx.restore();
  }, []);

  // ── Vinheta (sobre os nós) — foca o olhar no centro ────────────────────────
  const paintVignette = useCallback((ctx: CanvasRenderingContext2D) => {
    const W = ctx.canvas.width; const H = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, "rgba(10,12,17,0)");
    vg.addColorStop(1, "rgba(6,8,12,0.55)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }, []);

  // ── Node painter — premium: glow por gradiente + rim light + label com halo ─
  const paintNode = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as FGNode;
    if (!isFinite(n.x ?? NaN) || !isFinite(n.y ?? NaN)) return;
    lastScaleRef.current = globalScale; // reaproveitado pelo pintor de cometa
    const x = n.x as number; const y = n.y as number;
    const isAgent = n.type === "agent";
    const isActive = isAgent && activeKeyRef.current === n.role;
    const now = performance.now();
    // Pulso FORTE do agente ativo (evento recente) + RESPIRAÇÃO sutil de todos os
    // neurônios (o cérebro nunca está inerte). Fase por role → não pulsam em uníssono.
    const roleSeed = (n.role ? n.role.charCodeAt(0) : 0) * 0.7;
    const pulse  = isActive ? (Math.sin(now / 300) + 1) / 2 : 0;             // 0..1 rápido
    const breath = isAgent  ? (Math.sin(now / 1100 + roleSeed) + 1) / 2 : 0; // 0..1 lento
    const r = (n.size ?? 4) * (isActive ? 1.15 + pulse * 0.12 : 1);

    // 1) GLOW — halo suave por gradiente radial (barato; shadowBlur fica só p/ ativo).
    const glowR = r * (isActive ? 3.6 + pulse * 1.2 : isAgent ? 2.4 + breath * 0.5 : 1.9);
    const glowA = isActive ? 0.42 + pulse * 0.30 : isAgent ? 0.18 + breath * 0.14 : 0.14;
    const ga = Math.round(Math.min(glowA, 1) * 255).toString(16).padStart(2, "0");
    const grad = ctx.createRadialGradient(x, y, r * 0.6, x, y, glowR);
    grad.addColorStop(0, n.color + ga);
    grad.addColorStop(1, n.color + "00");
    ctx.beginPath(); ctx.arc(x, y, glowR, 0, 2 * Math.PI);
    ctx.fillStyle = grad; ctx.fill();

    if (isActive) {
      // Anel pulsante externo — reservamos shadowBlur para os pouquíssimos ativos.
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r + 2.5 + pulse * 3, 0, 2 * Math.PI);
      ctx.strokeStyle = n.color + Math.round((0.5 + pulse * 0.4) * 255).toString(16).padStart(2, "0");
      ctx.lineWidth = 1 + pulse * 1.4;
      ctx.shadowColor = n.color; ctx.shadowBlur = 12 + pulse * 10;
      ctx.stroke();
      ctx.restore();
    }

    // 2) DISCO — corpo do nó.
    if (n.id === "artifact-group") {
      // Agregador de artefatos — círculo tracejado.
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.setLineDash([2, 2]); ctx.strokeStyle = "#8A93A8"; ctx.lineWidth = 1.1; ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isAgent ? n.color : n.color + "D8";
      ctx.fill();
      // 3) RIM LIGHT — aro fino claro que dá volume/leitura sobre o fundo escuro.
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.strokeStyle = isAgent ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.28)";
      ctx.lineWidth = isAgent ? 1 : 0.6;
      ctx.stroke();
    }

    // 4) GLYPH — avatar/ícone dentro do nó.
    const drawCentered = (text: string, size: number, font: string, fill: string) => {
      ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = fill;
      const m = ctx.measureText(text);
      const ascent = m.actualBoundingBoxAscent ?? size * 0.7;
      const descent = m.actualBoundingBoxDescent ?? size * 0.2;
      ctx.fillText(text, x, y + (ascent - descent) / 2);
    };
    if (isAgent) {
      const es = Math.max(r * 1.0, 5);
      drawCentered(n.detail ?? "⬡", es, `${es}px serif`, "#FFFFFF");
    } else if (n.type === "task") {
      const icon = n.detail === "DONE" || n.detail === "QA_PASS" ? "✓"
        : n.detail === "IN_PROGRESS" || n.detail === "WAITING_REVIEW" ? "⟳"
        : n.detail === "QA_FAIL" || n.detail === "BLOCKED" ? "✗" : "·";
      const ts = Math.max(r * 0.9, 4);
      drawCentered(icon, ts, `bold ${ts}px Inter, sans-serif`, "#0B0E14");
    } else if (n.id === "artifact-group") {
      const countStr = n.label.split(" ")[0]; // ex.: "99+"
      const cs = Math.max(r * 0.8, 4);
      drawCentered(countStr, cs, `bold ${cs}px Inter, sans-serif`, "#E6EDF3");
    } else if (n.type === "doc") {
      const iconMap: Record<string, string> = { cto: "🎯", engineer: "⚙️", pm: "📋", qa: "✅", devops: "🐳", spec: "📄", other: "📁" };
      const ds = Math.max(r * 0.85, 4);
      drawCentered(iconMap[n.detail ?? "other"] ?? "📁", ds, `${ds}px serif`, "#FFFFFF");
    }

    // 5) LABEL — rótulo com halo escuro para contraste. Roster SEMPRE rotulado;
    //    satélites só quando dá zoom (evita poluição visual em repouso).
    const showLabel = isAgent || globalScale > 1.3;
    if (showLabel) {
      const fontSize = Math.max((isAgent ? 12 : 10) / globalScale, 1.5);
      ctx.font = `${isAgent ? "600 " : ""}${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const ly = y + r + fontSize * 1.15;
      ctx.lineWidth = 3 / globalScale;
      ctx.strokeStyle = "rgba(8,10,16,0.9)";
      ctx.strokeText(n.label, x, ly);
      ctx.fillStyle = isAgent ? "#EAECEF" : "#9AA4B8";
      ctx.fillText(n.label, x, ly);
    }
  }, []);

  // Canvas dims: always numbers — use measured container size (ResizeObserver);
  // fall back to prop if observer hasn't fired yet; treat "100%" as 600 placeholder
  const canvasW = containerSize.width  || 800;
  const canvasH = containerSize.height || (typeof height === "number" ? height : 600);

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

  return (
    <Box
      ref={containerRef}
      sx={{ height: "100%", minHeight: height, bgcolor: "#0A0C11", borderRadius: 1, overflow: "hidden", position: "relative" }}
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={fgData}
        width={canvasW}
        height={canvasH}
        backgroundColor="#0A0C11"
        // Fótons AMBIENTES (1 por aresta do backbone) mantêm o canvas repintando mesmo
        // com a física congelada (a engine faz doRedraw quando há __photons ativos) →
        // streams + breathing animam sozinhos. autoPauseRedraw fica ligado: se só
        // sobrarem satélites (sem fóton), o canvas pausa e poupa CPU.
        autoPauseRedraw
        onRenderFramePre={paintBackground}
        onRenderFramePost={paintVignette}
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => "replace"}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as FGNode;
          if (!isFinite(n.x ?? NaN) || !isFinite(n.y ?? NaN)) return;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x as number, n.y as number, (n.size ?? 4) + 3, 0, 2 * Math.PI);
          ctx.fill();
        }}
        linkColor={linkColorFn}
        linkWidth={linkWidthFn}
        linkCurvature={linkCurveFn}
        // STREAMS sinápticos — o "cérebro conversando": 1 fóton contínuo por aresta do
        // backbone (tráfego ambiente), dessincronizados por offset de fase; velocidade
        // sobe quando a aresta fica "quente" (evento). Bursts extras via emitParticle.
        // Cada fóton é desenhado como COMETA (glow aditivo + rastro) pelo canvasObject.
        linkDirectionalParticles={particleCountFn}
        linkDirectionalParticleSpeed={particleSpeedFn}
        linkDirectionalParticleOffset={particleOffsetFn}
        linkDirectionalParticleWidth={2.4}
        linkDirectionalParticleColor={(link) => {
          const l = link as FGLink;
          return (l.__hotUntil ?? 0) > performance.now() ? (l.__packetColor ?? AMBIENT_STREAM_COLOR) : AMBIENT_STREAM_COLOR;
        }}
        linkDirectionalParticleCanvasObject={particleCanvasObject}
        nodeRelSize={1}
        // Física estável: assenta e CONGELA (sem reheat perpétuo).
        d3AlphaDecay={0.035}
        d3VelocityDecay={0.55}
        d3AlphaMin={0.02}
        warmupTicks={40}
        cooldownTicks={220}
        cooldownTime={9000}
        onEngineStop={() => {
          // Enquadra UMA vez quando o layout assenta (ou quando a topologia muda).
          if (needsFitRef.current && fgRef.current) {
            try { fgRef.current.zoomToFit?.(700, 80); } catch { /* fgRef pode sumir */ }
            needsFitRef.current = false;
          }
        }}
        onBackgroundClick={handleBackgroundClick}
        onNodeHover={(node) => {
          if (!node) { setTooltip(null); return; }
          const n = node as FGNode;
          setTooltip({ label: n.label, detail: n.detail });
        }}
        onNodeClick={(node) => {
          const n = node as FGNode;
          if (n.type === "task") {
            const task = taskMapRef.current.get(n.id);
            if (task) { setTaskDrawer(task); return; }
          }
          setTooltip({ label: n.label, detail: n.detail });
        }}
      />

      {/* Switcher de MODELOS — top left (glassy/HUD). O ativo mostra ícone + rótulo. */}
      <Box sx={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 0.5, p: 0.5,
        bgcolor: "#0C111BE6", border: "1px solid #1E2636", borderRadius: 2,
        backdropFilter: "blur(6px)", zIndex: 3 }}>
        {LAYOUT_CYCLE.map(m => {
          const meta = LAYOUT_META[m]; const active = layoutMode === m;
          return (
            <Box key={m} component="button" title={meta.tip}
              onClick={() => setLayoutMode(m)}
              sx={{
                cursor: "pointer", border: "1px solid",
                borderColor: active ? "#4C8DFF" : "transparent",
                bgcolor: active ? "#4C8DFF22" : "transparent",
                color: active ? "#CFE0FF" : "#7C8698",
                borderRadius: 1.5, px: 0.9, py: 0.5, lineHeight: 1,
                display: "flex", alignItems: "center", gap: 0.5,
                fontSize: "0.72rem", fontFamily: "inherit",
                boxShadow: active ? "0 0 10px #4C8DFF55" : "none",
                transition: "all .18s ease",
                "&:hover": { color: "#DCE6FF", bgcolor: "#4C8DFF18" },
              }}>
              <span style={{ fontSize: "0.9rem" }}>{meta.icon}</span>
              {active && <span style={{ fontWeight: 600 }}>{meta.label}</span>}
            </Box>
          );
        })}
      </Box>

      {/* Indicador do sistema nervoso — top right */}
      <Box sx={{ position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5 }}>
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
          <Chip
            label={revealCount !== null ? "◐ revelando…" : "▶ animar"}
            size="small"
            onClick={revealCount === null ? handleAnimate : undefined}
            clickable={revealCount === null}
            title="Revela o time nó a nó"
            sx={{
              bgcolor: "#0F1420EE",
              color: revealCount !== null ? "#7FB0FF" : "#9AA4B8",
              border: "1px solid",
              borderColor: revealCount !== null ? "#4C8DFF55" : "#2A3040",
              fontSize: "0.6rem", height: 22, cursor: revealCount === null ? "pointer" : "default",
              transition: "all 0.3s ease",
              "&:hover": revealCount === null ? { color: "#DCE6FF", borderColor: "#4C8DFF55", bgcolor: "#4C8DFF18" } : {},
            }}
          />
          <Chip
            label={liveConnected ? "● ao vivo" : "○ em espera"}
            size="small"
            sx={{
              bgcolor: "#0F1420EE",
              color: liveConnected ? "#34D399" : "#8B949E",
              border: "1px solid",
              borderColor: liveConnected ? "#34D39955" : "#2A3040",
              fontSize: "0.6rem", height: 22, pointerEvents: "none",
              transition: "all 0.3s ease",
            }}
          />
          {activeAgent && (
            <Chip
              label="⚡ trabalhando"
              size="small"
              sx={{
                bgcolor: "#4C8DFF22", color: "#7FB0FF",
                border: "1px solid #4C8DFF55",
                fontSize: "0.6rem", height: 22, pointerEvents: "none",
                transition: "all 0.3s ease",
              }}
            />
          )}
        </Box>
        <Typography variant="caption" sx={{ color: "#4A5266", fontSize: "0.58rem", textAlign: "right", maxWidth: 180, lineHeight: 1.3, pointerEvents: "none" }}>
          time de IA do Genesis · clique no fundo troca de modelo
        </Typography>
      </Box>

      {/* Tooltip */}
      {tooltip && (
        <Box sx={{ position: "absolute", top: 52, left: 8, bgcolor: "#0F1420EE", border: "1px solid #2A3040", borderRadius: 1, px: 1.5, py: 1, maxWidth: 220, pointerEvents: "none", zIndex: 3 }}>
          <Typography variant="caption" fontWeight={600} color="text.primary">{tooltip.label}</Typography>
          {tooltip.detail && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>{tooltip.detail}</Typography>
          )}
        </Box>
      )}

      {/* Legenda */}
      <Box sx={{ position: "absolute", bottom: 8, left: 8, display: "flex", gap: 1.5, flexWrap: "wrap", pointerEvents: "none" }}>
        {[
          { color: "#4C8DFF", label: "Time de IA" }, { color: "#2FBF71", label: "Task OK" },
          { color: "#F26D6D", label: "Task Fail" }, { color: "#61DAFB", label: "Artefato" },
        ].map(item => (
          <Box key={item.label} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: item.color }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.6rem" }}>{item.label}</Typography>
          </Box>
        ))}
      </Box>

      {/* Task detail drawer */}
      <TaskDetailDrawer task={taskDrawer} onClose={() => setTaskDrawer(null)} />
    </Box>
  );
}
