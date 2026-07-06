/**
 * dockerBuilder.ts — Packages a generated project's apps/ directory as a Docker image.
 *
 * Two paths:
 *   • buildAndPushImage(...)  — LEGACY Fly.io path (único consumidor: ephemeralDeploy).
 *                               Assinatura preservada byte-a-byte (zero-regressão).
 *   • buildImageForEcr(...)   — G1-T10: alvo ECR + amd64, dirigido pelo runtimeDetector
 *                               (Fastify≠Express≠Nest≠FastAPI). Sem push p/ registry.fly.io.
 *
 * Os Dockerfiles agora vêm de provision/dockerfiles (fonte-de-verdade por runtime):
 * corrige a fusão fastify→express do antigo detectStack e adiciona FastAPI (uvicorn),
 * que jamais pode cair no template Express.
 *
 * Requires: docker CLI available in PATH (api-node container needs Docker socket mounted).
 */

import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, access } from "fs/promises";
import path from "path";
import { detectRuntime, type Runtime } from "./provision/runtimeDetector.js";
import { dockerfileForRuntime, WEB_DOCKERFILES } from "./provision/dockerfiles/index.js";

const execAsync = promisify(exec);

const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();

// ── Stack detection (legacy Fly path — inclui web estático/SSR) ─────────────────

type StackType = "nestjs" | "fastify" | "express" | "fastapi" | "nextjs-static" | "nextjs-ssr" | "unknown";

async function detectStack(appsDir: string): Promise<StackType> {
  // Python primeiro (não tem package.json): FastAPI nunca deve virar Express.
  const svc = await detectRuntime(appsDir);
  if (svc.runtime === "fastapi") return "fastapi";
  try {
    const pkgRaw = await readFile(path.join(appsDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["@nestjs/core"]) return "nestjs";
    if (deps["next"]) {
      // Check next.config for output: 'export'
      try {
        const cfg = await readFile(path.join(appsDir, "next.config.mjs"), "utf-8");
        if (cfg.includes("output") && cfg.includes("export")) return "nextjs-static";
      } catch { /* */ }
      try {
        const cfg = await readFile(path.join(appsDir, "next.config.js"), "utf-8");
        if (cfg.includes("output") && cfg.includes("export")) return "nextjs-static";
      } catch { /* */ }
      return "nextjs-ssr";
    }
    if (deps["fastify"]) return "fastify";
    if (deps["express"]) return "express";
  } catch { /* */ }
  return "unknown";
}

function getDockerfileContent(stack: StackType): string {
  switch (stack) {
    case "nestjs":         return dockerfileForRuntime("nestjs");
    case "fastify":        return dockerfileForRuntime("fastify");
    case "express":        return dockerfileForRuntime("express");
    case "fastapi":        return dockerfileForRuntime("fastapi");
    case "nextjs-static":  return WEB_DOCKERFILES.nextjsStatic;
    case "nextjs-ssr":     return WEB_DOCKERFILES.nextjsSsr;
    default:               return dockerfileForRuntime("unknown");
  }
}

export function getContainerPort(stack: StackType): number {
  if (stack === "nextjs-static") return 80;
  if (stack === "fastapi") return 8000;
  return 3000;
}

// ── Main build function ────────────────────────────────────────────────────────

export interface BuildResult {
  imageTag: string;
  stack: StackType;
  port: number;
}

export async function buildAndPushImage(
  projectId: string,
  flyAppName: string,
): Promise<BuildResult> {
  const appsDir = path.join(PROJECT_FILES_ROOT, projectId, "apps");

  // Ensure apps/ exists
  try { await access(appsDir); } catch {
    throw new Error(`apps/ directory not found for project ${projectId}`);
  }

  const stack = await detectStack(appsDir);
  const imageTag = `registry.fly.io/${flyAppName}:latest`;
  const dockerfilePath = path.join(appsDir, "Dockerfile");

  // Inject Dockerfile if not present
  let dockerfileExists = false;
  try { await access(dockerfilePath); dockerfileExists = true; } catch { /* */ }

  if (!dockerfileExists) {
    await writeFile(dockerfilePath, getDockerfileContent(stack), "utf-8");
  }

  // Build
  const { stderr: buildStderr } = await execAsync(
    `docker buildx build --platform linux/amd64 --tag "${imageTag}" "${appsDir}"`,
    { timeout: 300_000 }, // 5 min max build
  );
  if (buildStderr && buildStderr.includes("ERROR")) {
    throw new Error(`Docker build failed: ${buildStderr.slice(0, 500)}`);
  }

  // Push to Fly registry (requires flyctl auth + fly registry login)
  await execAsync(`docker push "${imageTag}"`, { timeout: 120_000 });

  return { imageTag, stack, port: getContainerPort(stack) };
}

// ── ECR path (G1-T10) ───────────────────────────────────────────────────────────
//
// Alvo ECR + amd64, dirigido pelo runtimeDetector (por serviço, não fundido).
// O build+push REAL do MVP acontece no HOST (backend_deploy_runner.py, G1-T11),
// que tem docker+aws-cli — espelhando o s3_deploy_runner.py. Estas funções são a
// fonte-de-verdade in-container p/ (a) escolher o Dockerfile do runtime e (b) montar
// os comandos de build/push quando o docker socket estiver disponível ao container.

export interface EcrBuildPlan {
  /** Runtime detectado no diretório do serviço. */
  runtime: Runtime;
  /** Porta real em que o serviço escuta (EXPOSE > PORT > convenção). */
  port: number;
  /** Rota de health-check. */
  healthPath: string;
  /** URI completa da imagem no ECR, com tag. */
  imageUri: string;
  /** true = escrevemos um Dockerfile (não havia um gerado pelo pipeline). */
  dockerfileInjected: boolean;
  /** Comando de build (amd64), pronto p/ execução no host que tem docker. */
  buildCmd: string;
  /** Comando de push p/ o ECR. */
  pushCmd: string;
}

/**
 * Prepara (e opcionalmente injeta) o Dockerfile de um serviço e devolve o plano
 * de build/push para o ECR. Não faz push para registry.fly.io. Não assume porta 3000:
 * usa a porta real do runtimeDetector.
 *
 * @param serviceDir  diretório do serviço (single-service: apps/; multi: apps/<svc>).
 * @param ecrRepoUri  URI do repositório ECR (ex.: <acct>.dkr.ecr.<region>.amazonaws.com/<repo>).
 * @param imageTag    tag da imagem (ex.: deployment_id[:8] ou sha). Default "latest".
 */
export async function prepareEcrBuild(
  serviceDir: string,
  ecrRepoUri: string,
  imageTag = "latest",
): Promise<EcrBuildPlan> {
  try { await access(serviceDir); } catch {
    throw new Error(`service directory not found: ${serviceDir}`);
  }

  const svc = await detectRuntime(serviceDir);
  const dockerfilePath = path.join(serviceDir, "Dockerfile");

  // O Dockerfile gerado pelo pipeline tem precedência; só injetamos se ausente.
  let dockerfileExists = false;
  try { await access(dockerfilePath); dockerfileExists = true; } catch { /* */ }
  if (!dockerfileExists) {
    await writeFile(dockerfilePath, dockerfileForRuntime(svc.runtime), "utf-8");
  }

  const imageUri = `${ecrRepoUri.replace(/\/+$/, "")}:${imageTag}`;
  return {
    runtime: svc.runtime,
    port: svc.port,
    healthPath: svc.healthPath,
    imageUri,
    dockerfileInjected: !dockerfileExists,
    buildCmd: `docker buildx build --platform linux/amd64 --tag "${imageUri}" "${serviceDir}"`,
    pushCmd: `docker push "${imageUri}"`,
  };
}

/**
 * Executa o build+push ECR IN-CONTAINER (requer docker socket montado no api-node).
 * No MVP GATE 1 o caminho oficial é o host (G1-T11); esta função existe p/ ambientes
 * onde o container tem docker, e p/ testes. Nunca faz push p/ Fly.
 */
export async function buildAndPushToEcr(
  serviceDir: string,
  ecrRepoUri: string,
  imageTag = "latest",
): Promise<EcrBuildPlan> {
  const plan = await prepareEcrBuild(serviceDir, ecrRepoUri, imageTag);

  const { stderr: buildStderr } = await execAsync(plan.buildCmd, { timeout: 600_000 });
  if (buildStderr && buildStderr.includes("ERROR")) {
    throw new Error(`Docker build failed: ${buildStderr.slice(0, 500)}`);
  }
  await execAsync(plan.pushCmd, { timeout: 300_000 });
  return plan;
}
