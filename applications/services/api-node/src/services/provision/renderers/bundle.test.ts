/**
 * DM-T8: bundle source_only — junta os 4 renderers sem colisão de path.
 */
import { describe, it, expect } from "vitest";
import { renderSourceOnlyBundle, bundleManifest } from "./bundle.js";
import { buildProvisionPlan } from "../provisionPlanIR.js";
import type { Topology, ServicePlan } from "../tenantProvisioner.js";

function svc(name: string, role: ServicePlan["role"], routePrefix: string, port = 3004): ServicePlan {
  return { name, dir: `/apps/${name}`, runtime: "fastify", role, port, healthPath: "/health",
    ecrRepoName: `genesis/p/${name}`, routePrefix };
}
const multi: Topology = {
  multiService: true,
  services: [svc("api", "api", "/api"), svc("auth", "api", "/api/auth"), svc("web", "web", "/", 3000)],
  rootServiceName: "web",
};
const base = { projectId: "p", deliveryMode: "production" as const, runtimeTarget: "ecs_fargate" as const,
  dbMode: "auto" as const, domainMode: "zentriz_subdomain" as const };

describe("renderSourceOnlyBundle", () => {
  const plan = buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } });
  const files = renderSourceOnlyBundle(plan);
  const paths = files.map((f) => f.path);

  it("inclui os 4 formatos + índices", () => {
    expect(paths).toContain("docker-compose.yml");
    expect(paths).toContain("terraform/main.tf");
    expect(paths).toContain("k8s/kustomization.yaml");
    expect(paths).toContain(".github/workflows/deploy.yml");
    expect(paths).toContain("DEPLOY.md");
    expect(paths).toContain("deploy/README.md");
  });

  it("nenhum path duplicado (renderers não colidem)", () => {
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("todos os arquivos têm conteúdo não-vazio", () => {
    for (const f of files) expect(f.content.length).toBeGreaterThan(0);
  });

  it("manifesto reporta path + bytes", () => {
    const man = bundleManifest(files);
    expect(man.length).toBe(files.length);
    expect(man[0]).toHaveProperty("bytes");
    expect(man.every((m) => m.bytes > 0)).toBe(true);
  });

  it("single-service também monta bundle coeso", () => {
    const single: Topology = { multiService: false, services: [svc("app", "api", "/api")], rootServiceName: "app" };
    const p = buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } });
    const f = renderSourceOnlyBundle(p).map((x) => x.path);
    expect(f).toContain("docker-compose.yml");
    expect(f).toContain("terraform/main.tf");
    expect(new Set(f).size).toBe(f.length);
  });

  it("alvo ec2: terraform vira README follow-up, bundle segue sem colisão", () => {
    const p = buildProvisionPlan({ ...base, runtimeTarget: "ec2", topology: multi, serviceDatabases: { api: "app_api" } });
    const f = renderSourceOnlyBundle(p).map((x) => x.path);
    expect(f).toContain("terraform/README.md");
    expect(new Set(f).size).toBe(f.length);
  });
});
