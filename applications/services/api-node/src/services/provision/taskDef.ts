/**
 * taskDef.ts — G1-T16/T17 (Fase C). Builder compartilhado de ECS task definitions.
 *
 * Tanto a fase MIGRATING (RunTask one-shot, G1-T16) quanto o service Fargate (G1-T17)
 * registram task-defs com a MESMA base: imagem ECR (T11), execution/task role (T13),
 * secrets por ARN (T15) e runtimePlatform X86_64/LINUX (casa com --platform linux/amd64).
 *
 * A diferença é o `command` (migrate+seed vs default do container) e a família.
 */

import {
  RegisterTaskDefinitionCommand, type ECSClient,
} from "@aws-sdk/client-ecs";
import type { ProvisionContext } from "./provisionChain.js";

/** Chaves do app secret que viram `secrets` (valueFrom = <arn>:<key>::) na task-def.
 * `exclude` remove chaves que serão passadas como environment plano (evita ECS "specified
 * twice"): em demo, DATABASE_URL vem do sidecar (localhost) no environment, não do secret. */
function secretRefs(ctx: ProvisionContext, exclude: Set<string> = new Set()): Array<{ name: string; valueFrom: string }> {
  const arn = ctx.scratch.appSecretArn as string | undefined;
  const keys = (ctx.scratch.appSecretKeys as string[] | undefined) ?? [];
  if (!arn) return [];
  return keys.filter((k) => !exclude.has(k)).map((k) => ({ name: k, valueFrom: `${arn}:${k}::` }));
}

export function containerName(ctx: ProvisionContext): string {
  return `app-${ctx.deploymentId.slice(0, 8)}`;
}

export function logGroupName(ctx: ProvisionContext): string {
  return `/genesis/${ctx.deploymentId}`;
}

export interface RegisterTaskDefOpts {
  family: string;
  /** Override do comando (migrate+seed). Ausente = usa o CMD/ENTRYPOINT da imagem. */
  command?: string[];
  cpu?: string;      // default 256
  memory?: string;   // default 512
  /** DM-T9 (demo): anexa um postgres sidecar na MESMA task (efêmero, sem RDS). */
  withDbSidecar?: { version: string; database: string };
}

const DB_SIDECAR_NAME = "db";

/**
 * Registra uma task-def e devolve o taskDefinitionArn.
 * Idempotente no sentido do ECS: cada registro cria uma nova REVISÃO (barato, esperado);
 * o describe-before-create de RDS/ECS não se aplica aqui — a task-def é versionada.
 */
export async function registerTaskDef(
  ecs: ECSClient, ctx: ProvisionContext, opts: RegisterTaskDefOpts,
): Promise<string> {
  const execRoleArn = ctx.scratch.executionRoleArn as string | undefined;
  const taskRoleArn = ctx.scratch.taskRoleArn as string | undefined;
  const image = ctx.ecrRepoUri && ctx.imageTag ? `${ctx.ecrRepoUri}:${ctx.imageTag}` : ctx.ecrRepoUri ?? "";
  const port = Number(ctx.scratch.containerPort) || 3004;
  const region = ctx.creds.region;

  const logOpts = (prefix: string) => ({
    logDriver: "awslogs",
    options: {
      "awslogs-group": logGroupName(ctx),
      "awslogs-region": region,
      "awslogs-stream-prefix": prefix,
      "awslogs-create-group": "true",
    },
  });

  // Em demo (sidecar), DATABASE_URL vem do environment (localhost) — então é EXCLUÍDO dos
  // secrets p/ não colidir (ECS rejeita a mesma chave em secrets+environment).
  const secretExclude = opts.withDbSidecar ? new Set(["DATABASE_URL"]) : new Set<string>();
  const appContainer = {
    name: containerName(ctx),
    image,
    essential: true,
    command: opts.command,
    portMappings: opts.command ? undefined : [{ containerPort: port, protocol: "tcp" }],
    secrets: secretRefs(ctx, secretExclude),
    // DM-T9: em demo (sidecar), o app fala com o DB em localhost:5432 na mesma task.
    environment: opts.withDbSidecar
      ? [{ name: "DATABASE_URL", value: `postgresql://genesis:demo@localhost:5432/${opts.withDbSidecar.database}` }]
      : undefined,
    ...(opts.withDbSidecar ? { dependsOn: [{ containerName: DB_SIDECAR_NAME, condition: "HEALTHY" }] } : {}),
    logConfiguration: logOpts(opts.command ? "migrate" : "app"),
  };

  const containerDefinitions: unknown[] = [appContainer];
  if (opts.withDbSidecar) {
    // Postgres efêmero na mesma task — some quando a task morre (demo descartável).
    containerDefinitions.push({
      name: DB_SIDECAR_NAME,
      image: `postgres:${opts.withDbSidecar.version}-alpine`,
      essential: true,
      environment: [
        { name: "POSTGRES_USER", value: "genesis" },
        { name: "POSTGRES_PASSWORD", value: "demo" },
        { name: "POSTGRES_DB", value: opts.withDbSidecar.database },
      ],
      healthCheck: {
        command: ["CMD-SHELL", "pg_isready -U genesis"],
        interval: 10, timeout: 5, retries: 5, startPeriod: 10,
      },
      logConfiguration: logOpts("db"),
    });
  }

  const out = await ecs.send(new RegisterTaskDefinitionCommand({
    family: opts.family,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: opts.cpu ?? "256",
    memory: opts.memory ?? "512",
    executionRoleArn: execRoleArn,
    taskRoleArn: taskRoleArn,
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containerDefinitions: containerDefinitions as any,
    tags: [
      { key: "zentriz:product", value: "genesis" },
      { key: "zentriz:deployment_id", value: ctx.deploymentId },
    ],
  }));
  return out.taskDefinition!.taskDefinitionArn!;
}
