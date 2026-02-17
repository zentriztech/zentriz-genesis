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
  | "cto_charter"
  | "pm_backlog"
  | "dev_qa"
  | "devops"
  | "completed"
  | "failed";

export interface Project {
  id: string;
  tenantId: string;
  createdBy: string;
  title: string;
  specRef: string;
  status: ProjectStatus;
  charterSummary?: string;
  createdAt: string;
  updatedAt: string;
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
