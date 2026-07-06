/**
 * DM-T9: modo demo — DB sidecar efêmero (sem RDS, sem RunTask de migrate separada).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── ECS mock (captura task-defs + comandos) ──────────────────────────────────
const ecsSent: Array<{ name: string; input: Record<string, unknown> }> = [];
const ecsSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  ecsSent.push({ name, input: cmd.input });
  if (name === "RegisterTaskDefinitionCommand") return { taskDefinition: { taskDefinitionArn: "arn:td:1" } };
  if (name === "RunTaskCommand") return { tasks: [{ taskArn: "arn:task" }], failures: [] };
  if (name === "DescribeTasksCommand") return { tasks: [{ lastStatus: "STOPPED", containers: [{ name: "app-x", exitCode: 0 }] }] };
  return {};
});
vi.mock("@aws-sdk/client-ecs", async (o) => {
  const actual = await o<typeof import("@aws-sdk/client-ecs")>();
  return { ...actual, ECSClient: class { send = (c: unknown) => ecsSend(c as never); } };
});
// RDS/Secrets: se forem chamados em demo, o teste falha (não devem ser).
const rdsSend = vi.fn(async () => { throw new Error("RDS não deve ser chamado em demo"); });
vi.mock("@aws-sdk/client-rds", async (o) => {
  const actual = await o<typeof import("@aws-sdk/client-rds")>();
  return { ...actual, RDSClient: class { send = (c: unknown) => rdsSend(); } };
});
vi.mock("@aws-sdk/client-secrets-manager", async (o) => {
  const actual = await o<typeof import("@aws-sdk/client-secrets-manager")>();
  return { ...actual, SecretsManagerClient: class { send = async () => { throw new Error("Secrets não deve ser chamado em demo"); }; } };
});

const ledger = vi.fn((..._a: unknown[]) => Promise.resolve("led"));
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => ledger(), markResourceCreated: () => Promise.resolve(),
  markResourceFailed: () => Promise.resolve(), findCreatedResource: () => Promise.resolve(null),
  patchDeployment: () => Promise.resolve(),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

import { rdsDriver } from "./rds.js";
import { migratingDriver } from "./migrating.js";
import { registerTaskDef } from "./taskDef.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(klass: "durable" | "demo"): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "p", tenantId: "t", runtimeTarget: "ecs_fargate",
    klass, ecrRepoUri: "acct/repo", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: { subnetIds: ["s-a", "s-b"], taskSecurityGroupId: "sg", assignPublicIp: "ENABLED",
      containerPort: 3004, executionRoleArn: "arn:exec", taskRoleArn: "arn:task",
      appSecretArn: "arn:sec", appSecretKeys: ["DATABASE_URL"] },
  };
}

beforeEach(() => { ecsSent.length = 0; ecsSend.mockClear(); rdsSend.mockClear(); ledger.mockClear(); });

describe("rdsDriver — demo", () => {
  it("NÃO chama RDS/Secrets; seta DATABASE_URL localhost + demoDbName", async () => {
    const c = ctx("demo");
    await rdsDriver.provision(c);
    expect(rdsSend).not.toHaveBeenCalled();
    expect(c.scratch.databaseUrl).toBe("postgresql://genesis:demo@localhost:5432/appdb");
    expect(c.scratch.demoDbName).toBe("appdb");
  });
});

describe("migratingDriver — demo", () => {
  it("cria cluster mas NÃO dispara RunTask de migrate (migra no start do app)", async () => {
    await migratingDriver.provision(ctx("demo"));
    expect(ecsSent.some((s) => s.name === "CreateClusterCommand")).toBe(true);
    expect(ecsSent.some((s) => s.name === "RunTaskCommand")).toBe(false);
  });
});

describe("registerTaskDef — withDbSidecar (demo)", () => {
  it("task-def tem 2 containers: app + postgres sidecar com healthcheck", async () => {
    const { ECSClient } = await import("@aws-sdk/client-ecs");
    const ecs = new ECSClient({});
    await registerTaskDef(ecs, ctx("demo"), { family: "genesis-svc", withDbSidecar: { version: "16", database: "appdb" } });
    const reg = ecsSent.find((s) => s.name === "RegisterTaskDefinitionCommand")!;
    const cdefs = reg.input.containerDefinitions as Array<{ name: string; image?: string; healthCheck?: unknown; environment?: Array<{ name: string; value: string }> }>;
    expect(cdefs).toHaveLength(2);
    const db = cdefs.find((c) => c.name === "db")!;
    expect(db.image).toBe("postgres:16-alpine");
    expect(db.healthCheck).toBeDefined();
    const app = cdefs.find((c) => c.name !== "db")!;
    expect(app.environment?.find((e) => e.name === "DATABASE_URL")?.value).toContain("@localhost:5432/appdb");
  });

  it("G-A: DATABASE_URL NÃO aparece em secrets quando há sidecar (evita ECS 'specified twice')", async () => {
    const { ECSClient } = await import("@aws-sdk/client-ecs");
    const ecs = new ECSClient({});
    await registerTaskDef(ecs, ctx("demo"), { family: "genesis-svc", withDbSidecar: { version: "16", database: "appdb" } });
    const reg = ecsSent.find((s) => s.name === "RegisterTaskDefinitionCommand")!;
    const cdefs = reg.input.containerDefinitions as Array<{ name: string; secrets?: Array<{ name: string }>; environment?: Array<{ name: string }> }>;
    const app = cdefs.find((c) => c.name !== "db")!;
    const secretNames = (app.secrets ?? []).map((s) => s.name);
    const envNames = (app.environment ?? []).map((e) => e.name);
    // DATABASE_URL só no environment (sidecar), nunca nos secrets → sem colisão.
    expect(secretNames).not.toContain("DATABASE_URL");
    expect(envNames).toContain("DATABASE_URL");
  });

  it("produção (sem sidecar) → 1 container só (app)", async () => {
    const { ECSClient } = await import("@aws-sdk/client-ecs");
    const ecs = new ECSClient({});
    await registerTaskDef(ecs, ctx("durable"), { family: "genesis-svc" });
    const reg = ecsSent.find((s) => s.name === "RegisterTaskDefinitionCommand")!;
    expect((reg.input.containerDefinitions as unknown[]).length).toBe(1);
  });
});
