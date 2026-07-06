/**
 * backendDeployDetector.ts — G1-T9 (Fase B).
 *
 * Espelho INVERTIDO do staticDetector: confirma que um projeto é elegível ao
 * provisionamento de BACKEND em container (tem Dockerfile + runtime HTTP detectável
 * + porta), em vez de ser um estático web (que segue no caminho S3 intacto).
 *
 * Usado pelo dispatch em projects.ts: só roteamos para o provisionador de backend
 * quando isto confirma backend/fullstack. Caso contrário, o fluxo S3/web é preservado
 * BYTE-A-BYTE (regra inviolável de zero-regressão).
 */

import { readFile } from "fs/promises";
import path from "path";
import { detectRuntime, type Runtime } from "./runtimeDetector.js";

/** Alvos de compute suportados no GATE 1 (escolhíveis na spec). */
export type RuntimeTarget = "s3" | "ecs_fargate" | "app_runner" | "ec2";

export interface BackendEligibility {
  eligible: boolean;
  runtime: Runtime;
  port: number;
  healthPath: string;
  reasons: string[];
  code?: "NOT_BACKEND" | "NO_DOCKERFILE" | "UNKNOWN_RUNTIME";
}

async function fileExists(p: string): Promise<boolean> {
  try { await readFile(p, "utf-8"); return true; } catch { return false; }
}

/**
 * Decide se `appsDir` é um serviço backend elegível a container.
 * Requer: runtime HTTP reconhecido (fastify/express/nestjs/fastapi) + Dockerfile.
 * (Next/web e diretórios sem runtime → não elegível → seguem o path S3.)
 */
export async function detectBackendProject(appsDir: string): Promise<BackendEligibility> {
  const reasons: string[] = [];
  const svc = await detectRuntime(appsDir);

  const isApiRuntime = svc.runtime === "fastify" || svc.runtime === "express" ||
                       svc.runtime === "nestjs" || svc.runtime === "fastapi";
  if (!isApiRuntime) {
    reasons.push(`Runtime não é backend HTTP (detectado: ${svc.runtime}, role: ${svc.role})`);
    return { eligible: false, runtime: svc.runtime, port: svc.port, healthPath: svc.healthPath, reasons, code: "NOT_BACKEND" };
  }

  const hasDockerfile = await fileExists(path.join(appsDir, "Dockerfile"));
  if (!hasDockerfile) {
    reasons.push("Sem Dockerfile — backend precisa de imagem para provisionar em container");
    return { eligible: false, runtime: svc.runtime, port: svc.port, healthPath: svc.healthPath, reasons, code: "NO_DOCKERFILE" };
  }

  return { eligible: true, runtime: svc.runtime, port: svc.port, healthPath: svc.healthPath, reasons };
}

/**
 * Resolve o runtime_target de um projeto a partir do project_type + extra.
 * Backfill de default: grupo backend/fullstack → 'ecs_fargate'; web/estático → 's3'.
 * Rejeita a combinação inválida runtime_target='s3' para um tipo backend
 * (evita a regressão silenciosa do BUILD_INCOMPATIBLE do staticDetector).
 */
export function resolveRuntimeTarget(
  projectType: string | null | undefined,
  extraTarget: string | null | undefined,
): { runtimeTarget: RuntimeTarget; isBackend: boolean; error?: string } {
  const pt = (projectType ?? "").toLowerCase();
  const isBackend = pt.startsWith("backend") || pt.startsWith("fullstack");

  // Alvo explícito na spec (extra.runtime_target) tem precedência quando válido.
  const explicit = (extraTarget ?? "").toLowerCase().trim();
  const validTargets: RuntimeTarget[] = ["s3", "ecs_fargate", "app_runner", "ec2"];

  if (explicit && (validTargets as string[]).includes(explicit)) {
    if (isBackend && explicit === "s3") {
      return { runtimeTarget: "s3", isBackend, error: "runtime_target='s3' inválido para projeto backend/fullstack" };
    }
    return { runtimeTarget: explicit as RuntimeTarget, isBackend };
  }

  // Backfill de default por grupo.
  return { runtimeTarget: isBackend ? "ecs_fargate" : "s3", isBackend };
}
