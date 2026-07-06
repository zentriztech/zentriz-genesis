/**
 * serviceDiscovery.ts — G1-T25 (Fase E). Descoberta interna leste-oeste (service→service).
 *
 * No docker-compose local, um serviço fala com outro por `http://api:3000` (nome do
 * container na rede do compose). Isso NÃO migra para o Fargate — lá cada task tem IP
 * próprio e não há resolução por nome de serviço a menos que se use ECS Service Connect
 * / Cloud Map, que expõe `<service>.<namespace>.local`.
 *
 * Este módulo:
 *  1. Calcula o namespace Cloud Map determinístico do deployment e o DNS interno de cada
 *     serviço: `<name>.<deploymentId12>.genesis.local`.
 *  2. Produz o MAPA de env de descoberta a injetar em cada serviço — ex.: o `api` recebe
 *     `AUTH_SERVICE_URL=http://auth.<ns>.local:<port>` para chamar o `auth` sem passar
 *     pelo ALB público.
 *
 * GATE 1 usa ECS Service Connect (configurado na própria task/service — sem SDK dedicado).
 * Aqui entregamos o PLANO (nomes + env); a aplicação liga o Service Connect no ecs driver.
 */

import type { ServicePlan } from "./tenantProvisioner.js";

/** Namespace Cloud Map do deployment (privado, por deployment). */
export function discoveryNamespace(deploymentId: string): string {
  return `${deploymentId.slice(0, 12)}.genesis.local`;
}

/** DNS interno de um serviço dentro do namespace. */
export function internalDnsName(deploymentId: string, serviceName: string): string {
  return `${serviceName}.${discoveryNamespace(deploymentId)}`;
}

/** URL interna (http) de um serviço, para chamadas leste-oeste. */
export function internalUrl(deploymentId: string, svc: ServicePlan): string {
  return `http://${internalDnsName(deploymentId, svc.name)}:${svc.port}`;
}

/** Nome de env convencional p/ apontar a um serviço: auth → AUTH_SERVICE_URL. */
export function serviceEnvVar(serviceName: string): string {
  return `${serviceName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_SERVICE_URL`;
}

/**
 * Mapa de env de descoberta a injetar em CADA serviço: cada serviço recebe o URL interno
 * de TODOS os outros (menos ele mesmo). Ex.: api recebe AUTH_SERVICE_URL e WEB_SERVICE_URL.
 * Single-service (N=1) → mapa vazio (nada a descobrir).
 */
export function buildDiscoveryEnv(
  deploymentId: string, services: ServicePlan[],
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const self of services) {
    const env: Record<string, string> = {};
    for (const other of services) {
      if (other.name === self.name) continue;
      env[serviceEnvVar(other.name)] = internalUrl(deploymentId, other);
    }
    out[self.name] = env;
  }
  return out;
}
