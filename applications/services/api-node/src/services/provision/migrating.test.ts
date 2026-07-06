/**
 * G1-T16: fase MIGRATING — RunTask one-shot, guarda "já rodou", falha visível, resume.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ecsSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let taskStatus = "STOPPED";
let exitCode: number | null = 0;
const ecsSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  ecsSent.push({ name, input: cmd.input });
  if (name === "CreateClusterCommand") return {};
  if (name === "RegisterTaskDefinitionCommand") return { taskDefinition: { taskDefinitionArn: "arn:td:migrate:1" } };
  if (name === "RunTaskCommand") return { tasks: [{ taskArn: "arn:task:mig" }], failures: [] };
  if (name === "DescribeTasksCommand") {
    return { tasks: [{ lastStatus: taskStatus, stoppedReason: "done",
      containers: [{ name: "app-dep-abcd", exitCode }] }] };
  }
  return {};
});
vi.mock("@aws-sdk/client-ecs", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-ecs")>();
  return { ...actual, ECSClient: class { send = (c: unknown) => ecsSend(c as never); } };
});

const markResourceCreated = vi.fn((..._a: unknown[]) => Promise.resolve());
const markResourceFailed = vi.fn((..._a: unknown[]) => Promise.resolve());
const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
let prior: unknown = null;
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => Promise.resolve("led"),
  markResourceCreated: (...a: unknown[]) => markResourceCreated(...a),
  markResourceFailed: (...a: unknown[]) => markResourceFailed(...a),
  findCreatedResource: () => Promise.resolve(prior),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

import { migratingDriver } from "./migrating.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable",
    ecrRepoUri: "acct.dkr.ecr.us-east-1.amazonaws.com/genesis/p", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: {
      subnetIds: ["subnet-a", "subnet-b"], taskSecurityGroupId: "sg-task",
      assignPublicIp: "ENABLED", containerPort: 3004,
      executionRoleArn: "arn:role:exec", taskRoleArn: "arn:role:task",
      appSecretArn: "arn:sec:app", appSecretKeys: ["DATABASE_URL", "JWT_SECRET"],
    },
  };
}

beforeEach(() => {
  ecsSent.length = 0; ecsSend.mockClear(); markResourceCreated.mockClear();
  markResourceFailed.mockClear(); patchDeployment.mockClear();
  prior = null; taskStatus = "STOPPED"; exitCode = 0;
});

describe("migratingDriver.provision", () => {
  it("cria cluster, registra task-def de migrate e roda RunTask", async () => {
    await migratingDriver.provision(ctx());
    expect(ecsSent.some((s) => s.name === "CreateClusterCommand")).toBe(true);
    const td = ecsSent.find((s) => s.name === "RegisterTaskDefinitionCommand")!;
    // task-def de migrate tem command (não portMappings)
    const cdef = (td.input.containerDefinitions as Array<{ command?: string[] }>)[0];
    expect(cdef.command).toBeDefined();
    expect(ecsSent.some((s) => s.name === "RunTaskCommand")).toBe(true);
  });

  it("persiste migrate_task_arn e marca migrate_run created em exit 0", async () => {
    await migratingDriver.provision(ctx());
    expect(patchDeployment).toHaveBeenCalledWith("dep-abcdef123456", { migrate_task_arn: "arn:task:mig" });
    expect(markResourceCreated).toHaveBeenCalled();
  });

  it("guarda 'já rodou': ledger migrate_run existente → NÃO re-migra", async () => {
    prior = { id: "led", status: "created" };
    await migratingDriver.provision(ctx());
    expect(ecsSent.some((s) => s.name === "RunTaskCommand")).toBe(false);
  });

  it("migração falha (exit≠0) → deploy FAILED (throw), não 500 silencioso", async () => {
    exitCode = 1;
    await expect(migratingDriver.provision(ctx())).rejects.toThrow(/MIGRATE_FAILED/);
    expect(markResourceFailed).toHaveBeenCalled();
  });

  it("RunTask sem taskArn → falha explícita", async () => {
    ecsSend.mockImplementationOnce(async () => ({})); // CreateCluster
    ecsSend.mockImplementationOnce(async () => ({ taskDefinition: { taskDefinitionArn: "arn:td" } })); // Register
    ecsSend.mockImplementationOnce(async () => ({ tasks: [] as unknown[], failures: [{ reason: "CAPACITY" }] } as never)); // RunTask
    await expect(migratingDriver.provision(ctx())).rejects.toThrow(/MIGRATE_RUNTASK_FAILED/);
  });
});
