/**
 * G1-T26: RDS multi-schema + migrate por serviço — 1 instância, N databases/secrets/locks.
 */
import { describe, it, expect } from "vitest";
import {
  planServiceSchemas, servicesNeedingSchema, createDatabaseStatements,
} from "./multiSchema.js";
import type { ServicePlan } from "./tenantProvisioner.js";

function svc(name: string, role: ServicePlan["role"]): ServicePlan {
  return { name, dir: `/apps/${name}`, runtime: "fastify", role, port: 3004, healthPath: "/health",
    ecrRepoName: `genesis/p/${name}`, routePrefix: role === "web" ? "/" : "/api" };
}
const conn = { host: "db.rds", port: 5432, user: "genesis", password: "pw" };

describe("servicesNeedingSchema", () => {
  it("só serviços api (web/worker não tocam o banco)", () => {
    const list = servicesNeedingSchema([svc("api", "api"), svc("web", "web"), svc("wk", "worker")]);
    expect(list.map((s) => s.name)).toEqual(["api"]);
  });
});

describe("planServiceSchemas — multi-serviço", () => {
  it("api + auth → 2 databases, 2 secrets, 2 advisory locks distintos", () => {
    const plans = planServiceSchemas("dep-abcdef123456", [svc("api", "api"), svc("auth", "api"), svc("web", "web")], conn);
    expect(plans).toHaveLength(2);
    const names = plans.map((p) => p.databaseName);
    expect(names).toContain("app_api");
    expect(names).toContain("app_auth");
    // secrets distintos
    expect(new Set(plans.map((p) => p.secretName)).size).toBe(2);
    // advisory locks distintos (nenhuma migração cruza dono)
    expect(plans[0].advisoryLockKey).not.toBe(plans[1].advisoryLockKey);
    // DATABASE_URL aponta ao database do serviço
    expect(plans.find((p) => p.serviceName === "auth")!.databaseUrl).toContain("/app_auth");
  });

  it("cada serviço tem secret próprio genesis/<id>/svc/<name>", () => {
    const plans = planServiceSchemas("dep-1", [svc("api", "api"), svc("auth", "api")], conn);
    expect(plans.find((p) => p.serviceName === "api")!.secretName).toBe("genesis/dep-1/svc/api");
    expect(plans.find((p) => p.serviceName === "auth")!.secretName).toBe("genesis/dep-1/svc/auth");
  });

  it("advisory lock determinístico (mesmo serviço → mesma key)", () => {
    const a = planServiceSchemas("dep-1", [svc("api", "api"), svc("auth", "api")], conn);
    const b = planServiceSchemas("dep-1", [svc("api", "api"), svc("auth", "api")], conn);
    expect(a[0].advisoryLockKey).toBe(b[0].advisoryLockKey); // re-run idempotente
  });
});

describe("planServiceSchemas — single-service (N=1, alinha com T16)", () => {
  it("1 api → database default 'appdb' + secret genesis/<id>/app (caminho MVP)", () => {
    const plans = planServiceSchemas("dep-1", [svc("app", "api")], conn);
    expect(plans).toHaveLength(1);
    expect(plans[0].databaseName).toBe("appdb");
    expect(plans[0].secretName).toBe("genesis/dep-1/app");
    expect(plans[0].databaseUrl).toContain("/appdb");
  });
});

describe("createDatabaseStatements", () => {
  it("gera CREATE DATABASE só p/ os não-default (idempotência via ignore no caller)", () => {
    const plans = planServiceSchemas("dep-1", [svc("api", "api"), svc("auth", "api")], conn);
    const stmts = createDatabaseStatements(plans);
    expect(stmts).toContain("CREATE DATABASE app_api");
    expect(stmts).toContain("CREATE DATABASE app_auth");
  });
  it("single-service (appdb default) → nenhum CREATE DATABASE extra", () => {
    const plans = planServiceSchemas("dep-1", [svc("app", "api")], conn);
    expect(createDatabaseStatements(plans)).toEqual([]);
  });
});
