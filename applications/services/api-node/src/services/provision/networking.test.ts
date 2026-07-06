/**
 * G1-T14: driver networking — zero-NAT (public+assignPublicIp), ≥2 AZ, cadeia ALB→task.
 * Mocka EC2Client e ledger.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
let subnetsResponse: Array<{ SubnetId: string; AvailabilityZone: string; MapPublicIpOnLaunch: boolean }> = [];

const sendMock = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  sent.push({ name, input: cmd.input });
  if (name === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: "vpc-123" }] };
  if (name === "DescribeSubnetsCommand") return { Subnets: subnetsResponse };
  if (name === "CreateSecurityGroupCommand") {
    return { GroupId: (cmd.input.GroupName as string).includes("alb") ? "sg-alb1" : "sg-task1" };
  }
  if (name === "DescribeSecurityGroupsCommand") return { SecurityGroups: [{ GroupId: "sg-existing" }] };
  return {};
});
vi.mock("@aws-sdk/client-ec2", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-ec2")>();
  return { ...actual, EC2Client: class { send = (c: unknown) => sendMock(c as never); } };
});

const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
let prior: Record<string, { arn: string }> = {};
vi.mock("./backendState.js", () => ({
  recordResourceIntent: (..._a: unknown[]) => Promise.resolve("led-x"),
  markResourceCreated: (..._a: unknown[]) => Promise.resolve(),
  findCreatedResource: (_d: string, rt: string) => Promise.resolve(prior[rt] ?? null),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));

import { networkingDriver } from "./networking.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable", ecrRepoUri: "acct/repo",
    imageTag: "abc", creds: { region: "us-east-1", credentials: undefined },
    scratch: { containerPort: 3004 },
  };
}

beforeEach(() => {
  sent.length = 0; sendMock.mockClear(); patchDeployment.mockClear(); prior = {};
  subnetsResponse = [
    { SubnetId: "subnet-a", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: true },
    { SubnetId: "subnet-b", AvailabilityZone: "us-east-1b", MapPublicIpOnLaunch: true },
  ];
  delete process.env.GENESIS_PROVISION_VPC_ID;
});

describe("networkingDriver.provision", () => {
  it("zero-NAT: assignPublicIp ENABLED e nenhum NAT criado", async () => {
    const c = ctx();
    await networkingDriver.provision(c);
    expect(c.scratch.assignPublicIp).toBe("ENABLED");
    expect(sent.some((s) => /Nat|NatGateway/.test(s.name))).toBe(false);
  });

  it("seleciona 1 subnet por AZ em ≥2 AZ distintas", async () => {
    const c = ctx();
    await networkingDriver.provision(c);
    expect((c.scratch.subnetIds as string[]).length).toBe(2);
    expect((c.scratch.azs as string[])).toEqual(["us-east-1a", "us-east-1b"]);
  });

  it("cadeia ALB→task: ingress da task só do SG do ALB, na porta do container", async () => {
    await networkingDriver.provision(ctx());
    const taskIngress = sent.find((s) =>
      s.name === "AuthorizeSecurityGroupIngressCommand" &&
      JSON.stringify(s.input).includes("UserIdGroupPairs"));
    expect(taskIngress).toBeDefined();
    const perm = (taskIngress!.input.IpPermissions as Array<{ FromPort: number; UserIdGroupPairs: Array<{ GroupId: string }> }>)[0];
    expect(perm.FromPort).toBe(3004);
    expect(perm.UserIdGroupPairs[0].GroupId).toBe("sg-alb1");
  });

  it("persiste vpc/subnets/SGs no deployment", async () => {
    await networkingDriver.provision(ctx());
    expect(patchDeployment).toHaveBeenCalledWith("dep-abcdef123456",
      expect.objectContaining({ vpc_id: "vpc-123", security_group_ids: ["sg-alb1", "sg-task1"] }));
  });

  it("FALHA CEDO se <2 AZ (mensagem clara)", async () => {
    subnetsResponse = [{ SubnetId: "subnet-a", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: true }];
    await expect(networkingDriver.provision(ctx())).rejects.toThrow(/INSUFFICIENT_AZ/);
  });

  it("idempotência: SGs já no ledger não são recriados", async () => {
    prior = { sg_alb: { arn: "sg-alb1" }, sg_task: { arn: "sg-task1" } };
    await networkingDriver.provision(ctx());
    expect(sent.some((s) => s.name === "CreateSecurityGroupCommand")).toBe(false);
  });
});
