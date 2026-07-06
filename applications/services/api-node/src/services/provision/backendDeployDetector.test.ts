/**
 * G1-T9: backendDeployDetector — elegibilidade backend + resolução de runtime_target.
 * Foco: dispatch NÃO desvia web/estático (zero-regressão do S3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectBackendProject, resolveRuntimeTarget } from "./backendDeployDetector.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "bd-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("detectBackendProject", () => {
  it("Fastify + Dockerfile → elegível", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { fastify: "^4" } }));
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3004\n");
    const r = await detectBackendProject(dir);
    expect(r.eligible).toBe(true);
    expect(r.runtime).toBe("fastify");
    expect(r.port).toBe(3004);
  });

  it("backend SEM Dockerfile → não elegível (NO_DOCKERFILE)", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^4" } }));
    const r = await detectBackendProject(dir);
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("NO_DOCKERFILE");
  });

  it("Next/web → NÃO elegível (segue path S3) — NOT_BACKEND", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:20-alpine\n");
    const r = await detectBackendProject(dir);
    expect(r.eligible).toBe(false);
    expect(r.code).toBe("NOT_BACKEND");
  });
});

describe("resolveRuntimeTarget (dispatch)", () => {
  it("frontend → s3, isBackend false (ZERO regressão)", () => {
    expect(resolveRuntimeTarget("frontend_dashboard", null)).toEqual({ runtimeTarget: "s3", isBackend: false });
    expect(resolveRuntimeTarget("frontend_landing", undefined)).toMatchObject({ isBackend: false, runtimeTarget: "s3" });
  });

  it("backend_api → default ecs_fargate", () => {
    expect(resolveRuntimeTarget("backend_api", null)).toEqual({ runtimeTarget: "ecs_fargate", isBackend: true });
    expect(resolveRuntimeTarget("backend_api_python", null)).toMatchObject({ isBackend: true, runtimeTarget: "ecs_fargate" });
  });

  it("fullstack → backend, default ecs_fargate", () => {
    expect(resolveRuntimeTarget("fullstack_saas", null)).toMatchObject({ isBackend: true, runtimeTarget: "ecs_fargate" });
  });

  it("target explícito válido na spec tem precedência", () => {
    expect(resolveRuntimeTarget("backend_api", "app_runner")).toMatchObject({ runtimeTarget: "app_runner", isBackend: true });
    expect(resolveRuntimeTarget("backend_api", "ec2")).toMatchObject({ runtimeTarget: "ec2" });
  });

  it("runtime_target=s3 para backend → ERRO (evita regressão silenciosa do BUILD_INCOMPATIBLE)", () => {
    const r = resolveRuntimeTarget("backend_api", "s3");
    expect(r.error).toBeTruthy();
  });

  it("tipo desconhecido/null → s3, não-backend (não desvia)", () => {
    expect(resolveRuntimeTarget(null, null)).toEqual({ runtimeTarget: "s3", isBackend: false });
    expect(resolveRuntimeTarget("other", null)).toMatchObject({ isBackend: false });
  });
});
