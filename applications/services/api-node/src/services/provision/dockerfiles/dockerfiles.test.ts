/**
 * G1-T10: dockerfiles por runtime + prepareEcrBuild.
 * Foco: FastAPI recebe Dockerfile Python (nunca Express); alvo é ECR (nunca Fly);
 * porta vem do runtimeDetector (não hardcoded 3000).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dockerfileForRuntime, WEB_DOCKERFILES } from "./index.js";
import { prepareEcrBuild } from "../../dockerBuilder.js";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

describe("dockerfileForRuntime", () => {
  it("fastapi → Dockerfile Python (uvicorn), NUNCA Express", () => {
    const df = dockerfileForRuntime("fastapi");
    expect(df).toContain("python:");
    expect(df).toContain("uvicorn");
    expect(df).not.toContain("node:");
  });

  it("fastify e express → Node API (npm start), sem fundir com Next", () => {
    expect(dockerfileForRuntime("fastify")).toContain("node:20-alpine");
    expect(dockerfileForRuntime("express")).toContain("node:20-alpine");
    expect(dockerfileForRuntime("fastify")).not.toContain("uvicorn");
  });

  it("nestjs → multi-stage dist/main", () => {
    expect(dockerfileForRuntime("nestjs")).toContain("dist/main");
  });

  it("unknown → fallback Node (não quebra)", () => {
    expect(dockerfileForRuntime("unknown")).toContain("node:");
  });

  it("templates web continuam disponíveis p/ path Fly legado", () => {
    expect(WEB_DOCKERFILES.nextjsStatic).toContain("nginx");
    expect(WEB_DOCKERFILES.nextjsSsr).toContain("server.js");
  });
});

describe("prepareEcrBuild", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "ecr-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("Fastify: imagem aponta p/ ECR, porta real, Dockerfile injetado", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { fastify: "^4" } }));
    await writeFile(path.join(dir, "index.ts"), "app.get('/health', h);\n");
    const uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/genesis-proj";
    const plan = await prepareEcrBuild(dir, uri, "abc12345");
    expect(plan.runtime).toBe("fastify");
    expect(plan.imageUri).toBe(`${uri}:abc12345`);
    expect(plan.buildCmd).toContain("--platform linux/amd64");
    expect(plan.buildCmd).not.toContain("registry.fly.io");
    expect(plan.pushCmd).not.toContain("registry.fly.io");
    expect(plan.dockerfileInjected).toBe(true);
  });

  it("FastAPI: injeta Dockerfile Python (não Express) e porta 8000", async () => {
    await writeFile(path.join(dir, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
    await writeFile(path.join(dir, "requirements.txt"), "fastapi\nuvicorn\n");
    const plan = await prepareEcrBuild(dir, "acct.dkr.ecr.us-east-1.amazonaws.com/py", "sha");
    expect(plan.runtime).toBe("fastapi");
    expect(plan.port).toBe(8000);
    const { readFile } = await import("fs/promises");
    const df = await readFile(path.join(dir, "Dockerfile"), "utf-8");
    expect(df).toContain("uvicorn");
    expect(df).not.toContain("npm start");
  });

  it("Dockerfile do pipeline tem precedência (não sobrescreve)", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^4" } }));
    await writeFile(path.join(dir, "index.ts"), "app.get('/health', h);\n");
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:20\n# CUSTOM PIPELINE\nEXPOSE 4000\n");
    const plan = await prepareEcrBuild(dir, "acct.dkr.ecr.us-east-1.amazonaws.com/x");
    expect(plan.dockerfileInjected).toBe(false);
    expect(plan.port).toBe(4000); // EXPOSE do Dockerfile do pipeline
    const { readFile } = await import("fs/promises");
    expect(await readFile(path.join(dir, "Dockerfile"), "utf-8")).toContain("CUSTOM PIPELINE");
  });

  it("diretório inexistente → erro claro", async () => {
    await expect(prepareEcrBuild(path.join(dir, "nope"), "acct/repo")).rejects.toThrow(/not found/);
  });
});
