/**
 * provisionPlanIR.ts — DM-T3 (Fase A). A IR (intermediate representation) do plano de
 * provisionamento: a FONTE ÚNICA que drivers SDK (produção/demo) E renderers de IaC
 * (source_only: compose/terraform/k8s/CI) consomem.
 *
 * Princípio: o Terraform/k8s gerado por source_only é, byte-a-byte, a MESMA infra que os
 * drivers SDK provisionam — porque ambos derivam desta IR. O IaC nunca "mente".
 *
 * É PURA: não toca AWS, não depende de ProvisionContext. Deriva de topologia (T24) +
 * matriz (T23/DM-T1) + multi-schema (T26) + config de DNS. Assim os renderers a montam a
 * partir de uma spec resolvida, sem credencial nem deployment vivo.
 */

import type { ServicePlan, Topology } from "./tenantProvisioner.js";
import { orderByRouteSpecificity } from "./tenantProvisioner.js";
import type { DeliveryMode, RuntimeTarget } from "./deployMatrix.js";

/** Decisão de banco de dados do plano (deriva de db_mode + presença de serviço api). */
export type DbMode = "auto" | "rds" | "sidecar" | "none" | "external";

/** Como o DB é materializado em cada saída. */
export type DbResolution =
  | { kind: "rds"; engine: "postgres"; version: string; databases: string[] }
  | { kind: "sidecar"; engine: "postgres"; version: string; databases: string[] }
  | { kind: "external" }   // cliente informa DATABASE_URL
  | { kind: "none" };

export interface PlanService {
  name: string;
  role: ServicePlan["role"];
  runtime: ServicePlan["runtime"];
  port: number;
  healthPath: string;
  /** Prefixo de rota externa (ordenado por especificidade no plano). */
  routePrefix: string;
  /** Nome do repositório de imagem (ECR em produção; tag local no compose). */
  imageRepo: string;
  /** Database dedicado do serviço (multi-schema), quando aplica. */
  databaseName?: string;
  /** true = recebe o catch-all "/" (web ou único serviço). */
  isRoot: boolean;
  /** Precisa de ingress externo (api/web). worker = false. */
  needsIngress: boolean;
}

export interface ProvisionPlanIR {
  projectId: string;
  deliveryMode: DeliveryMode;
  runtimeTarget: RuntimeTarget;
  multiService: boolean;
  /** Serviços já ordenados por especificidade de rota (/api/auth antes de /api antes de /). */
  services: PlanService[];
  rootServiceName: string;
  db: DbResolution;
  /** Domínio: subdomínio Zentriz automático OU domínio próprio do cliente (CNAME). */
  domain: { mode: "zentriz_subdomain" | "custom"; hostname?: string };
  /** Portas expostas pelo ingress (ALB/Ingress). */
  externalPorts: number[];
}

const DEFAULT_PG_VERSION = "16";

/**
 * Resolve a decisão de DB a partir do db_mode escolhido + topologia.
 * auto: se há serviço api → sidecar em demo/source_only, rds em produção; senão none.
 */
export function resolveDbResolution(
  dbMode: DbMode, deliveryMode: DeliveryMode, databases: string[],
): DbResolution {
  const version = DEFAULT_PG_VERSION;
  const hasDb = databases.length > 0;
  if (dbMode === "none") return { kind: "none" };
  if (dbMode === "external") return { kind: "external" };
  if (dbMode === "rds") return hasDb ? { kind: "rds", engine: "postgres", version, databases } : { kind: "none" };
  if (dbMode === "sidecar") return hasDb ? { kind: "sidecar", engine: "postgres", version, databases } : { kind: "none" };
  // auto
  if (!hasDb) return { kind: "none" };
  // produção → RDS gerenciado; demo/source_only → sidecar barato.
  if (deliveryMode === "production") return { kind: "rds", engine: "postgres", version, databases };
  return { kind: "sidecar", engine: "postgres", version, databases };
}

export interface BuildPlanInput {
  projectId: string;
  topology: Topology;
  deliveryMode: DeliveryMode;
  runtimeTarget: RuntimeTarget;
  dbMode: DbMode;
  /** databases por serviço api (do multiSchema); vazio = sem banco. */
  serviceDatabases: Record<string, string>;
  domainMode: "zentriz_subdomain" | "custom";
  customHostname?: string;
}

/**
 * Monta a IR pura do plano. Não executa nada — só descreve o que deve existir.
 */
export function buildProvisionPlan(input: BuildPlanInput): ProvisionPlanIR {
  const ordered = orderByRouteSpecificity(input.topology.services);
  const services: PlanService[] = ordered.map((s) => ({
    name: s.name,
    role: s.role,
    runtime: s.runtime,
    port: s.port,
    healthPath: s.healthPath,
    routePrefix: s.routePrefix,
    imageRepo: s.ecrRepoName,
    databaseName: input.serviceDatabases[s.name],
    isRoot: s.name === input.topology.rootServiceName,
    needsIngress: s.role === "api" || s.role === "web",
  }));

  const databases = [...new Set(Object.values(input.serviceDatabases).filter(Boolean))];
  const db = resolveDbResolution(input.dbMode, input.deliveryMode, databases);

  const externalPorts = services.some((s) => s.needsIngress) ? [80, 443] : [];

  return {
    projectId: input.projectId,
    deliveryMode: input.deliveryMode,
    runtimeTarget: input.runtimeTarget,
    multiService: input.topology.multiService,
    services,
    rootServiceName: input.topology.rootServiceName,
    db,
    domain: { mode: input.domainMode, hostname: input.customHostname },
    externalPorts,
  };
}
