/**
 * DM-T3: IR do plano de provisionamento — fonte única (drivers + renderers).
 */
import { describe, it, expect } from "vitest";
import { buildProvisionPlan, resolveDbResolution } from "./provisionPlanIR.js";
import type { Topology, ServicePlan } from "./tenantProvisioner.js";

function svc(name: string, role: ServicePlan["role"], routePrefix: string, port = 3004): ServicePlan {
  return { name, dir: `/apps/${name}`, runtime: "fastify", role, port, healthPath: "/health",
    ecrRepoName: `genesis/p/${name}`, routePrefix };
}
const single: Topology = { multiService: false, services: [svc("app", "api", "/api")], rootServiceName: "app" };
const multi: Topology = {
  multiService: true,
  services: [svc("api", "api", "/api"), svc("auth", "api", "/api/auth"), svc("web", "web", "/", 3000)],
  rootServiceName: "web",
};

describe("resolveDbResolution", () => {
  it("auto + produção + tem db → RDS", () => {
    expect(resolveDbResolution("auto", "production", ["appdb"]).kind).toBe("rds");
  });
  it("auto + demo + tem db → sidecar", () => {
    expect(resolveDbResolution("auto", "demo", ["appdb"]).kind).toBe("sidecar");
  });
  it("auto + source_only + tem db → sidecar (barato)", () => {
    expect(resolveDbResolution("auto", "source_only", ["appdb"]).kind).toBe("sidecar");
  });
  it("auto sem db → none", () => {
    expect(resolveDbResolution("auto", "production", []).kind).toBe("none");
  });
  it("rds explícito respeitado; external e none também", () => {
    expect(resolveDbResolution("rds", "demo", ["x"]).kind).toBe("rds");
    expect(resolveDbResolution("external", "production", ["x"]).kind).toBe("external");
    expect(resolveDbResolution("none", "production", ["x"]).kind).toBe("none");
  });
});

describe("buildProvisionPlan", () => {
  const base = {
    projectId: "p", deliveryMode: "production" as const, runtimeTarget: "ecs_fargate" as const,
    dbMode: "auto" as const, domainMode: "zentriz_subdomain" as const,
  };

  it("single-service: 1 serviço, isRoot true, RDS em produção", () => {
    const plan = buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } });
    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].isRoot).toBe(true);
    expect(plan.services[0].needsIngress).toBe(true);
    expect(plan.db.kind).toBe("rds");
    expect(plan.externalPorts).toEqual([80, 443]);
  });

  it("multi-serviço: serviços ordenados por especificidade (/api/auth antes de /api antes de /)", () => {
    const plan = buildProvisionPlan({ ...base, topology: multi,
      serviceDatabases: { api: "app_api", auth: "app_auth" } });
    const prefixes = plan.services.map((s) => s.routePrefix);
    expect(prefixes.indexOf("/api/auth")).toBeLessThan(prefixes.indexOf("/api"));
    expect(prefixes[prefixes.length - 1]).toBe("/"); // web catch-all por último
    // web = root, worker-like sem db
    expect(plan.rootServiceName).toBe("web");
    const web = plan.services.find((s) => s.name === "web")!;
    expect(web.isRoot).toBe(true);
    expect(web.databaseName).toBeUndefined();
  });

  it("demo → db sidecar (não RDS)", () => {
    const plan = buildProvisionPlan({ ...base, deliveryMode: "demo", topology: single, serviceDatabases: { app: "appdb" } });
    expect(plan.db.kind).toBe("sidecar");
  });

  it("dbMode=none → sem db, mas serviço ainda tem ingress", () => {
    const plan = buildProvisionPlan({ ...base, dbMode: "none", topology: single, serviceDatabases: {} });
    expect(plan.db.kind).toBe("none");
    expect(plan.externalPorts).toEqual([80, 443]);
  });

  it("domínio custom preserva hostname", () => {
    const plan = buildProvisionPlan({ ...base, topology: single, serviceDatabases: {},
      domainMode: "custom", customHostname: "api.cliente.com" });
    expect(plan.domain).toEqual({ mode: "custom", hostname: "api.cliente.com" });
  });

  it("plano é serializável (JSON puro — consumível por renderers)", () => {
    const plan = buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api" } });
    expect(() => JSON.stringify(plan)).not.toThrow();
    expect(JSON.parse(JSON.stringify(plan)).projectId).toBe("p");
  });
});
