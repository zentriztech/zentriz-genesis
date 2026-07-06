/**
 * DM-T5: renderer Terraform — espelha a infra do provisionamento. Sem AWS.
 */
import { describe, it, expect } from "vitest";
import { renderTerraformBundle } from "./terraformRenderer.js";
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

function bundleText(plan: ReturnType<typeof buildProvisionPlan>) {
  return renderTerraformBundle(plan).map((f) => `### ${f.path}\n${f.content}`).join("\n");
}

describe("terraformRenderer — single-service produção", () => {
  const plan = buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } });
  const all = bundleText(plan);

  it("gera main.tf + variables.tf + tfvars.example", () => {
    const paths = renderTerraformBundle(plan).map((f) => f.path);
    expect(paths).toContain("terraform/main.tf");
    expect(paths).toContain("terraform/variables.tf");
    expect(paths).toContain("terraform/terraform.tfvars.example");
  });

  it("tem ECR, RDS (produção), ECS Fargate, ALB HTTPS+redirect", () => {
    expect(all).toContain("aws_ecr_repository");
    expect(all).toContain("aws_db_instance");
    expect(all).toContain('engine                 = "postgres"');
    expect(all).toContain("aws_ecs_service");
    expect(all).toContain('cpu_architecture        = "X86_64"');
    expect(all).toContain("aws_lb_listener");
    expect(all).toContain('status_code = "HTTP_301"'); // redirect http→https
  });

  it("segredos por variável sensível — nunca embutidos", () => {
    expect(all).toContain("var.db_password");
    expect(all).toContain("var.jwt_secret");
    expect(all).toContain("sensitive = true");
    expect(all).not.toMatch(/password\s*=\s*"[a-f0-9]{16}/); // sem senha real
  });
});

describe("terraformRenderer — multi-serviço", () => {
  const plan = buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } });
  const all = bundleText(plan);

  it("3 repos ECR + regras de path por serviço (auth antes de api)", () => {
    expect((all.match(/aws_ecr_repository/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(all).toContain("aws_lb_listener_rule");
    // auth tem prioridade menor (vem antes) que api
    const authIdx = all.indexOf('values = ["/api/auth/*"]');
    const apiIdx = all.indexOf('values = ["/api/*"]');
    expect(authIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(apiIdx);
  });

  it("web (catch-all) é o default action do listener", () => {
    expect(all).toContain("aws_lb_target_group.web");
  });
});

describe("terraformRenderer — demo (sidecar) e none", () => {
  it("demo → sem RDS no terraform (db é sidecar no compose)", () => {
    const plan = buildProvisionPlan({ ...base, deliveryMode: "demo", topology: single, serviceDatabases: { app: "appdb" } });
    expect(bundleText(plan)).not.toContain("aws_db_instance");
  });
  it("dbMode=none → sem RDS", () => {
    const plan = buildProvisionPlan({ ...base, dbMode: "none", topology: single, serviceDatabases: {} });
    expect(bundleText(plan)).not.toContain("aws_db_instance");
  });
});

describe("terraformRenderer — alvos não-Fargate", () => {
  it("app_runner → README de follow-up (não HCL incorreto)", () => {
    const plan = buildProvisionPlan({ ...base, runtimeTarget: "app_runner", topology: single, serviceDatabases: { app: "appdb" } });
    const files = renderTerraformBundle(plan);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("terraform/README.md");
    expect(files[0].content).toContain("app_runner");
  });
});
