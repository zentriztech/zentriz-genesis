/**
 * serviceRole.ts — G1-T8 (Fase B).
 *
 * Classifica o papel de um serviço detectado e decide se ele exige CONTRATO rígido.
 * Só serviços "api" precisam emitir/validar OpenAPI; "web" (frontend) e "worker"
 * (processos sem HTTP público) não passam pelo gate de contrato — evita
 * CONTRACT_DERIVATION_FAILED em serviço que legitimamente não expõe API.
 */

import type { DetectedService } from "./runtimeDetector.js";

export type ServiceRole = "api" | "web" | "worker";

/**
 * Decide o papel final. Parte do role heurístico do runtimeDetector e refina:
 * - runtimes HTTP de API (fastify/express/nestjs/fastapi) → 'api'
 * - Next / role web → 'web'
 * - unknown sem HTTP → 'worker' (não bloqueia por contrato)
 */
export function classifyServiceRole(svc: DetectedService): ServiceRole {
  if (svc.role === "web") return "web";
  if (svc.runtime === "fastify" || svc.runtime === "express" || svc.runtime === "nestjs" || svc.runtime === "fastapi") {
    return "api";
  }
  // unknown e não-web → tratamos como worker (sem gate de contrato).
  return svc.role === "worker" ? "worker" : "worker";
}

/** Só 'api' exige contrato rígido (OpenAPI + verificação rota↔contrato). */
export function requiresContract(role: ServiceRole): boolean {
  return role === "api";
}
