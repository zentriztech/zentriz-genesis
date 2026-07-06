/**
 * DM-T7: renderer GitHub Actions + DEPLOY.md. Sem AWS.
 */
import { describe, it, expect } from "vitest";
import { renderCiBundle } from "./ciRenderer.js";
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
const base = { projectId: "p", deliveryMode: "production" as const, runtimeTarget: "ecs_fargate" as const,
  dbMode: "auto" as const, domainMode: "zentriz_subdomain" as const };

function byPath(plan: ReturnType<typeof buildProvisionPlan>) {
  return Object.fromEntries(renderCiBundle(plan).map((f) => [f.path, f.content]));
}

describe("ciRenderer — workflow", () => {
  it("gera .github/workflows/deploy.yml + DEPLOY.md", () => {
    const paths = renderCiBundle(buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } })).map((f) => f.path);
    expect(paths).toContain(".github/workflows/deploy.yml");
    expect(paths).toContain("DEPLOY.md");
  });

  it("usa OIDC (id-token write) e role secret — sem chave estática", () => {
    const yml = byPath(buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } }))[".github/workflows/deploy.yml"];
    expect(yml).toContain("id-token: write");
    expect(yml).toContain("role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}");
    expect(yml).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
  });

  it("matriz por serviço + build --platform linux/amd64 + push", () => {
    const yml = byPath(buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } }))[".github/workflows/deploy.yml"];
    expect(yml).toContain('name: "api"');
    expect(yml).toContain('name: "auth"');
    expect(yml).toContain('name: "web"');
    expect(yml).toContain("--platform linux/amd64");
    expect(yml).toContain("docker push");
  });

  it("ecs_fargate → passo update-service; outros alvos não", () => {
    const ecs = byPath(buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } }))[".github/workflows/deploy.yml"];
    expect(ecs).toContain("aws ecs update-service");
    const ec2 = byPath(buildProvisionPlan({ ...base, runtimeTarget: "ec2", topology: single, serviceDatabases: { app: "appdb" } }))[".github/workflows/deploy.yml"];
    expect(ec2).not.toContain("aws ecs update-service");
  });
});

describe("ciRenderer — DEPLOY.md", () => {
  it("índice com os 4 caminhos (local/terraform/k8s/CI)", () => {
    const md = byPath(buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } }))["DEPLOY.md"];
    expect(md).toContain("docker compose up");
    expect(md).toContain("terraform apply");
    expect(md).toContain("kubectl apply -k");
    expect(md).toContain(".github/workflows/deploy.yml");
    expect(md).toContain("RDS"); // produção com rds
  });

  it("descreve o banco conforme o plano (sidecar em demo)", () => {
    const md = byPath(buildProvisionPlan({ ...base, deliveryMode: "demo", topology: single, serviceDatabases: { app: "appdb" } }))["DEPLOY.md"];
    expect(md).toContain("sidecar");
  });

  it("lista os serviços do produto", () => {
    const md = byPath(buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } }))["DEPLOY.md"];
    expect(md).toContain("`api`");
    expect(md).toContain("`auth`");
    expect(md).toContain("`web`");
  });
});
