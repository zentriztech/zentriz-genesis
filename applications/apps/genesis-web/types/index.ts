export type PlanSlug = "prata" | "ouro" | "diamante";

export interface Plan {
  id: string;
  slug: PlanSlug;
  name: string;
  maxProjects: number;
  maxUsersPerTenant: number;
  /** Preço mensal em centavos (BRL). 0 = gratuito/a definir. */
  monthlyPriceCents: number;
}

export type TenantStatus = "active" | "suspended" | "inactive";

/** Campos de contato / CNPJ / responsável / endereço do tenant (reforma Fase B). */
export interface TenantContact {
  email: string | null;
  emailConfirmed: boolean;
  cnpj: string | null;
  responsibleName: string | null;
  responsibleEmail: string | null;
  responsiblePhone: string | null;
  addressCep: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressDistrict: string | null;
  addressCity: string | null;
  addressState: string | null;
}

export interface Tenant extends TenantContact {
  id: string;
  name: string;
  planId: string;
  plan: Plan;
  status: TenantStatus;
  createdAt: string;
  /** Contadores de uso (só na listagem do master GET /api/tenants). */
  usersCount?: number;
  projectsCount?: number;
}

/** Resultado normalizado de GET /api/cnpj/:cnpj. */
export interface CnpjLookupResult {
  cnpj: string;
  name: string;
  tradeName?: string;
  status?: string;
  email?: string;
  phone?: string;
  address: {
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
  };
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
  | "blocked_cyborg"
  | "archived";

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
  /** Nome legível do produto (vem do JOIN em GET /api/projects, sob o mesmo escopo de tenant). */
  productName?: string | null;
  /** true quando o produto é o INBOX "Rascunhos" do tenant (pré-fábrica, re-alocável). */
  productIsInbox?: boolean | null;
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
  /** URL do repositório GitHub, quando criado (badge nas listas). */
  repoUrl?: string | null;
  /** Nome completo owner/repo do GitHub. */
  repoFullName?: string | null;
  /** URL do deploy S3 ativo, quando houver (badge nas listas). */
  deployUrl?: string | null;
  /** Status do deploy S3 ativo (running / provisioning / running_degraded). */
  deployStatus?: string | null;
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
