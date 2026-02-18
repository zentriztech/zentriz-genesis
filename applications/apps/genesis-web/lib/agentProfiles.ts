/**
 * Perfis dos agentes para exibição no Diálogo da equipe.
 * id, nome, personalidade, avatar (emoji/ícone), cor predominante.
 */
export interface AgentProfile {
  id: string;
  name: string;
  personality: string;
  avatar: string;
  color: string;
}

export const agentProfiles: Record<string, AgentProfile> = {
  cto: {
    id: "cto",
    name: "Alex CTO",
    personality: "Foco em produto e priorização.",
    avatar: "🎯",
    color: "#1976d2",
  },
  engineer: {
    id: "engineer",
    name: "Eng. Sam",
    personality: "Arquitetura e stacks técnicas.",
    avatar: "⚙️",
    color: "#2e7d32",
  },
  pm_backend: {
    id: "pm_backend",
    name: "PM Backend",
    personality: "Backlog e equipe da stack Backend.",
    avatar: "📋",
    color: "#ed6c02",
  },
  pm_web: {
    id: "pm_web",
    name: "PM Web",
    personality: "Backlog e equipe da stack Web.",
    avatar: "🌐",
    color: "#0288d1",
  },
  pm_mobile: {
    id: "pm_mobile",
    name: "PM Mobile",
    personality: "Backlog e equipe da stack Mobile.",
    avatar: "📱",
    color: "#7b1fa2",
  },
  dev_backend: {
    id: "dev_backend",
    name: "Dev Backend",
    personality: "Implementação contínua Backend.",
    avatar: "🔧",
    color: "#00897b",
  },
  dev_backend_nodejs: {
    id: "dev_backend_nodejs",
    name: "Dev Backend Node.js",
    personality: "Implementação contínua Backend (Node.js).",
    avatar: "🔧",
    color: "#00897b",
  },
  qa_backend: {
    id: "qa_backend",
    name: "QA Backend",
    personality: "Testes e validação Backend.",
    avatar: "✅",
    color: "#43a047",
  },
  qa_backend_nodejs: {
    id: "qa_backend_nodejs",
    name: "QA Backend Node.js",
    personality: "Testes e validação Backend (Node.js).",
    avatar: "✅",
    color: "#43a047",
  },
  devops_docker: {
    id: "devops_docker",
    name: "DevOps Docker",
    personality: "IaC, CI/CD e provisionamento.",
    avatar: "🐳",
    color: "#0d47a1",
  },
  monitor_backend: {
    id: "monitor_backend",
    name: "Monitor Backend",
    personality: "Acompanhamento e acionamento QA/DevOps.",
    avatar: "👁️",
    color: "#5e35b1",
  },
};

/** Retorna perfil do agente ou um fallback com id como nome. */
export function getAgentProfile(agentId: string): AgentProfile {
  const normalized = agentId.toLowerCase().replace(/\s+/g, "_");
  return (
    agentProfiles[normalized] ??
    agentProfiles[agentId] ?? {
      id: agentId,
      name: agentId,
      personality: "Agente",
      avatar: "🤖",
      color: "#757575",
    }
  );
}
