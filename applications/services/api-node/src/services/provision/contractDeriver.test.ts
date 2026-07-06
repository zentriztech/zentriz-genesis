/**
 * G1-T8: contractDeriver + serviceRole — OpenAPI derivado do código, sem inventar.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deriveContract } from "./contractDeriver.js";
import { classifyServiceRole, requiresContract } from "./serviceRole.js";
import type { DetectedService } from "./runtimeDetector.js";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "cd-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function svc(partial: Partial<DetectedService>): DetectedService {
  return {
    runtime: "fastify", port: 3004, healthPath: "/health",
    contractSource: { kind: "fastify_scan" }, role: "api", dir,
    ...partial,
  };
}

describe("serviceRole", () => {
  it("api runtimes exigem contrato", () => {
    expect(requiresContract(classifyServiceRole(svc({ runtime: "fastify" })))).toBe(true);
    expect(requiresContract(classifyServiceRole(svc({ runtime: "fastapi" })))).toBe(true);
  });
  it("web NÃO exige contrato", () => {
    expect(classifyServiceRole(svc({ runtime: "unknown", role: "web" }))).toBe("web");
    expect(requiresContract("web")).toBe(false);
  });
});

describe("contractDeriver", () => {
  it("Fastify: deriva OpenAPI do scan estático das rotas", async () => {
    await writeFile(path.join(dir, "routes.ts"),
      "app.get('/api/users', h);\napp.post('/api/users', h);\nfastify.delete('/api/users/:id', h);\n");
    const r = await deriveContract(svc({ contractSource: { kind: "fastify_scan" } }), "cargobox");
    expect(r.ok).toBe(true);
    expect(r.deferred).toBe(false);
    expect(r.routeCount).toBe(3);
    expect(r.openapi!.paths["/api/users"]).toHaveProperty("get");
    expect(r.openapi!.paths["/api/users"]).toHaveProperty("post");
    expect(r.openapi!.paths["/api/users/:id"]).toHaveProperty("delete");
    expect(r.openapi!.paths["/health"]).toBeDefined(); // health sempre no contrato
  });

  it("Express: reconhece router.METHOD e app.route({method,url})", async () => {
    await writeFile(path.join(dir, "app.js"),
      "router.put('/orders/:id', h);\napp.route({ method: 'GET', url: '/orders' });\n");
    const r = await deriveContract(svc({ runtime: "express", contractSource: { kind: "express_scan" } }));
    expect(r.ok).toBe(true);
    expect(r.openapi!.paths["/orders/:id"]).toHaveProperty("put");
    expect(r.openapi!.paths["/orders"]).toHaveProperty("get");
  });

  it("FastAPI/Nest: derivação DEFERRED (introspection viva pós-deploy)", async () => {
    const r = await deriveContract(svc({ runtime: "fastapi", contractSource: { kind: "fastapi_openapi", url: "/openapi.json" } }));
    expect(r.ok).toBe(true);
    expect(r.deferred).toBe(true);
    expect(r.openapi!["x-genesis"]?.deferred).toBe(true);
  });

  it("api Fastify SEM rotas → CONTRACT_DERIVATION_FAILED (não contrato vazio silencioso)", async () => {
    await writeFile(path.join(dir, "index.ts"), "const x = 1; // nenhuma rota\n");
    const r = await deriveContract(svc({ contractSource: { kind: "fastify_scan" } }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONTRACT_DERIVATION_FAILED");
  });

  it("worker/none: sem contrato, mas NÃO é falha", async () => {
    const r = await deriveContract(svc({ runtime: "unknown", role: "worker", contractSource: { kind: "none" } }));
    expect(r.ok).toBe(true);
    expect(r.openapi).toBeNull();
  });

  it("ignora node_modules no scan", async () => {
    await mkdir(path.join(dir, "node_modules", "lib"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "lib", "x.js"), "app.get('/should-not-count', h);\n");
    await writeFile(path.join(dir, "real.ts"), "app.get('/api/real', h);\n");
    const r = await deriveContract(svc({ contractSource: { kind: "fastify_scan" } }));
    expect(r.openapi!.paths["/api/real"]).toBeDefined();
    expect(r.openapi!.paths["/should-not-count"]).toBeUndefined();
  });
});
