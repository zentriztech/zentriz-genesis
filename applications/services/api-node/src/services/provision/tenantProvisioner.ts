/**
 * tenantProvisioner.ts — G1-T24 (Fase E). Orquestração MULTI-SERVIÇO.
 *
 * LOCK de topologia (cravado nesta tarefa): um produto multi-serviço é UM projeto cujo
 * `apps/` contém subpastas de serviço (`apps/api`, `apps/web`, `apps/auth`, ...), cada
 * uma com Dockerfile + runtime detectável. Se `apps/` é ele mesmo um serviço (tem
 * package.json/Dockerfile na raiz de apps/), é single-service — o caso N=1.
 * (A alternativa "N projetos sob product_id" fica fora do GATE 1.)
 *
 * A cadeia se divide em DUAS camadas:
 *   • COMPARTILHADA (create-once, idempotente): VPC/subnets/SG (networking), RDS/secrets
 *     base, ALB, cluster ECS, Cloud Map namespace. Uma vez por deployment.
 *   • POR-SERVIÇO (saga-rollback): ECR repo + task-def + ECS service + target group por
 *     serviço. Falha no serviço K compensa só o serviço K, sem derrubar os anteriores nem
 *     o RDS/ALB compartilhados.
 *
 * Este módulo entrega o RESOLVER de topologia + PLANNER de serviços. A execução da cadeia
 * reusa os drivers single-service (ctx.scratch.dir aponta p/ a subpasta do serviço).
 * Single-service continua idêntico: resolveTopology devolve 1 serviço e o caminho é o mesmo.
 */

import { readdir } from "fs/promises";
import path from "path";
import { detectRuntime, type DetectedService } from "./runtimeDetector.js";
import { classifyServiceRole, type ServiceRole } from "./serviceRole.js";

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", "coverage", "__pycache__", "public"]);

export interface ServicePlan {
  /** Nome curto do serviço (subpasta, ou "app" p/ single-service). */
  name: string;
  /** Diretório do serviço (apps/<name> ou apps/). */
  dir: string;
  runtime: DetectedService["runtime"];
  role: ServiceRole;
  port: number;
  healthPath: string;
  /** Repositório ECR determinístico por serviço: genesis/<projectId>/<name>. */
  ecrRepoName: string;
  /** Prefixo de rota externa no ALB (derivado do papel/nome — usado por T25). */
  routePrefix: string;
}

export interface Topology {
  /** N=1 → single-service (caminho idêntico ao MVP); N>1 → multi-serviço. */
  multiService: boolean;
  services: ServicePlan[];
  /** Serviço que recebe o catch-all "/" (o web, ou o único serviço). */
  rootServiceName: string;
}

async function hasServiceMarker(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.includes("package.json") || entries.includes("Dockerfile") ||
           entries.includes("pyproject.toml") || entries.includes("main.py") ||
           entries.includes("requirements.txt");
  } catch { return false; }
}

/** Prefixo de rota externa por papel/nome (T25 ordena por especificidade). */
function routePrefixFor(name: string, role: ServiceRole): string {
  if (role === "web") return "/";              // catch-all
  if (name === "auth") return "/api/auth";     // mais específico que /api
  if (role === "api") return "/api";
  return `/${name}`;                            // worker/outros (normalmente sem ingress)
}

async function planService(projectId: string, dir: string, name: string): Promise<ServicePlan> {
  const svc = await detectRuntime(dir);
  const role = classifyServiceRole(svc);
  return {
    name, dir,
    runtime: svc.runtime, role, port: svc.port, healthPath: svc.healthPath,
    ecrRepoName: `genesis/${projectId}/${name}`,
    routePrefix: routePrefixFor(name, role),
  };
}

/**
 * Resolve a topologia de um projeto a partir do seu diretório `apps/`.
 * @param appsDir  diretório apps/ do projeto clonado.
 * @param projectId  usado p/ nomear os repos ECR.
 */
export async function resolveTopology(appsDir: string, projectId: string): Promise<Topology> {
  // Single-service: apps/ é o próprio serviço.
  if (await hasServiceMarker(appsDir)) {
    const svc = await planService(projectId, appsDir, "app");
    return { multiService: false, services: [svc], rootServiceName: "app" };
  }

  // Multi-serviço: subpastas de apps/ que são serviços.
  let entries: string[] = [];
  try {
    const dirents = await readdir(appsDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name)).map((d) => d.name);
  } catch { /* apps ausente */ }

  const services: ServicePlan[] = [];
  for (const name of entries.sort()) {
    const dir = path.join(appsDir, name);
    if (await hasServiceMarker(dir)) {
      services.push(await planService(projectId, dir, name));
    }
  }

  if (services.length === 0) {
    // Nada reconhecível — trata apps/ como single-service (o build falhará adiante com msg clara).
    const svc = await planService(projectId, appsDir, "app");
    return { multiService: false, services: [svc], rootServiceName: "app" };
  }
  if (services.length === 1) {
    return { multiService: false, services, rootServiceName: services[0].name };
  }

  // Root = o serviço web (catch-all); se não houver web, o primeiro api.
  const web = services.find((s) => s.role === "web");
  const api = services.find((s) => s.role === "api");
  const rootServiceName = (web ?? api ?? services[0]).name;
  return { multiService: true, services, rootServiceName };
}

/**
 * Ordena os serviços por especificidade de prefixo de rota (mais específico primeiro) —
 * consumido pelo ALB path-routing (T25): /api/auth ANTES de /api ANTES de "/".
 */
export function orderByRouteSpecificity(services: ServicePlan[]): ServicePlan[] {
  return [...services].sort((a, b) => {
    // catch-all "/" sempre por último.
    if (a.routePrefix === "/") return 1;
    if (b.routePrefix === "/") return -1;
    // mais segmentos = mais específico = primeiro.
    return b.routePrefix.split("/").length - a.routePrefix.split("/").length;
  });
}
