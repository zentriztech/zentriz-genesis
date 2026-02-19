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
    personality: "Arquitetura e squads técnicas.",
    avatar: "⚙️",
    color: "#2e7d32",
  },
  pm: {
    id: "pm",
    name: "PM",
    personality: "Backlog e equipe da squad.",
    avatar: "📋",
    color: "#ed6c02",
  },
  pm_backend: {
    id: "pm_backend",
    name: "PM",
    personality: "Backlog e equipe da squad.",
    avatar: "📋",
    color: "#ed6c02",
  },
  pm_web: {
    id: "pm_web",
    name: "PM Web",
    personality: "Backlog e equipe da squad Web.",
    avatar: "🌐",
    color: "#0288d1",
  },
  pm_mobile: {
    id: "pm_mobile",
    name: "PM Mobile",
    personality: "Backlog e equipe da squad Mobile.",
    avatar: "📱",
    color: "#7b1fa2",
  },
  dev: {
    id: "dev",
    name: "Dev",
    personality: "Implementação contínua.",
    avatar: "🔧",
    color: "#00897b",
  },
  dev_backend: {
    id: "dev_backend",
    name: "Dev",
    personality: "Implementação contínua.",
    avatar: "🔧",
    color: "#00897b",
  },
  dev_backend_nodejs: {
    id: "dev_backend_nodejs",
    name: "Dev",
    personality: "Implementação contínua (Node.js).",
    avatar: "🔧",
    color: "#00897b",
  },
  qa: {
    id: "qa",
    name: "QA",
    personality: "Testes e validação.",
    avatar: "✅",
    color: "#43a047",
  },
  qa_backend: {
    id: "qa_backend",
    name: "QA",
    personality: "Testes e validação.",
    avatar: "✅",
    color: "#43a047",
  },
  qa_backend_nodejs: {
    id: "qa_backend_nodejs",
    name: "QA",
    personality: "Testes e validação (Node.js).",
    avatar: "✅",
    color: "#43a047",
  },
  devops: {
    id: "devops",
    name: "DevOps",
    personality: "IaC, CI/CD e provisionamento.",
    avatar: "🐳",
    color: "#0d47a1",
  },
  devops_docker: {
    id: "devops_docker",
    name: "DevOps",
    personality: "IaC, CI/CD e provisionamento.",
    avatar: "🐳",
    color: "#0d47a1",
  },
  monitor: {
    id: "monitor",
    name: "Monitor",
    personality: "Acompanhamento e acionamento QA/DevOps.",
    avatar: "👁️",
    color: "#5e35b1",
  },
  monitor_backend: {
    id: "monitor_backend",
    name: "Monitor",
    personality: "Acompanhamento e acionamento QA/DevOps.",
    avatar: "👁️",
    color: "#5e35b1",
  },
  system: {
    id: "system",
    name: "Sistema",
    personality: "Log de passos do pipeline.",
    avatar: "📋",
    color: "#546e7a",
  },
  error: {
    id: "error",
    name: "Erro",
    personality: "Falha de processamento.",
    avatar: "⚠️",
    color: "#c62828",
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
