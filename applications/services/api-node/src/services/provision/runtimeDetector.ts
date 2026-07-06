/**
 * runtimeDetector.ts — G1-T7 (Fase B).
 *
 * Detecção de runtime INDEPENDENTE e mais fina que dockerBuilder.detectStack()
 * (que funde Fastify+Express em "express" e ignora Python). Necessária porque:
 * - Fastify ≠ Express: contractSource diferente (Fastify tem printRoutes/scan de
 *   app.register; Express só router scan).
 * - FastAPI (Python) precisa ser reconhecido via pyproject.toml/main.py.
 * - A porta NÃO é sempre 3000: o pipeline Genesis usa convenções (auth≈7100,
 *   api base_port ≥3004). Detectamos EXPOSE do Dockerfile / env PORT / convenção.
 *
 * Retorna um DetectedService consumido pelo dispatch, dockerBuilder e provisioners.
 * NÃO substitui detectStack (que segue servindo o path S3/legado) — é aditivo.
 */

import { readFile } from "fs/promises";
import path from "path";

export type Runtime = "fastify" | "express" | "nestjs" | "fastapi" | "unknown";

/** Fonte-de-verdade das rotas p/ derivar OpenAPI (G1-T8 consome). */
export type ContractSource =
  | { kind: "fastapi_openapi"; url: string }   // FastAPI serve /openapi.json
  | { kind: "nest_swagger"; url: string }      // Nest @nestjs/swagger /api-json
  | { kind: "fastify_scan" }                    // scan estático de app.register/route
  | { kind: "express_scan" }                    // scan do router
  | { kind: "none" };

export interface DetectedService {
  runtime: Runtime;
  /** Porta em que o serviço escuta dentro do container. */
  port: number;
  /** Rota de health-check (default /health). */
  healthPath: string;
  /** Como derivar o contrato OpenAPI para este runtime. */
  contractSource: ContractSource;
  /** Papel do serviço no produto (api exige contrato; web/worker não). */
  role: "api" | "web" | "worker";
  /** Diretório escaneado (para multi-serviço). */
  dir: string;
}

const DEFAULT_HEALTH = "/health";

async function readJsonSafe(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Detecta a porta real do serviço, na ordem de confiança:
 * 1. EXPOSE do Dockerfile (o mais autoritativo — é o que a task ECS vai mapear).
 * 2. env PORT declarada em .env / .env.example.
 * 3. Convenção do pipeline por papel: auth ≈ 7100; api ≥ 3004.
 * NUNCA assume 3000 cegamente (era o bug do detectStack legado).
 */
async function detectPort(dir: string, runtime: Runtime, role: DetectedService["role"]): Promise<number> {
  // 1. Dockerfile EXPOSE
  const dockerfile = await readTextSafe(path.join(dir, "Dockerfile"));
  if (dockerfile) {
    const m = dockerfile.match(/^\s*EXPOSE\s+(\d{2,5})/im);
    if (m) return parseInt(m[1], 10);
  }
  // 2. env PORT
  for (const f of [".env", ".env.example"]) {
    const env = await readTextSafe(path.join(dir, f));
    if (env) {
      const m = env.match(/^\s*PORT\s*=\s*(\d{2,5})/im);
      if (m) return parseInt(m[1], 10);
    }
  }
  // 3. Convenção do pipeline
  if (runtime === "fastapi") return 8000;         // uvicorn default do molde Python
  if (role === "web") return 3000;                // frontend Next SSR
  return 3004;                                     // api Node — base_port do pipeline (≥3004)
}

function contractFor(runtime: Runtime): ContractSource {
  switch (runtime) {
    case "fastapi": return { kind: "fastapi_openapi", url: "/openapi.json" };
    case "nestjs":  return { kind: "nest_swagger", url: "/api-json" };
    case "fastify": return { kind: "fastify_scan" };
    case "express": return { kind: "express_scan" };
    default:        return { kind: "none" };
  }
}

/**
 * Detecta o runtime de UM diretório de serviço (contém package.json ou pyproject.toml).
 */
export async function detectRuntime(dir: string): Promise<DetectedService> {
  // ── Node (package.json) ──────────────────────────────────────────────────
  const pkg = await readJsonSafe(path.join(dir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown>;
    let runtime: Runtime = "unknown";
    let role: DetectedService["role"] = "api";
    if (deps["@nestjs/core"]) runtime = "nestjs";
    else if (deps["fastify"]) runtime = "fastify";
    else if (deps["express"]) runtime = "express";
    else if (deps["next"]) { runtime = "unknown"; role = "web"; } // Next não é backend API → path S3/SSR trata
    const port = await detectPort(dir, runtime, role);
    return { runtime, port, healthPath: DEFAULT_HEALTH, contractSource: contractFor(runtime), role, dir };
  }

  // ── Python (pyproject.toml / main.py) ────────────────────────────────────
  const pyproject = await readTextSafe(path.join(dir, "pyproject.toml"));
  const mainPy = await readTextSafe(path.join(dir, "main.py"));
  const hay = `${pyproject ?? ""}\n${mainPy ?? ""}`.toLowerCase();
  if (pyproject || mainPy) {
    const runtime: Runtime = hay.includes("fastapi") ? "fastapi" : "unknown";
    const port = await detectPort(dir, runtime, "api");
    return { runtime, port, healthPath: DEFAULT_HEALTH, contractSource: contractFor(runtime), role: "api", dir };
  }

  // ── Nada reconhecido ─────────────────────────────────────────────────────
  return { runtime: "unknown", port: await detectPort(dir, "unknown", "api"), healthPath: DEFAULT_HEALTH, contractSource: { kind: "none" }, role: "api", dir };
}
