/**
 * DM-T6: renderer Kubernetes (Kustomize). Sem cluster, sem AWS.
 */
import { describe, it, expect } from "vitest";
import { renderK8sBundle } from "./k8sRenderer.js";
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

function text(plan: ReturnType<typeof buildProvisionPlan>) {
  return renderK8sBundle(plan).map((f) => `### ${f.path}\n${f.content}`).join("\n");
}

describe("k8sRenderer — single-service", () => {
  const plan = buildProvisionPlan({ ...base, topology: single, serviceDatabases: { app: "appdb" } });

  it("gera deployment + postgres + ingress + kustomization", () => {
    const paths = renderK8sBundle(plan).map((f) => f.path);
    expect(paths).toContain("k8s/app.yaml");
    expect(paths).toContain("k8s/postgres.yaml");
    expect(paths).toContain("k8s/ingress.yaml");
    expect(paths).toContain("k8s/kustomization.yaml");
  });

  it("deployment tem probes no healthPath e porta correta", () => {
    const all = text(plan);
    expect(all).toContain("kind: Deployment");
    expect(all).toContain("readinessProbe");
    expect(all).toContain("path: /health");
    expect(all).toContain("containerPort: 3004");
  });

  it("segredos via secretKeyRef + secretGenerator com placeholder (nunca valor real)", () => {
    const all = text(plan);
    expect(all).toContain("secretKeyRef");
    expect(all).toContain("jwt-secret=CHANGE_ME");
    expect(all).toContain("db-password=CHANGE_ME");
    expect(all).not.toMatch(/db-password=[a-f0-9]{16}/);
  });

  it("postgres é StatefulSet com volume persistente", () => {
    const all = text(plan);
    expect(all).toContain("kind: StatefulSet");
    expect(all).toContain("volumeClaimTemplates");
    expect(all).toContain("postgres:16-alpine");
  });
});

describe("k8sRenderer — multi-serviço", () => {
  const plan = buildProvisionPlan({ ...base, topology: multi, serviceDatabases: { api: "app_api", auth: "app_auth" } });
  const all = text(plan);

  it("ingress: /api/auth antes de /api; web (catch-all) '/' por último", () => {
    const authIdx = all.indexOf("path: /api/auth");
    const apiIdx = all.indexOf("path: /api\n");
    const rootIdx = all.lastIndexOf("path: /\n");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(apiIdx);
    expect(rootIdx).toBeGreaterThan(apiIdx); // catch-all por último
  });

  it("leste-oeste por DNS interno do k8s (<service>:<port>)", () => {
    expect(all).toContain("AUTH_SERVICE_URL");
    expect(all).toContain("http://auth:3004");
  });

  it("web não recebe DATABASE_URL", () => {
    const webBlock = all.slice(all.indexOf("### k8s/web.yaml"), all.indexOf("### k8s/api.yaml") > all.indexOf("### k8s/web.yaml") ? all.indexOf("### k8s/api.yaml") : undefined);
    expect(webBlock).not.toContain("DATABASE_URL");
  });
});

describe("k8sRenderer — db externo e none", () => {
  it("external → Secret database-url, sem postgres StatefulSet", () => {
    const plan = buildProvisionPlan({ ...base, dbMode: "external", topology: single, serviceDatabases: {} });
    const all = text(plan);
    expect(all).toContain("database-url=");
    expect(all).not.toContain("kind: StatefulSet");
  });
  it("none → sem postgres, sem DATABASE_URL", () => {
    const plan = buildProvisionPlan({ ...base, dbMode: "none", topology: single, serviceDatabases: {} });
    const all = text(plan);
    expect(all).not.toContain("kind: StatefulSet");
    expect(all).not.toContain("DATABASE_URL");
  });
});
