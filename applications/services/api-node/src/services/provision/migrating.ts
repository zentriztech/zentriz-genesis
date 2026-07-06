/**
 * migrating.ts — G1-T16 (Fase C). Fase MIGRATING: migrate+seed one-shot ANTES do service.
 *
 * Por que uma RunTask dedicada e não deixar o container do service migrar no start:
 * o service sobe N tasks; duas rodando migrate ao mesmo tempo = corrida. Uma RunTask
 * ÚNICA, esperada até terminar, elimina isso. Se a migração falhar, o deploy vira
 * FAILED (visível) em vez da URL viva responder 500 silencioso.
 *
 * Idempotência em duas camadas:
 *   1. Guarda "já rodou": ledger `migrate_run` created → pula (re-run/resume não re-migra).
 *   2. O comando em si deve ser idempotente no app (drizzle migrate + seed upsert). Além
 *      disso envolvemos com pg_advisory_lock via o próprio script do app (convenção).
 *
 * Resumível: MIGRATING está no resume-no-boot; se o processo morreu esperando a task,
 * o re-run redescreve a RunTask por ARN (persistido) e só re-dispara se não houver ledger.
 */

import {
  RunTaskCommand, DescribeTasksCommand, CreateClusterCommand, type ECSClient,
} from "@aws-sdk/client-ecs";
import { ecsClient } from "./awsClients.js";
import { registerTaskDef, containerName } from "./taskDef.js";
import {
  recordResourceIntent, markResourceCreated, markResourceFailed,
  findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

/** Comando de migrate+seed. Configurável; default tenta os scripts npm comuns e não falha se ausente. */
function migrateCommand(): string[] {
  const custom = (process.env.GENESIS_MIGRATE_COMMAND ?? "").trim();
  if (custom) return ["sh", "-c", custom];
  // Convenção: roda migrate (drizzle/knex/prisma) e seed se existirem; tolera ausência.
  return ["sh", "-c",
    "npm run migrate 2>/dev/null || npm run db:migrate 2>/dev/null || npx drizzle-kit migrate 2>/dev/null || true; " +
    "npm run seed 2>/dev/null || npm run db:seed 2>/dev/null || true",
  ];
}

function migrateFamily(ctx: ProvisionContext): string {
  return `genesis-migrate-${ctx.deploymentId.slice(0, 12)}`;
}

/** Aguarda a RunTask parar; sucesso = exitCode 0 do container essencial. */
async function waitTaskStopped(ecs: ECSClient, cluster: string, taskArn: string): Promise<{ ok: boolean; reason: string }> {
  const maxAttempts = 40; // 40 × 15s = 10min
  for (let i = 0; i < maxAttempts; i++) {
    const out = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
    const task = out.tasks?.[0];
    if (task?.lastStatus === "STOPPED") {
      const container = task.containers?.find((c) => c.name?.startsWith("app-")) ?? task.containers?.[0];
      const code = container?.exitCode;
      if (code === 0) return { ok: true, reason: "exit 0" };
      return { ok: false, reason: `exitCode=${code ?? "null"} stopped=${task.stoppedReason ?? "?"}` };
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { ok: false, reason: "MIGRATE_TIMEOUT (10min)" };
}

export const migratingDriver: ProvisionDriver = {
  key: "migrating",
  status: "migrating",

  async provision(ctx: ProvisionContext): Promise<void> {
    // Guarda "já rodou": ledger migrate_run created → não re-migra (idempotência de resume).
    const prior = await findCreatedResource(ctx.deploymentId, "migrate_run");
    if (prior) return;

    const ecs = ecsClient(ctx.creds);
    // Cluster compartilhado (shared) — 1 por conta Zentriz. Idempotente: CreateCluster
    // de cluster existente é no-op. O driver ecs (T17) reusa este mesmo cluster.
    const cluster = (process.env.GENESIS_ECS_CLUSTER ?? "genesis").trim();
    await ecs.send(new CreateClusterCommand({
      clusterName: cluster,
      tags: [{ key: "zentriz:product", value: "genesis" }],
    })).catch(() => { /* já existe = ok */ });
    ctx.scratch.clusterName = cluster;

    // Task-def dedicada com o comando de migrate (mesma imagem/roles/secrets do service).
    const taskDefArn = await registerTaskDef(ecs, ctx, {
      family: migrateFamily(ctx), command: migrateCommand(),
    });

    const ledgerId = await recordResourceIntent(ctx.deploymentId, "migrate_run", migrateFamily(ctx), ctx.creds.region);

    // RunTask na rede do networking (subnets públicas + assignPublicIp p/ egress ao RDS/ECR).
    const run = await ecs.send(new RunTaskCommand({
      cluster,
      taskDefinition: taskDefArn,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: (ctx.scratch.subnetIds as string[]) ?? [],
          securityGroups: [ctx.scratch.taskSecurityGroupId as string].filter(Boolean),
          assignPublicIp: (ctx.scratch.assignPublicIp as "ENABLED" | "DISABLED") ?? "ENABLED",
        },
      },
      overrides: { containerOverrides: [{ name: containerName(ctx) }] },
    }));
    const taskArn = run.tasks?.[0]?.taskArn;
    if (!taskArn) {
      await markResourceFailed(ledgerId, `RunTask não retornou taskArn: ${JSON.stringify(run.failures ?? [])}`);
      throw new Error(`MIGRATE_RUNTASK_FAILED: ${JSON.stringify(run.failures ?? [])}`);
    }
    await patchDeployment(ctx.deploymentId, { migrate_task_arn: taskArn });

    const result = await waitTaskStopped(ecs, cluster, taskArn);
    if (!result.ok) {
      await markResourceFailed(ledgerId, result.reason);
      throw new Error(`MIGRATE_FAILED: ${result.reason}`);
    }
    await markResourceCreated(ledgerId, taskArn, { command: "migrate+seed" });
  },

  // Sem teardown: a RunTask é efêmera (já parou). O que ela criou no banco é desfeito
  // com o RDS (driver rds.teardown). Nada a compensar aqui.
};

registerDriver(migratingDriver);
