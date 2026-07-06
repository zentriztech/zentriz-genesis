/**
 * G1-T25: path-routing por prefixo ordenado + service discovery leste-oeste.
 */
import { describe, it, expect, vi } from "vitest";
import { planPathRules } from "./albRouting.js";
import {
  discoveryNamespace, internalDnsName, internalUrl, serviceEnvVar, buildDiscoveryEnv,
} from "./serviceDiscovery.js";
import type { ServicePlan } from "./tenantProvisioner.js";

function svc(name: string, role: ServicePlan["role"], routePrefix: string, port = 3004): ServicePlan {
  return { name, dir: `/apps/${name}`, runtime: "fastify", role, port, healthPath: "/health",
    ecrRepoName: `genesis/p/${name}`, routePrefix };
}

const api = svc("api", "api", "/api");
const auth = svc("auth", "api", "/api/auth");
const web = svc("web", "web", "/", 3000);

describe("planPathRules", () => {
  it("ordena por especificidade: /api/auth antes de /api; web = catch-all", () => {
    const tgs = { api: "tg-api", auth: "tg-auth", web: "tg-web" };
    const rules = planPathRules([api, auth, web], tgs);
    const nonCatch = rules.filter((r) => !r.isCatchAll);
    // auth (mais específico) tem prioridade menor (avaliado antes) que api
    const authRule = rules.find((r) => r.serviceName === "auth")!;
    const apiRule = rules.find((r) => r.serviceName === "api")!;
    expect(authRule.priority).toBeLessThan(apiRule.priority);
    expect(authRule.pathPattern).toBe("/api/auth/*");
    expect(apiRule.pathPattern).toBe("/api/*");
    // web é catch-all (default action, prioridade alta)
    const webRule = rules.find((r) => r.serviceName === "web")!;
    expect(webRule.isCatchAll).toBe(true);
    expect(nonCatch.length).toBe(2);
  });

  it("serviço sem target group (worker) é ignorado", () => {
    const worker = svc("worker", "worker", "/worker");
    const rules = planPathRules([api, worker], { api: "tg-api" }); // worker sem TG
    expect(rules.map((r) => r.serviceName)).toEqual(["api"]);
  });

  it("single-service: só o serviço, sem colisão de prioridade", () => {
    const rules = planPathRules([svc("app", "api", "/api")], { app: "tg-app" });
    expect(rules).toHaveLength(1);
    expect(rules[0].priority).toBe(10);
  });
});

describe("serviceDiscovery", () => {
  it("namespace e DNS interno determinísticos", () => {
    expect(discoveryNamespace("dep-abcdef123456")).toBe("dep-abcdef12.genesis.local");
    expect(internalDnsName("dep-abcdef123456", "auth")).toBe("auth.dep-abcdef12.genesis.local");
  });

  it("internalUrl usa a porta do serviço", () => {
    expect(internalUrl("dep-abcdef123456", auth)).toBe("http://auth.dep-abcdef12.genesis.local:3004");
  });

  it("serviceEnvVar: auth → AUTH_SERVICE_URL", () => {
    expect(serviceEnvVar("auth")).toBe("AUTH_SERVICE_URL");
    expect(serviceEnvVar("api")).toBe("API_SERVICE_URL");
  });

  it("buildDiscoveryEnv: api recebe AUTH_SERVICE_URL + WEB_SERVICE_URL (não a si mesmo)", () => {
    const env = buildDiscoveryEnv("dep-abcdef123456", [api, auth, web]);
    expect(env.api).toHaveProperty("AUTH_SERVICE_URL");
    expect(env.api).toHaveProperty("WEB_SERVICE_URL");
    expect(env.api).not.toHaveProperty("API_SERVICE_URL"); // não aponta p/ si
    expect(env.api.AUTH_SERVICE_URL).toContain("auth.dep-abcdef12.genesis.local");
  });

  it("single-service (N=1) → mapa de discovery vazio", () => {
    const env = buildDiscoveryEnv("dep-1", [svc("app", "api", "/api")]);
    expect(env.app).toEqual({});
  });
});
