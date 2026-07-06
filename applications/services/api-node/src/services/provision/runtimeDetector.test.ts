/**
 * G1-T7: runtimeDetector — distingue Fastify/Express/Nest/FastAPI + porta real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectRuntime } from "./runtimeDetector.js";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "rt-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function pkg(deps: Record<string, string>) {
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
}

describe("runtimeDetector", () => {
  it("Fastify → runtime fastify + contractSource fastify_scan (NÃO 'express')", async () => {
    await pkg({ fastify: "^4", "drizzle-orm": "^0.3" });
    const r = await detectRuntime(dir);
    expect(r.runtime).toBe("fastify");
    expect(r.contractSource.kind).toBe("fastify_scan");
    expect(r.role).toBe("api");
  });

  it("Express → runtime express + express_scan", async () => {
    await pkg({ express: "^4" });
    const r = await detectRuntime(dir);
    expect(r.runtime).toBe("express");
    expect(r.contractSource.kind).toBe("express_scan");
  });

  it("NestJS → runtime nestjs + nest_swagger /api-json", async () => {
    await pkg({ "@nestjs/core": "^10", "@nestjs/common": "^10" });
    const r = await detectRuntime(dir);
    expect(r.runtime).toBe("nestjs");
    expect(r.contractSource).toMatchObject({ kind: "nest_swagger", url: "/api-json" });
  });

  it("FastAPI (pyproject.toml) → runtime fastapi + /openapi.json + porta 8000", async () => {
    await writeFile(path.join(dir, "pyproject.toml"), "[project]\ndependencies = [\"fastapi\", \"uvicorn\"]\n");
    const r = await detectRuntime(dir);
    expect(r.runtime).toBe("fastapi");
    expect(r.contractSource).toMatchObject({ kind: "fastapi_openapi", url: "/openapi.json" });
    expect(r.port).toBe(8000);
  });

  it("porta vem do EXPOSE do Dockerfile (autoritativo, não 3000)", async () => {
    await pkg({ fastify: "^4" });
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 7100\nCMD [\"node\",\"dist/main\"]\n");
    const r = await detectRuntime(dir);
    expect(r.port).toBe(7100);
  });

  it("porta vem de PORT no .env quando não há EXPOSE", async () => {
    await pkg({ express: "^4" });
    await writeFile(path.join(dir, ".env"), "PORT=3007\nDATABASE_URL=x\n");
    const r = await detectRuntime(dir);
    expect(r.port).toBe(3007);
  });

  it("api Node sem pista de porta cai na convenção do pipeline (3004, não 3000)", async () => {
    await pkg({ fastify: "^4" });
    const r = await detectRuntime(dir);
    expect(r.port).toBe(3004);
  });

  it("Next → role web (não é backend API)", async () => {
    await pkg({ next: "^14", react: "^18" });
    const r = await detectRuntime(dir);
    expect(r.role).toBe("web");
  });

  it("diretório vazio → unknown", async () => {
    const r = await detectRuntime(dir);
    expect(r.runtime).toBe("unknown");
    expect(r.contractSource.kind).toBe("none");
  });
});
