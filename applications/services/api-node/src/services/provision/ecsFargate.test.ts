/**
 * G1-T17: driver ecsFargate — task-def+TG+service, circuit breaker, UpdateService no re-deploy.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ecsSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let serviceExists = false;
const ecsSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  ecsSent.push({ name, input: cmd.input });
  if (name === "RegisterTaskDefinitionCommand") return { taskDefinition: { taskDefinitionArn: "arn:td:svc:1" } };
  if (name === "DescribeServicesCommand") {
    return { services: serviceExists ? [{ serviceArn: "arn:svc:1", status: "ACTIVE" }] : [] };
  }
  if (name === "CreateServiceCommand") return { service: { serviceArn: "arn:svc:new" } };
  if (name === "UpdateServiceCommand") return { service: { serviceArn: "arn:svc:1" } };
  return {};
});
vi.mock("@aws-sdk/client-ecs", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-ecs")>();
  return { ...actual, ECSClient: class { send = (c: unknown) => ecsSend(c as never); } };
});

const elbSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let tgExists = false;
const elbSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  elbSent.push({ name, input: cmd.input });
  if (name === "DescribeTargetGroupsCommand") {
    if (tgExists) return { TargetGroups: [{ TargetGroupArn: "arn:tg:1" }] };
    const e = new Error("nf"); (e as { name: string }).name = "TargetGroupNotFoundException"; throw e;
  }
  if (name === "CreateTargetGroupCommand") return { TargetGroups: [{ TargetGroupArn: "arn:tg:new" }] };
  return {};
});
vi.mock("@aws-sdk/client-elastic-load-balancing-v2", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-elastic-load-balancing-v2")>();
  return { ...actual, ElasticLoadBalancingV2Client: class { send = (c: unknown) => elbSend(c as never); } };
});

const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
let priorTg: { arn: string } | null = null;
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => Promise.resolve("led"),
  markResourceCreated: () => Promise.resolve(),
  findCreatedResource: (_d: string, rt: string) => Promise.resolve(rt === "target_group" ? priorTg : null),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));

import { ecsFargateDriver, ecsServiceDriver } from "./ecsFargate.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable",
    ecrRepoUri: "acct.dkr.ecr.us-east-1.amazonaws.com/genesis/p", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: {
      clusterName: "genesis", vpcId: "vpc-1", subnetIds: ["subnet-a", "subnet-b"],
      taskSecurityGroupId: "sg-task", assignPublicIp: "ENABLED", containerPort: 3004,
      healthPath: "/health", executionRoleArn: "arn:role:exec", taskRoleArn: "arn:role:task",
      appSecretArn: "arn:sec:app", appSecretKeys: ["DATABASE_URL"],
    },
  };
}

beforeEach(() => {
  ecsSent.length = 0; elbSent.length = 0; ecsSend.mockClear(); elbSend.mockClear();
  patchDeployment.mockClear(); serviceExists = false; tgExists = false; priorTg = null;
});

describe("ecsFargateDriver.provision", () => {
  it("cria target group type=ip com health-check no healthPath", async () => {
    await ecsFargateDriver.provision(ctx());
    const tg = elbSent.find((s) => s.name === "CreateTargetGroupCommand")!;
    expect(tg.input.TargetType).toBe("ip");
    expect(tg.input.HealthCheckPath).toBe("/health");
  });

  it("CreateService com circuit breaker + rollback quando não existe (ecs_service, após alb)", async () => {
    const c = ctx();
    // passo A (ecs) já rodou: task-def + TG no scratch. passo B (ecs_service) cria o service.
    c.scratch.taskDefArn = "arn:td:svc:1"; c.scratch.targetGroupArn = "arn:tg:new";
    await ecsServiceDriver.provision(c);
    const create = ecsSent.find((s) => s.name === "CreateServiceCommand")!;
    const cb = (create.input.deploymentConfiguration as { deploymentCircuitBreaker: { enable: boolean; rollback: boolean } }).deploymentCircuitBreaker;
    expect(cb).toEqual({ enable: true, rollback: true });
    expect(c.scratch.serviceArn).toBe("arn:svc:new");
  });

  it("task-def do service tem runtimePlatform X86_64 + portMappings (não command)", async () => {
    await ecsFargateDriver.provision(ctx());
    const td = ecsSent.find((s) => s.name === "RegisterTaskDefinitionCommand")!;
    expect((td.input.runtimePlatform as { cpuArchitecture: string }).cpuArchitecture).toBe("X86_64");
    const cdef = (td.input.containerDefinitions as Array<{ command?: string[]; portMappings?: unknown[] }>)[0];
    expect(cdef.command).toBeUndefined();
    expect(cdef.portMappings).toBeDefined();
  });

  it("2º deploy: service existente → UpdateService --force-new-deployment (não duplica)", async () => {
    serviceExists = true;
    const c = ctx();
    c.scratch.taskDefArn = "arn:td:svc:1"; c.scratch.targetGroupArn = "arn:tg:1";
    await ecsServiceDriver.provision(c);
    expect(ecsSent.some((s) => s.name === "CreateServiceCommand")).toBe(false);
    const upd = ecsSent.find((s) => s.name === "UpdateServiceCommand")!;
    expect(upd.input.forceNewDeployment).toBe(true);
  });

  it("ecs (passo A) persiste task_def_arn/target_group_arn/cluster_arn; ecs_service persiste service_arn", async () => {
    // passo A: task-def + TG
    const cA = ctx();
    await ecsFargateDriver.provision(cA);
    expect(patchDeployment).toHaveBeenCalledWith("dep-abcdef123456",
      expect.objectContaining({ task_def_arn: "arn:td:svc:1", target_group_arn: "arn:tg:new", cluster_arn: "genesis" }));
    expect(cA.scratch.taskDefArn).toBe("arn:td:svc:1");
    expect(cA.scratch.targetGroupArn).toBe("arn:tg:new");
    // passo B: service (lê do scratch populado por A)
    patchDeployment.mockClear();
    await ecsServiceDriver.provision(cA);
    expect(patchDeployment).toHaveBeenCalledWith("dep-abcdef123456",
      expect.objectContaining({ service_arn: "arn:svc:new" }));
  });

  it("ecs_service aborta se taskDefArn/targetGroupArn ausentes no scratch", async () => {
    await expect(ecsServiceDriver.provision(ctx())).rejects.toThrow(/ECS_SERVICE_NO_TASKDEF|ECS_SERVICE_NO_TARGET_GROUP/);
  });

  it("idempotência do TG: já no ledger → não recria", async () => {
    priorTg = { arn: "arn:tg:existing" };
    const c = ctx();
    await ecsFargateDriver.provision(c);
    expect(elbSent.some((s) => s.name === "CreateTargetGroupCommand")).toBe(false);
    expect(c.scratch.targetGroupArn).toBe("arn:tg:existing");
  });
});
