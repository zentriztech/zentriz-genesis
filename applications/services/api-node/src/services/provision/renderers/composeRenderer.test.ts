/**
 * DM-T4: renderer Docker Compose — bundle source_only (roda local). Sem AWS.
 */
import { describe, it, expect } from "vitest";
import { renderComposeBundle, renderComposeFile, renderEnvExample } from "./composeRenderer.js";
import { buildProvisionPlan } from "../provisionPlanIR.js";
import type { Topology, ServicePlan } from "../tenantProvisioner.js";

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
const base = { projectId: "p", deliveryMode: "source_only" as const, runtimeTarget: "ecs_fargate" as const,
  dbMode: "auto" as const, domainMode: "zentriz_subdomain" as const };

describe("composeRenderer — single-service", () => {
  const plan = buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } });

  it("gera docker-compose.yml + .env.example + RUN.md", () => {
    const files = renderComposeBundle(plan).map((f) => f.path);
    expect(files).toContain("docker-compose.yml");
    expect(files).toContain(".env.example");
    expect(files).toContain("RUN.md");
  });

  it("compose tem serviço app + db sidecar (postgres) com healthcheck", () => {
    const yml = renderComposeFile(plan);
    expect(yml).toContain("app:");
    expect(yml).toContain("db:");
    expect(yml).toContain("image: postgres:16-alpine");
    expect(yml).toContain("pg_isready");
    expect(yml).toContain('ports:\n      - "3004:3004"');
    expect(yml).toContain("DATABASE_URL=postgresql://genesis:${DB_PASSWORD}@db:5432/appdb");
  });

  it(".env.example tem placeholders (nunca segredo real)", () => {
    const env = renderEnvExample(plan);
    expect(env).toContain("DB_PASSWORD=");
    expect(env).toContain("JWT_SECRET=");
    expect(env).not.toMatch(/postgresql:\/\/genesis:[a-f0-9]{20}/); // sem senha real
  });
});

describe("composeRenderer — multi-serviço", () => {
  const plan = buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } });

  it("3 serviços + db; leste-oeste por nome do compose", () => {
    const yml = renderComposeFile(plan);
    expect(yml).toContain("api:");
    expect(yml).toContain("auth:");
    expect(yml).toContain("web:");
    // api enxerga auth por nome do serviço
    expect(yml).toContain("AUTH_SERVICE_URL=http://auth:3004");
  });

  it("multi-schema → initdb SQL para os databases extras", () => {
    const files = renderComposeBundle(plan);
    const initdb = files.find((f) => f.path.includes("initdb"));
    expect(initdb).toBeDefined();
    expect(initdb!.content).toContain("CREATE DATABASE app_auth");
  });

  it("web (catch-all) não recebe DATABASE_URL", () => {
    const yml = renderComposeFile(plan);
    // bloco do web não tem DATABASE_URL (não é api com schema)
    const webBlock = yml.slice(yml.indexOf("  web:"));
    expect(webBlock).not.toContain("DATABASE_URL");
  });
});

describe("composeRenderer — sem db", () => {
  it("dbMode=none → sem serviço db no compose", () => {
    const plan = buildProvisionPlan({ ...base, dbMode: "none", topology: single, serviceDatabases: {} });
    const yml = renderComposeFile(plan);
    expect(yml).not.toContain("image: postgres");
    expect(yml).not.toContain("DATABASE_URL");
  });
});
