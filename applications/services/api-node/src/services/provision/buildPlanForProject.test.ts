/**
 * DM-T8b: buildPlanForProject — ponte projeto (extra + apps/) → IR do plano.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let extraRow: Record<string, unknown> | null = {};
const queryMock = vi.fn(async () => ({ rows: extraRow ? [{ extra: extraRow }] : [] }));
vi.mock("../../db/client.js", () => ({ pool: { query: () => queryMock() } }));

import { buildPlanForProject } from "./buildPlanForProject.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bpfp-"));
  process.env.PROJECT_FILES_ROOT = root;
  extraRow = {};
  queryMock.mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); delete process.env.PROJECT_FILES_ROOT; });

async function makeApps(projectId: string, services: Record<string, Record<string, unknown>>) {
  const apps = path.join(root, projectId, "apps");
  const names = Object.keys(services);
  if (names.length === 1 && names[0] === "_root") {
    await mkdir(apps, { recursive: true });
    await writeFile(path.join(apps, "package.json"), JSON.stringify(services._root));
    await writeFile(path.join(apps, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3004\n");
    return;
  }
  for (const [name, pkg] of Object.entries(services)) {
    const d = path.join(apps, name);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(d, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3004\n");
  }
}

describe("buildPlanForProject", () => {
  it("projeto inexistente → NOT_FOUND", async () => {
    extraRow = null;
    const r = await buildPlanForProject("pX");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_FOUND");
  });

  it("frontend source_only → gera kit (web também recebe só-código, sem DB)", async () => {
    extraRow = { project_type: "frontend_dashboard", delivery_mode: "source_only" };
    await makeApps("p1", { _root: { dependencies: { next: "^14" } } });
    const r = await buildPlanForProject("p1");
    expect(r.ok).toBe(true);
    expect(r.plan!.deliveryMode).toBe("source_only");
    expect(r.plan!.db.kind).toBe("none"); // web não tem banco
  });

  it("backend source_only single-service → IR com 1 serviço + db", async () => {
    extraRow = { project_type: "backend_api", delivery_mode: "source_only" };
    await makeApps("p1", { _root: { dependencies: { fastify: "^4" } } });
    const r = await buildPlanForProject("p1");
    expect(r.ok).toBe(true);
    expect(r.plan!.deliveryMode).toBe("source_only");
    expect(r.plan!.services).toHaveLength(1);
    expect(r.plan!.services[0].name).toBe("app");
    // source_only + auto → db sidecar
    expect(r.plan!.db.kind).toBe("sidecar");
  });

  it("fullstack source_only → multi-serviço com rotas ordenadas", async () => {
    extraRow = { project_type: "fullstack_saas", delivery_mode: "source_only" };
    await makeApps("p2", {
      api: { dependencies: { fastify: "^4" } },
      auth: { dependencies: { express: "^4" } },
      web: { dependencies: { next: "^14" } },
    });
    const r = await buildPlanForProject("p2");
    expect(r.ok).toBe(true);
    expect(r.plan!.multiService).toBe(true);
    expect(r.plan!.services.map((s) => s.name).sort()).toEqual(["api", "auth", "web"]);
  });

  it("db_mode=external respeitado no plano", async () => {
    extraRow = { project_type: "backend_api", delivery_mode: "source_only", db_mode: "external" };
    await makeApps("p3", { _root: { dependencies: { fastify: "^4" } } });
    const r = await buildPlanForProject("p3");
    expect(r.ok).toBe(true);
    expect(r.plan!.db.kind).toBe("external");
  });

  it("domínio custom preserva hostname", async () => {
    extraRow = { project_type: "backend_api", delivery_mode: "production",
      domain_mode: "custom", custom_hostname: "api.cliente.com" };
    await makeApps("p4", { _root: { dependencies: { fastify: "^4" } } });
    const r = await buildPlanForProject("p4");
    expect(r.ok).toBe(true);
    expect(r.plan!.domain).toEqual({ mode: "custom", hostname: "api.cliente.com" });
  });
});
