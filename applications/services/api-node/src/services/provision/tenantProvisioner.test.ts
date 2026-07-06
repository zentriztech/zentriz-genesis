/**
 * G1-T24: resolveTopology — single-service (N=1) idêntico; multi-serviço detecta apps/*.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTopology, orderByRouteSpecificity } from "./tenantProvisioner.js";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "topo-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function svcDir(p: string, pkg: Record<string, unknown>, dockerfile = true) {
  await mkdir(p, { recursive: true });
  await writeFile(path.join(p, "package.json"), JSON.stringify(pkg));
  if (dockerfile) await writeFile(path.join(p, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3004\n");
}

describe("resolveTopology — single-service (N=1)", () => {
  it("apps/ com package.json na raiz → single-service, 1 serviço 'app'", async () => {
    const apps = path.join(root, "apps");
    await svcDir(apps, { dependencies: { fastify: "^4" } });
    const t = await resolveTopology(apps, "proj-1");
    expect(t.multiService).toBe(false);
    expect(t.services).toHaveLength(1);
    expect(t.services[0].name).toBe("app");
    expect(t.services[0].ecrRepoName).toBe("genesis/proj-1/app");
    expect(t.rootServiceName).toBe("app");
  });
});

describe("resolveTopology — multi-serviço", () => {
  it("apps/{api,web,auth} → 3 serviços com repos ECR distintos", async () => {
    const apps = path.join(root, "apps");
    await mkdir(apps, { recursive: true });
    await svcDir(path.join(apps, "api"), { dependencies: { fastify: "^4" } });
    await svcDir(path.join(apps, "auth"), { dependencies: { express: "^4" } });
    await svcDir(path.join(apps, "web"), { dependencies: { next: "^14" } });
    const t = await resolveTopology(apps, "proj-1");
    expect(t.multiService).toBe(true);
    expect(t.services.map((s) => s.name).sort()).toEqual(["api", "auth", "web"]);
    const repos = t.services.map((s) => s.ecrRepoName);
    expect(new Set(repos).size).toBe(3); // distintos
    expect(repos).toContain("genesis/proj-1/api");
  });

  it("root = serviço web (catch-all)", async () => {
    const apps = path.join(root, "apps");
    await mkdir(apps, { recursive: true });
    await svcDir(path.join(apps, "api"), { dependencies: { fastify: "^4" } });
    await svcDir(path.join(apps, "web"), { dependencies: { next: "^14" } });
    const t = await resolveTopology(apps, "proj-1");
    expect(t.rootServiceName).toBe("web");
    const web = t.services.find((s) => s.name === "web")!;
    expect(web.role).toBe("web");
    expect(web.routePrefix).toBe("/");
  });

  it("auth recebe prefixo mais específico /api/auth", async () => {
    const apps = path.join(root, "apps");
    await mkdir(apps, { recursive: true });
    await svcDir(path.join(apps, "api"), { dependencies: { fastify: "^4" } });
    await svcDir(path.join(apps, "auth"), { dependencies: { fastify: "^4" } });
    const t = await resolveTopology(apps, "proj-1");
    const auth = t.services.find((s) => s.name === "auth")!;
    expect(auth.routePrefix).toBe("/api/auth");
  });

  it("ignora node_modules e afins", async () => {
    const apps = path.join(root, "apps");
    await mkdir(apps, { recursive: true });
    await svcDir(path.join(apps, "api"), { dependencies: { fastify: "^4" } });
    await mkdir(path.join(apps, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(apps, "node_modules", "x", "package.json"), "{}");
    const t = await resolveTopology(apps, "proj-1");
    expect(t.services.map((s) => s.name)).toEqual(["api"]);
  });
});

describe("orderByRouteSpecificity", () => {
  it("/api/auth antes de /api antes de / (catch-all por último)", async () => {
    const apps = path.join(root, "apps");
    await mkdir(apps, { recursive: true });
    await svcDir(path.join(apps, "api"), { dependencies: { fastify: "^4" } });
    await svcDir(path.join(apps, "auth"), { dependencies: { fastify: "^4" } });
    await svcDir(path.join(apps, "web"), { dependencies: { next: "^14" } });
    const t = await resolveTopology(apps, "proj-1");
    const ordered = orderByRouteSpecificity(t.services).map((s) => s.routePrefix);
    expect(ordered.indexOf("/api/auth")).toBeLessThan(ordered.indexOf("/api"));
    expect(ordered[ordered.length - 1]).toBe("/"); // web catch-all por último
  });
});
