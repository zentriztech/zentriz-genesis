/**
 * ecsFargate.ts — G1-T17 (Fase C). Driver do service Fargate single-service.
 *
 * Registra a task-def do SERVICE (mesma base do migrate, mas com portMappings e sem
 * command override), cria o TARGET GROUP (type=ip, exigido por awsvpc/Fargate) com
 * health-check no healthPath, e cria/atualiza o ECS Service:
 *   • CreateService com deploymentCircuitBreaker {enable, rollback} → deploy ruim
 *     reverte sozinho (não deixa o service num estado quebrado).
 *   • se service_arn já existe → UpdateService --force-new-deployment (2º deploy não
 *     duplica; puxa a nova imagem).
 *
 * O listener/ALB que aponta para este target group é criado pelo driver alb (T18).
 * Aqui persistimos target_group_arn/cluster_arn/task_def_arn/service_arn (write-ahead).
 */

import {
  CreateServiceCommand, UpdateServiceCommand, DescribeServicesCommand,
  DeleteServiceCommand, type ECSClient,
} from "@aws-sdk/client-ecs";
import {
  CreateTargetGroupCommand, DescribeTargetGroupsCommand, DeleteTargetGroupCommand,
  type ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { ecsClient, elbv2Client } from "./awsClients.js";
import { registerTaskDef } from "./taskDef.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

function serviceFamily(ctx: ProvisionContext): string {
  return `genesis-svc-${ctx.deploymentId.slice(0, 12)}`;
}
function serviceName(ctx: ProvisionContext): string {
  return `genesis-${ctx.deploymentId.slice(0, 12)}`;
}
function targetGroupName(ctx: ProvisionContext): string {
  // TG name: ≤32 chars, alfanumérico/hífen.
  return `gen-${ctx.deploymentId.slice(0, 12)}`;
}

async function ensureTargetGroup(
  elb: ElasticLoadBalancingV2Client, ctx: ProvisionContext,
): Promise<string> {
  const prior = await findCreatedResource(ctx.deploymentId, "target_group");
  if (prior?.arn) return prior.arn;
  const name = targetGroupName(ctx);
  const vpcId = ctx.scratch.vpcId as string | undefined;
  const port = Number(ctx.scratch.containerPort) || 3004;
  const healthPath = (ctx.scratch.healthPath as string | undefined) ?? "/health";

  // describe-before-create por nome (idempotente).
  try {
    const got = await elb.send(new DescribeTargetGroupsCommand({ Names: [name] }));
    const arn = got.TargetGroups?.[0]?.TargetGroupArn;
    if (arn) return arn;
  } catch (err) {
    if ((err as { name?: string })?.name !== "TargetGroupNotFoundException") throw err;
  }

  const ledgerId = await recordResourceIntent(ctx.deploymentId, "target_group", name, ctx.creds.region);
  const out = await elb.send(new CreateTargetGroupCommand({
    Name: name, Protocol: "HTTP", Port: port, VpcId: vpcId,
    TargetType: "ip", // Fargate awsvpc exige target type ip
    HealthCheckProtocol: "HTTP", HealthCheckPath: healthPath,
    HealthCheckIntervalSeconds: 30, HealthyThresholdCount: 2, UnhealthyThresholdCount: 3,
    Matcher: { HttpCode: "200-399" },
  }));
  const arn = out.TargetGroups![0].TargetGroupArn!;
  await markResourceCreated(ledgerId, arn, { name, port });
  return arn;
}

async function findService(ecs: ECSClient, cluster: string, name: string): Promise<{ arn: string; status: string } | null> {
  const out = await ecs.send(new DescribeServicesCommand({ cluster, services: [name] }));
  const svc = out.services?.find((s) => s.status !== "INACTIVE");
  if (!svc?.serviceArn) return null;
  return { arn: svc.serviceArn, status: svc.status ?? "unknown" };
}

export const ecsFargateDriver: ProvisionDriver = {
  key: "ecs",
  status: "creating_service",

  async provision(ctx: ProvisionContext): Promise<void> {
    const ecs = ecsClient(ctx.creds);
    const elb = elbv2Client(ctx.creds);
    const cluster = (ctx.scratch.clusterName as string | undefined) ?? "genesis";
    const name = serviceName(ctx);

    // Task-def do service (com portMappings; sem command override).
    // DM-T9 (demo): anexa postgres sidecar na MESMA task (efêmero, sem RDS).
    const demoSidecar = ctx.klass === "demo"
      ? { withDbSidecar: { version: String(ctx.scratch.dbVersion ?? "16"), database: String(ctx.scratch.demoDbName ?? "appdb") } }
      : {};
    const taskDefArn = await registerTaskDef(ecs, ctx, { family: serviceFamily(ctx), ...demoSidecar });
    const targetGroupArn = await ensureTargetGroup(elb, ctx);
    ctx.scratch.targetGroupArn = targetGroupArn;

    const subnets = (ctx.scratch.subnetIds as string[]) ?? [];
    const taskSg = ctx.scratch.taskSecurityGroupId as string;
    const port = Number(ctx.scratch.containerPort) || 3004;
    const containerNm = `app-${ctx.deploymentId.slice(0, 8)}`;

    const networkConfiguration = {
      awsvpcConfiguration: {
        subnets, securityGroups: [taskSg].filter(Boolean),
        assignPublicIp: (ctx.scratch.assignPublicIp as "ENABLED" | "DISABLED") ?? "ENABLED",
      },
    };
    const loadBalancers = [{ targetGroupArn, containerName: containerNm, containerPort: port }];

    const existing = await findService(ecs, cluster, name);
    if (existing) {
      // 2º deploy → força novo deployment com a nova task-def (não duplica service).
      await ecs.send(new UpdateServiceCommand({
        cluster, service: name, taskDefinition: taskDefArn, forceNewDeployment: true,
      }));
      await patchDeployment(ctx.deploymentId, {
        cluster_arn: cluster, task_def_arn: taskDefArn, service_arn: existing.arn, target_group_arn: targetGroupArn,
      });
      ctx.scratch.serviceArn = existing.arn;
      return;
    }

    const ledgerId = await recordResourceIntent(ctx.deploymentId, "ecs_service", name, ctx.creds.region);
    const out = await ecs.send(new CreateServiceCommand({
      cluster, serviceName: name, taskDefinition: taskDefArn,
      desiredCount: 1, launchType: "FARGATE",
      networkConfiguration, loadBalancers,
      healthCheckGracePeriodSeconds: 60,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
        minimumHealthyPercent: 100, maximumPercent: 200,
      },
      tags: [
        { key: "zentriz:product", value: "genesis" },
        { key: "zentriz:deployment_id", value: ctx.deploymentId },
        { key: "zentriz:project_id", value: ctx.projectId },
      ],
    }));
    const arn = out.service!.serviceArn!;
    await markResourceCreated(ledgerId, arn, { name });
    await patchDeployment(ctx.deploymentId, {
      cluster_arn: cluster, task_def_arn: taskDefArn, service_arn: arn, target_group_arn: targetGroupArn,
    });
    ctx.scratch.serviceArn = arn;
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const ecs = ecsClient(ctx.creds);
    const elb = elbv2Client(ctx.creds);
    const cluster = (ctx.scratch.clusterName as string | undefined) ?? "genesis";
    const name = serviceName(ctx);
    // Service primeiro (force=true derruba tasks), depois target group.
    await ecs.send(new DeleteServiceCommand({ cluster, service: name, force: true })).catch(() => {});
    const tg = await findCreatedResource(ctx.deploymentId, "target_group");
    if (tg?.arn) {
      await elb.send(new DeleteTargetGroupCommand({ TargetGroupArn: tg.arn })).catch(() => { /* T21 reconcilia */ });
    }
  },
};

registerDriver(ecsFargateDriver);
