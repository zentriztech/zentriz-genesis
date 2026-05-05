export type PlanSlug = "prata" | "ouro" | "diamante";

export interface Plan {
  id: string;
  slug: PlanSlug;
  name: string;
  maxProjects: number;
  maxUsersPerTenant: number;
}

export interface Tenant {
  id: string;
  name: string;
  planId: string;
  plan: Plan;
  status: "active" | "suspended";
  createdAt: string;
}

export type UserRole = "user" | "tenant_admin" | "zentriz_admin";

export interface User {
  id: string;
  email: string;
  name: string;
  tenantId: string | null;
  role: UserRole;
  status: "active" | "inactive";
  createdAt: string;
}

export type ProjectStatus =
  | "draft"
  | "spec_submitted"
  | "pending_conversion"
  | "cto_charter"
  | "pm_backlog"
  | "dev_qa"
  | "devops"
  | "completed"
  | "accepted"
  | "failed"
  | "running"
  | "stopped"
  | "pending_cyborg"
  | "blocked_cyborg";

export interface Project {
  id: string;
  tenantId: string;
  createdBy: string;
  title: string;
  specRef: string;
  status: ProjectStatus;
  charterSummary?: string;
  backlogSummary?: string;
  createdAt: string;
  updatedAt: string;
  /** Início do processo (ex.: quando spec foi aceita / pipeline iniciou). */
  startedAt?: string;
  /** Fim do processo (ex.: quando status passou a completed). */
  completedAt?: string;
  /** ID do projeto pai (null = primeira versão do produto). */
  parentProjectId?: string | null;
  /** Número da versão dentro da linhagem (1 = original, 2 = v2, etc.). */
  versionNumber?: number;
  /** Texto livre original digitado pelo usuário antes do CTO gerar a spec. */
  freeDescription?: string | null;
  /** Tipo do projeto selecionado na submissão da spec (e.g. "backend_api", "landing_page"). */
  projectType?: string | null;
  /** ID do produto ao qual este projeto pertence (opcional). */
  productId?: string | null;
  /** Complexidade do projeto: trivial / low / medium / high */
  complexityHint?: string | null;
  /** Quantidade de tasks (quando disponível no contexto de listagem de produto) */
  taskCount?: number | null;
  /** Quantidade de tasks concluídas (DONE ou QA_PASS) */
  taskDoneCount?: number | null;
  /** Posição na ordem topológica do produto (0 = raiz, 1 = segundo nível, etc.) */
  executionOrder?: number | null;
  /** Metadados adicionais em JSON (ex: accepted_by, evolution, evolution_request) */
  extra?: Record<string, unknown> | null;
  /** Número de tentativas do Cyborg (0 = nunca tentou) */
  cyborg_attempts?: number;
}

export interface Product {
  id: string;
  name: string;
  description?: string | null;
  status: "active" | "archived";
  project_count?: number;
  createdAt?: string;
  projects?: Project[];
}

export interface ProjectLink {
  id: string;
  from_project_id: string;
  to_project_id: string;
  relation_type: string;
  relation_label: string;
  direction: "outgoing" | "incoming";
  from_title?: string;
  to_title?: string;
  from_project_type?: string;
  to_project_type?: string;
  from_status?: string;
  to_status?: string;
  note?: string | null;
}

export interface Notification {
  id: string;
  userId: string;
  type: "project_finished" | "provisioning_done" | "blocked" | "alert";
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
