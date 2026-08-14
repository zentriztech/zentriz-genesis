"use client";

import { makeAutoObservable, runInAction } from "mobx";
import { apiGet, apiPost } from "@/lib/api";

// ── Tipos (defensivos — o backend é externo; tudo pode faltar) ────────────────

export interface DeadpoolStatus {
  available: boolean;
  health?: string;
  ready?: boolean;
  reason?: string;
}

export interface DeadpoolProject {
  system_id?: string;
  service_id?: string;
  repo_url?: string;
  installation_id?: string | number;
}

export interface DeadpoolIncident {
  incident_id: string;
  service_name?: string;
  severity?: string;
  category?: string;
  environment?: string;
  status?: string;
  stored_at?: string;
}

export interface DeadpoolPatchPlan {
  branch_name?: string;
  commit_message?: string;
  candidate_files?: string[];
  risk_level?: string;
  blast_radius_level?: string;
  issue_title?: string;
}

export interface DeadpoolRuntimeReport {
  status?: string;
  execution_mode?: string;
  pr_url?: string;
  guardrail_violations?: unknown[];
  applied_changes?: unknown[];
}

export interface DeadpoolIncidentDetail {
  incident_id?: string;
  normalized_incident?: Record<string, unknown>;
  patch_plan?: DeadpoolPatchPlan;
  runtime_execution_report?: DeadpoolRuntimeReport;
  risk_level?: string;
  blast_radius_level?: string;
  executive_dossier?: unknown;
  [key: string]: unknown;
}

export interface DeadpoolKnowledgeEntry {
  title?: string;
  category?: string;
  summary?: string;
  recommended_action?: string;
  tags?: string[];
}

/** Estado efetivo de uma flag de poll por nuvem: valor vigente, origem e o default de env. */
export interface PollFlagState {
  value: boolean;
  source: "env" | "override";
  env_default: boolean;
}
export type MonitoringFlags = Record<string, PollFlagState>;

/** Nuvens de poll ativo, na ordem de exibição, com rótulo amigável. */
export const POLL_FLAG_META: { flag: string; cloud: string }[] = [
  { flag: "allow_cloudwatch_poll", cloud: "AWS CloudWatch" },
  { flag: "allow_azure_poll", cloud: "Azure Monitor" },
  { flag: "allow_gcp_poll", cloud: "GCP Monitoring" },
];

class DeadpoolStore {
  status: DeadpoolStatus | null = null;
  projects: DeadpoolProject[] = [];
  incidents: DeadpoolIncident[] = [];
  knowledge: DeadpoolKnowledgeEntry[] = [];
  incidentDetail: DeadpoolIncidentDetail | null = null;

  overviewLoading = false;
  overviewError: string | null = null;
  overviewLoaded = false;

  knowledgeLoading = false;
  knowledgeError: string | null = null;
  knowledgeLoaded = false;

  incidentLoading = false;
  incidentError: string | null = null;
  incidentDetailId: string | null = null;

  // ── Flags de poll ativo por nuvem (toggle via Portal, zentriz_admin) ──
  monitorEnabled = false;
  flags: MonitoringFlags = {};
  flagsAvailable = false;
  flagsReason: string | null = null;
  flagsLoading = false;
  flagsError: string | null = null;
  flagsLoaded = false;
  /** flag em gravação no momento (desabilita o switch dela) ou null. */
  flagSaving: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  /** true quando o Deadpool respondeu available:false (indisponível/desconectado). */
  get unavailable() {
    return this.status != null && this.status.available === false;
  }

  /** Carrega status + projetos + incidentes em paralelo. */
  async loadOverview() {
    if (this.overviewLoading) return;
    this.overviewLoading = true;
    this.overviewError = null;
    try {
      const [status, projects, incidents] = await Promise.all([
        apiGet<DeadpoolStatus>("/api/deadpool/status").catch(
          () => ({ available: false, reason: "Falha ao consultar status do Deadpool" } as DeadpoolStatus),
        ),
        apiGet<{ available?: boolean; projects?: DeadpoolProject[] }>("/api/deadpool/projects").catch(
          () => ({ available: false, projects: [] as DeadpoolProject[] }),
        ),
        apiGet<{ available?: boolean; incidents?: DeadpoolIncident[] }>("/api/deadpool/incidents").catch(
          () => ({ available: false, incidents: [] as DeadpoolIncident[] }),
        ),
      ]);
      runInAction(() => {
        this.status = status ?? null;
        this.projects = Array.isArray(projects?.projects) ? projects.projects : [];
        this.incidents = Array.isArray(incidents?.incidents) ? incidents.incidents : [];
        this.overviewLoaded = true;
      });
    } catch (err) {
      runInAction(() => {
        this.overviewError = err instanceof Error ? err.message : "Falha ao carregar o Deadpool";
      });
    } finally {
      runInAction(() => {
        this.overviewLoading = false;
      });
    }
  }

  /** Carrega a base de conhecimento (KB) do Deadpool. */
  async loadKnowledge() {
    if (this.knowledgeLoading) return;
    this.knowledgeLoading = true;
    this.knowledgeError = null;
    try {
      const data = await apiGet<{ available?: boolean; entries?: DeadpoolKnowledgeEntry[] }>(
        "/api/deadpool/knowledge",
      );
      runInAction(() => {
        this.knowledge = Array.isArray(data?.entries) ? data.entries : [];
        this.knowledgeLoaded = true;
      });
    } catch (err) {
      runInAction(() => {
        this.knowledgeError = err instanceof Error ? err.message : "Falha ao carregar a base de conhecimento";
        this.knowledge = [];
      });
    } finally {
      runInAction(() => {
        this.knowledgeLoading = false;
      });
    }
  }

  /** true se QUALQUER nuvem está com poll ativo ligado (para o resumo do card). */
  get anyPollOn(): boolean {
    return Object.values(this.flags).some((f) => f?.value === true);
  }

  /** Carrega o estado efetivo das flags de poll por nuvem (env × override). */
  async loadMonitoringFlags() {
    if (this.flagsLoading) return;
    this.flagsLoading = true;
    this.flagsError = null;
    try {
      const data = await apiGet<{ available?: boolean; reason?: string; monitorEnabled?: boolean; flags?: MonitoringFlags }>(
        "/api/deadpool/monitoring/flags",
      );
      runInAction(() => {
        this.flagsAvailable = data?.available === true;
        this.flagsReason = data?.reason ?? null;
        this.monitorEnabled = data?.monitorEnabled === true;
        this.flags = data?.flags && typeof data.flags === "object" ? data.flags : {};
        this.flagsLoaded = true;
      });
    } catch (err) {
      runInAction(() => {
        this.flagsError = err instanceof Error ? err.message : "Falha ao carregar as flags de monitoramento";
        this.flagsAvailable = false;
        this.flags = {};
      });
    } finally {
      runInAction(() => {
        this.flagsLoading = false;
      });
    }
  }

  /** Liga/desliga o override de uma flag de poll (null remove o override → volta ao env). */
  async setPollFlag(flag: string, value: boolean | null) {
    if (this.flagSaving) return; // evita toggles concorrentes
    this.flagSaving = flag;
    this.flagsError = null;
    try {
      const data = await apiPost<{ available?: boolean; monitorEnabled?: boolean; flags?: MonitoringFlags }>(
        "/api/deadpool/monitoring/flags",
        { flags: { [flag]: value } },
      );
      runInAction(() => {
        this.flagsAvailable = data?.available === true;
        this.monitorEnabled = data?.monitorEnabled === true;
        this.flags = data?.flags && typeof data.flags === "object" ? data.flags : this.flags;
      });
    } catch (err) {
      runInAction(() => {
        this.flagsError = err instanceof Error ? err.message : "Falha ao atualizar a flag";
      });
    } finally {
      runInAction(() => {
        this.flagSaving = null;
      });
    }
  }

  /** Carrega o documento completo de um incidente por id. */
  async loadIncident(id: string) {
    if (!id) return;
    this.incidentLoading = true;
    this.incidentError = null;
    this.incidentDetailId = id;
    try {
      const data = await apiGet<DeadpoolIncidentDetail>(`/api/deadpool/incidents/${id}`);
      runInAction(() => {
        this.incidentDetail = data ?? null;
      });
    } catch (err) {
      runInAction(() => {
        this.incidentError = err instanceof Error ? err.message : "Falha ao carregar o incidente";
        this.incidentDetail = null;
      });
    } finally {
      runInAction(() => {
        this.incidentLoading = false;
      });
    }
  }
}

export const deadpoolStore = new DeadpoolStore();
