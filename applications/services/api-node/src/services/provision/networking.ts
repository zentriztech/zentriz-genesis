/**
 * networking.ts — G1-T14 (Fase C). Segundo driver: rede do Fargate.
 *
 * Decisão CRAVADA (não assumida) para evitar task presa em PENDING no pull da imagem:
 *   default = subnet PÚBLICA + assignPublicIp=ENABLED → ZERO NAT Gateway.
 * (NAT custa ~US$32/mês/AZ + tráfego; para o GATE 1, IP público na task resolve o
 *  egress ao ECR/logs sem esse custo. O modo privado+NAT fica para uma policy futura.)
 *
 * Descobre VPC + subnets (≥2 AZ) + monta a cadeia de SGs ALB→task na conta Zentriz.
 * Não CRIA VPC/subnets (usa as da conta); CRIA 2 security groups (alb, task) e os
 * registra no ledger para teardown. Falha CEDO com mensagem clara se <2 AZ.
 */

import {
  DescribeVpcsCommand, DescribeSubnetsCommand,
  CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand, DescribeSecurityGroupsCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { ec2Client, withRetry } from "./awsClients.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

/** Porta do container (default 3004; FastAPI 8000) — vem do scratch (ecs) ou default. */
function containerPort(ctx: ProvisionContext): number {
  const p = Number(ctx.scratch.containerPort);
  return Number.isFinite(p) && p > 0 ? p : 3004;
}

/** Escolhe a VPC: GENESIS_PROVISION_VPC_ID se setado, senão a default da conta. */
async function resolveVpcId(client: EC2Client): Promise<string> {
  const pinned = (process.env.GENESIS_PROVISION_VPC_ID ?? "").trim();
  if (pinned) return pinned;
  const out = await client.send(new DescribeVpcsCommand({
    Filters: [{ Name: "isDefault", Values: ["true"] }],
  }));
  const vpc = out.Vpcs?.[0]?.VpcId;
  if (!vpc) throw new Error("NETWORKING_NO_VPC: nenhuma VPC default na conta; setar GENESIS_PROVISION_VPC_ID");
  return vpc;
}

/** Subnets públicas em ≥2 AZ distintas. Falha cedo se não houver. */
async function resolvePublicSubnets(client: EC2Client, vpcId: string): Promise<{ subnetIds: string[]; azs: string[] }> {
  const out = await client.send(new DescribeSubnetsCommand({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }],
  }));
  const subnets = (out.Subnets ?? []).filter((s) => s.MapPublicIpOnLaunch !== false);
  // 1 subnet por AZ (2 AZ mínimo — ALB exige, e evita indisponibilidade de zona).
  const byAz = new Map<string, string>();
  for (const s of subnets) {
    if (s.AvailabilityZone && s.SubnetId && !byAz.has(s.AvailabilityZone)) {
      byAz.set(s.AvailabilityZone, s.SubnetId);
    }
  }
  if (byAz.size < 2) {
    throw new Error(
      `NETWORKING_INSUFFICIENT_AZ: encontrei ${byAz.size} subnet(s) pública(s) em AZ distintas na VPC ${vpcId}; ` +
      `ECS Fargate + ALB exigem ≥2 AZ. Configure subnets públicas em 2+ zonas ou GENESIS_PROVISION_VPC_ID.`,
    );
  }
  const azs = [...byAz.keys()];
  return { subnetIds: [...byAz.values()], azs };
}

async function ensureSecurityGroup(
  client: EC2Client, ctx: ProvisionContext, vpcId: string,
  suffix: string, description: string, resourceType: string,
): Promise<string> {
  const prior = await findCreatedResource(ctx.deploymentId, resourceType);
  if (prior?.arn) return prior.arn; // arn field guarda o group-id
  const name = `genesis-${suffix}-${ctx.deploymentId.slice(0, 12)}`;
  const ledgerId = await recordResourceIntent(ctx.deploymentId, resourceType, name, ctx.creds.region, { vpcId });
  let gid: string;
  try {
    const out = await client.send(new CreateSecurityGroupCommand({
      GroupName: name, Description: description, VpcId: vpcId,
      TagSpecifications: [{
        ResourceType: "security-group",
        Tags: [
          { Key: "zentriz:product", Value: "genesis" },
          { Key: "zentriz:deployment_id", Value: ctx.deploymentId },
        ],
      }],
    }));
    gid = out.GroupId!;
  } catch (err) {
    if ((err as { name?: string })?.name === "InvalidGroup.Duplicate") {
      const got = await client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [name] }, { Name: "vpc-id", Values: [vpcId] }],
      }));
      gid = got.SecurityGroups?.[0]?.GroupId ?? "";
      if (!gid) throw err;
    } else {
      throw err;
    }
  }
  await markResourceCreated(ledgerId, gid, { name, vpcId });
  return gid;
}

export const networkingDriver: ProvisionDriver = {
  key: "networking",
  status: "provisioning",

  async provision(ctx: ProvisionContext): Promise<void> {
    const client = ec2Client(ctx.creds);
    const vpcId = await resolveVpcId(client);
    const { subnetIds, azs } = await resolvePublicSubnets(client, vpcId);

    // SG do ALB: ingress 80/443 do mundo. SG da task: ingress só do SG do ALB na porta do container.
    const albSg = await ensureSecurityGroup(client, ctx, vpcId, "alb", "Genesis ALB ingress 80/443", "sg_alb");
    const taskSg = await ensureSecurityGroup(client, ctx, vpcId, "task", "Genesis Fargate task", "sg_task");

    // Ingress ALB (80/443 do mundo) — idempotente (Duplicate = ok).
    for (const port of [80, 443]) {
      await withRetry(
        () => client.send(new AuthorizeSecurityGroupIngressCommand({
          GroupId: albSg,
          IpPermissions: [{ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
        })),
        { maxAttempts: 2, retryable: () => false },
      ).catch((err) => { if ((err as { name?: string })?.name !== "InvalidPermission.Duplicate") throw err; });
    }
    // Ingress task: só do SG do ALB, na porta do container (cadeia ALB→task).
    const port = containerPort(ctx);
    await client.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: taskSg,
      IpPermissions: [{
        IpProtocol: "tcp", FromPort: port, ToPort: port,
        UserIdGroupPairs: [{ GroupId: albSg }],
      }],
    })).catch((err) => { if ((err as { name?: string })?.name !== "InvalidPermission.Duplicate") throw err; });

    // Persiste no deployment (teardown + ecs/alb consomem via scratch e DB).
    await patchDeployment(ctx.deploymentId, {
      vpc_id: vpcId, subnet_ids: subnetIds, security_group_ids: [albSg, taskSg],
    });
    ctx.scratch.vpcId = vpcId;
    ctx.scratch.subnetIds = subnetIds;
    ctx.scratch.azs = azs;
    ctx.scratch.albSecurityGroupId = albSg;
    ctx.scratch.taskSecurityGroupId = taskSg;
    ctx.scratch.assignPublicIp = "ENABLED"; // zero-NAT: egress ao ECR/logs via IP público
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const client = ec2Client(ctx.creds);
    // Deleta os SGs criados (task antes de alb, pela dependência de referência).
    for (const rt of ["sg_task", "sg_alb"]) {
      const res = await findCreatedResource(ctx.deploymentId, rt);
      if (res?.arn) {
        await client.send(new DeleteSecurityGroupCommand({ GroupId: res.arn })).catch(() => { /* T21 reconcilia */ });
      }
    }
  },
};

registerDriver(networkingDriver);
