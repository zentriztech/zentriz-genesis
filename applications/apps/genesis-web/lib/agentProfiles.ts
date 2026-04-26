/**
 * Perfis dos agentes para exibição no Diálogo da equipe.
 *
 * Cada agente recebe um nome humano único da lista Zentriz com prefixo "IA-"
 * atribuído de forma determinística (baseado no role) — consistente entre sessões.
 *
 * Nomes disponíveis: Jean, Érica, Raul, Pedro, Ângelo, André, João, Arthur,
 * José, Maria, Cean, Kell, Lívia, Aurora, Kaleb, Laura, Halisson
 */
export interface AgentProfile {
  id: string;
  name: string;        // e.g. "IA-Jean"
  role: string;        // e.g. "CTO"
  personality: string;
  avatar: string;
  color: string;
}

// ── Nome humano por role (determinístico — não muda entre sessões) ─────────────
const ROLE_NAMES: Record<string, string> = {
  cto:                  "Jean",
  engineer:             "Raul",
  pm:                   "Érica",
  pm_web:               "Lívia",
  pm_backend:           "Kell",
  pm_mobile:            "Aurora",
  dev:                  "Pedro",
  dev_backend:          "André",
  dev_backend_nodejs:   "André",
  dev_backend_python:   "Halisson",
  dev_web:              "Pedro",
  qa:                   "Maria",
  qa_backend:           "Laura",
  qa_backend_nodejs:    "Laura",
  qa_backend_python:    "Kaleb",
  qa_web:               "Maria",
  devops:               "João",
  devops_docker:        "João",
  monitor:              "Arthur",
  monitor_backend:      "Arthur",
  engineer_backend:     "Raul",
  system:               "IA-Genesis",
  error:                "Sistema",
};

function iaName(role: string): string {
  const human = ROLE_NAMES[role];
  if (!human || human.startsWith("IA-") || human === "Sistema") return human ?? role;
  return `IA-${human}`;
}

// ── Profiles ──────────────────────────────────────────────────────────────────
export const agentProfiles: Record<string, AgentProfile> = {
  cto: {
    id: "cto",
    name: iaName("cto"),
    role: "CTO",
    personality: "Foco em produto, priorização e arquitetura de alto nível.",
    avatar: "🎯",
    color: "#6366F1",
  },
  engineer: {
    id: "engineer",
    name: iaName("engineer"),
    role: "Engineer",
    personality: "Arquitetura técnica, squads e dependências.",
    avatar: "⚙️",
    color: "#2e7d32",
  },
  pm: {
    id: "pm",
    name: iaName("pm"),
    role: "PM",
    personality: "Backlog executável e critérios de aceite.",
    avatar: "📋",
    color: "#ed6c02",
  },
  pm_backend: {
    id: "pm_backend",
    name: iaName("pm_backend"),
    role: "PM Backend",
    personality: "Backlog da squad backend.",
    avatar: "🖥️",
    color: "#ed6c02",
  },
  pm_web: {
    id: "pm_web",
    name: iaName("pm_web"),
    role: "PM Web",
    personality: "Backlog da squad web.",
    avatar: "🌐",
    color: "#0288d1",
  },
  pm_mobile: {
    id: "pm_mobile",
    name: iaName("pm_mobile"),
    role: "PM Mobile",
    personality: "Backlog da squad mobile.",
    avatar: "📱",
    color: "#7b1fa2",
  },
  dev: {
    id: "dev",
    name: iaName("dev"),
    role: "Dev",
    personality: "Implementação contínua de código.",
    avatar: "🔧",
    color: "#00897b",
  },
  dev_backend: {
    id: "dev_backend",
    name: iaName("dev_backend"),
    role: "Dev Backend",
    personality: "Implementação de APIs e servidores.",
    avatar: "🖥️",
    color: "#00897b",
  },
  dev_backend_nodejs: {
    id: "dev_backend_nodejs",
    name: iaName("dev_backend_nodejs"),
    role: "Dev Node.js",
    personality: "Implementação Node.js/TypeScript.",
    avatar: "🟢",
    color: "#00897b",
  },
  dev_backend_python: {
    id: "dev_backend_python",
    name: iaName("dev_backend_python"),
    role: "Dev Python",
    personality: "Implementação Python/FastAPI/Django.",
    avatar: "🐍",
    color: "#3776AB",
  },
  dev_web: {
    id: "dev_web",
    name: iaName("dev_web"),
    role: "Dev Web",
    personality: "Implementação frontend React/Next.js.",
    avatar: "⚛️",
    color: "#61DAFB",
  },
  qa: {
    id: "qa",
    name: iaName("qa"),
    role: "QA",
    personality: "Testes, validação e qualidade de código.",
    avatar: "✅",
    color: "#43a047",
  },
  qa_backend: {
    id: "qa_backend",
    name: iaName("qa_backend"),
    role: "QA Backend",
    personality: "Testes e validação de APIs.",
    avatar: "🔍",
    color: "#43a047",
  },
  qa_backend_nodejs: {
    id: "qa_backend_nodejs",
    name: iaName("qa_backend_nodejs"),
    role: "QA Node.js",
    personality: "Testes e validação Node.js.",
    avatar: "🔍",
    color: "#43a047",
  },
  qa_backend_python: {
    id: "qa_backend_python",
    name: iaName("qa_backend_python"),
    role: "QA Python",
    personality: "Testes e validação Python/FastAPI.",
    avatar: "🐍",
    color: "#388e3c",
  },
  qa_web: {
    id: "qa_web",
    name: iaName("qa_web"),
    role: "QA Web",
    personality: "Testes visuais e de responsividade.",
    avatar: "🎨",
    color: "#43a047",
  },
  devops: {
    id: "devops",
    name: iaName("devops"),
    role: "DevOps",
    personality: "Infraestrutura, CI/CD e provisionamento.",
    avatar: "🐳",
    color: "#0d47a1",
  },
  devops_docker: {
    id: "devops_docker",
    name: iaName("devops_docker"),
    role: "DevOps Docker",
    personality: "Deploy local e containerização.",
    avatar: "🐳",
    color: "#0d47a1",
  },
  monitor: {
    id: "monitor",
    name: iaName("monitor"),
    role: "Monitor",
    personality: "Coordena Dev/QA e garante progresso do pipeline.",
    avatar: "👁️",
    color: "#5e35b1",
  },
  monitor_backend: {
    id: "monitor_backend",
    name: iaName("monitor_backend"),
    role: "Monitor Backend",
    personality: "Coordena squad backend.",
    avatar: "👁️",
    color: "#5e35b1",
  },
  system: {
    id: "system",
    name: "IA-Genesis",
    role: "Sistema",
    personality: "Pipeline e log de eventos.",
    avatar: "✨",
    color: "#546e7a",
  },
  error: {
    id: "error",
    name: "Sistema",
    role: "Erro",
    personality: "Falha de processamento.",
    avatar: "⚠️",
    color: "#c62828",
  },
};

/** Retorna perfil do agente com nome IA-* ou fallback. */
export function getAgentProfile(agentId: string): AgentProfile {
  const normalized = agentId.toLowerCase().replace(/\s+/g, "_");
  const profile = agentProfiles[normalized] ?? agentProfiles[agentId];
  if (profile) return profile;

  // Fallback genérico: tenta derivar um nome da lista
  const NAMES = ["Jean","Érica","Raul","Pedro","Ângelo","André","João","Arthur",
                 "José","Maria","Cean","Kell","Lívia","Aurora","Kaleb","Laura","Halisson"];
  // Deterministic hash: soma dos char codes do agentId
  const hash = agentId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const humanName = NAMES[hash % NAMES.length];

  return {
    id: agentId,
    name: `IA-${humanName}`,
    role: agentId,
    personality: "Agente IA.",
    avatar: "🤖",
    color: "#757575",
  };
}
