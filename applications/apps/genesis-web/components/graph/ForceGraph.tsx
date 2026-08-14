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
      size, detail: profile.avatar, fx: pos.fx, fy: pos.fy,
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

// ── Constelação: as posições dos AGENTES são fixadas em buildForceData (fx/fy). ─
// Não há mais múltiplos modos de layout — um único mapa estável e legível. Os
// satélites (tasks/docs/artefatos) assentam por física perto do dono e congelam.

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
  // Task drawer — abre ao clicar num nó de task
  const [taskDrawer, setTaskDrawer] = useState<TaskItem | null>(null);
  const taskMapRef = useRef<Map<string, TaskItem>>(new Map());

  const filterRef = useRef(filter);
  useEffect(() => { filterRef.current = filter; }, [filter]);

  // Pulso animado (0..1) para o halo do agente ativo. activeKeyRef é lido pelo painter
  // SEM disparar rebuild — mudar o agente ativo não re-simula a física.
  const pulseRef      = useRef<number>(0);
  const rafRef        = useRef<number>(0);
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

    tasks.forEach(t => taskMapRef.current.set(`task-${t.taskId}`, t));
    const data = buildForceData(dialogue, tasks, files, planningDocs, false, filterRef.current);

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
          // Preserva posição física (x,y,vx,vy); reafirma pin (fx/fy) e visual.
          return { ...ex, fx: n.fx, fy: n.fy, color: n.color, detail: n.detail, size: n.size, label: n.label, role: n.role };
        }
        return n;
      });
      if (merged.length !== prev.nodes.length) needsFitRef.current = true;
      return { nodes: merged, links: data.links };
    });
  }, [planningDocs]);

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

  // ── RAF: pulso do agente ativo (auto-desliga após 6s sem novo "working") ────
  useEffect(() => {
    if (!activeAgent) { pulseRef.current = 0; return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      // Expira o estado ativo se faz tempo que ninguém trabalha (evita RAF eterno).
      if (now - lastWorkAtRef.current > 6000) { pulseRef.current = 0; setActiveAgent(null); return; }
      pulseRef.current = (Math.sin((now - t0) / 420) + 1) / 2; // 0..1 suave
      // NÃO chamamos refresh() — esse método não existe em react-force-graph-2d@1.29.1.
      // O repaint contínuo do pulso vem de autoPauseRedraw={false} enquanto há agente
      // ativo (o loop de render interno do force-graph lê pulseRef a cada frame).
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeAgent]);

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

  // ── Recentraliza ao clicar no fundo (não embaralha o layout) ───────────────
  const handleBackgroundClick = useCallback(() => {
    needsFitRef.current = true;
    fgRef.current?.zoomToFit?.(600, 70);
  }, []);

  // Links já vêm prontos do rebuild; a pintura decide largura/cor/curvatura por kind.
  const displayLinks = useMemo(() => graphData.links, [graphData.links]);

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
    if (l.kind === "flow" || l.kind === "orch") return 0.18; // curva orgânica no pipeline
    return 0; // spoke/satellite retos = leitura estrutural limpa
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
    const x = n.x as number; const y = n.y as number;
    const isAgent = n.type === "agent";
    const isActive = isAgent && activeKeyRef.current === n.role;
    const pulse = pulseRef.current; // 0..1 via RAF (só quando há agente ativo)
    const r = (n.size ?? 4) * (isActive ? 1.15 + pulse * 0.12 : 1);

    // 1) GLOW — halo suave por gradiente radial (barato; shadowBlur fica só p/ ativo).
    const glowR = r * (isActive ? 3.6 + pulse * 1.2 : isAgent ? 2.4 : 1.9);
    const glowA = isActive ? 0.42 + pulse * 0.30 : isAgent ? 0.20 : 0.14;
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
        graphData={{ nodes: graphData.nodes as object[], links: displayLinks as object[] }}
        width={canvasW}
        height={canvasH}
        backgroundColor="#0A0C11"
        // Enquanto um agente pulsa, mantém o canvas repintando (o RAF anima pulseRef);
        // em repouso, deixa o force-graph pausar o render (a partícula de um evento
        // ainda dispara redraw sozinha por __photons). Evita 60fps eternos à toa.
        autoPauseRedraw={!activeAgent}
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
        // Sem partículas permanentes — os pacotes vivos são emitidos via emitParticle
        // no instante do evento (handleLiveEvent). Cor por tipo de evento.
        linkDirectionalParticles={0}
        linkDirectionalParticleWidth={2.4}
        linkDirectionalParticleColor={(link) => {
          const l = link as FGLink;
          return l.__packetColor ?? l.color;
        }}
        linkDirectionalParticleSpeed={0.012}
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

      {/* Indicador do sistema nervoso — top right */}
      <Box sx={{ position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5 }}>
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
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
          time de IA do Genesis · clique no fundo para reenquadrar
        </Typography>
      </Box>

      {/* Tooltip */}
      {tooltip && (
        <Box sx={{ position: "absolute", top: 8, left: 8, bgcolor: "#0F1420EE", border: "1px solid #2A3040", borderRadius: 1, px: 1.5, py: 1, maxWidth: 220, pointerEvents: "none" }}>
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
