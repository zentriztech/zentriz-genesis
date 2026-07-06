/**
 * iam.ts — G1-T13 (Fase C). Primeiro driver da cadeia: papéis IAM do serviço ECS.
 *
 * Cria DUAS roles sob o path `/genesis/<deployment_id>/`:
 *   • execution role — usada pelo agente do ECS: pull da imagem no ECR, escrita de
 *     logs no CloudWatch e leitura do segredo (GetSecretValue + kms:Decrypt escopado
 *     ao ARN do segredo, preenchido pelo driver secrets em T15).
 *   • task role — identidade do container em runtime (mínima no GATE 1).
 *
 * Por que PATH e não tag: o Resource Groups Tagging API NÃO lista IAM. O path
 * `/genesis/<id>/` torna as roles descobríveis via ListRoles(PathPrefix=...) e
 * removíveis no teardown (T21) sem depender de tags.
 *
 * SEAM GATE 2: se GENESIS_PERMISSIONS_BOUNDARY_ARN estiver setado, as roles são
 * criadas COM PermissionsBoundary — obrigatório para provisionar em conta de terceiro
 * sem privilégio excessivo. No GATE 1 (conta própria) é opcional e normalmente ausente.
 */

import {
  CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand,
  DeleteRoleCommand, DeleteRolePolicyCommand, ListRolePoliciesCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { iamClient, withRetry } from "./awsClients.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

const ECS_TASKS_TRUST = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

/** Path determinístico por deployment — base da descoberta/teardown. */
export function rolePath(deploymentId: string): string {
  return `/genesis/${deploymentId}/`;
}
function execRoleName(deploymentId: string): string {
  return `genesis-exec-${deploymentId.slice(0, 12)}`;
}
function taskRoleName(deploymentId: string): string {
  return `genesis-task-${deploymentId.slice(0, 12)}`;
}

function boundaryArn(): string | undefined {
  const v = (process.env.GENESIS_PERMISSIONS_BOUNDARY_ARN ?? "").trim();
  return v || undefined;
}

/** Retryable enquanto a role recém-criada ainda não propagou (eventual consistency). */
function isEventualConsistency(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "NoSuchEntityException" || name === "MalformedPolicyDocumentException";
}

/**
 * Cria (ou reaproveita) uma role sob o path do deployment. Idempotente:
 * describe-before-create via ledger + GetRole; EntityAlreadyExists = ok.
 */
async function ensureRole(
  client: IAMClient,
  ctx: ProvisionContext,
  roleName: string,
  resourceType: string,
): Promise<string> {
  // Já criada neste deployment? (re-run / resume)
  const prior = await findCreatedResource(ctx.deploymentId, resourceType);
  if (prior?.arn) return prior.arn;

  const path = rolePath(ctx.deploymentId);
  const ledgerId = await recordResourceIntent(ctx.deploymentId, resourceType, roleName, ctx.creds.region, { path });

  let arn: string;
  try {
    const out = await client.send(new CreateRoleCommand({
      RoleName: roleName,
      Path: path,
      AssumeRolePolicyDocument: ECS_TASKS_TRUST,
      PermissionsBoundary: boundaryArn(),
      Tags: [
        { Key: "zentriz:product", Value: "genesis" },
        { Key: "zentriz:deployment_id", Value: ctx.deploymentId },
        { Key: "zentriz:project_id", Value: ctx.projectId },
      ],
      Description: `Genesis backend deployment ${ctx.deploymentId}`,
    }));
    arn = out.Role!.Arn!;
  } catch (err) {
    if ((err as { name?: string })?.name === "EntityAlreadyExistsException") {
      const got = await client.send(new GetRoleCommand({ RoleName: roleName }));
      arn = got.Role!.Arn!;
    } else {
      throw err;
    }
  }
  await markResourceCreated(ledgerId, arn, { path, roleName });
  return arn;
}

/** Policy inline da execution role: ECR pull + logs + (secret grant escopado em T15). */
function executionPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EcrPull",
        Effect: "Allow",
        Action: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        Resource: "*",
      },
      {
        Sid: "Logs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"],
        Resource: "*",
      },
    ],
  });
}

export const iamDriver: ProvisionDriver = {
  key: "iam",
  status: "provisioning",

  async provision(ctx: ProvisionContext): Promise<void> {
    const client = iamClient(ctx.creds);

    // 1. Execution role + policy inline.
    const execName = execRoleName(ctx.deploymentId);
    const execArn = await ensureRole(client, ctx, execName, "iam_execution_role");
    await withRetry(
      () => client.send(new PutRolePolicyCommand({
        RoleName: execName, PolicyName: "genesis-exec", PolicyDocument: executionPolicy(),
      })),
      { retryable: isEventualConsistency, label: "put-exec-policy" },
    );

    // 2. Task role (identidade de runtime — mínima no GATE 1).
    const taskName = taskRoleName(ctx.deploymentId);
    const taskArn = await ensureRole(client, ctx, taskName, "iam_task_role");

    // Disponibiliza os ARNs + path para os drivers seguintes (ecs) e o teardown.
    ctx.scratch.executionRoleArn = execArn;
    ctx.scratch.taskRoleArn = taskArn;
    ctx.scratch.executionRoleName = execName;
    ctx.scratch.taskRoleName = taskName;
    ctx.scratch.iamRolePath = rolePath(ctx.deploymentId);
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const client = iamClient(ctx.creds);
    for (const name of [execRoleName(ctx.deploymentId), taskRoleName(ctx.deploymentId)]) {
      try {
        // Remove policies inline antes de deletar a role (IAM exige role vazia).
        const pols = await client.send(new ListRolePoliciesCommand({ RoleName: name }));
        for (const p of pols.PolicyNames ?? []) {
          await client.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: p })).catch(() => {});
        }
        await client.send(new DeleteRoleCommand({ RoleName: name }));
      } catch (err) {
        // Role ausente = já limpa (idempotente). Outros erros ficam para a reconciliação.
        if ((err as { name?: string })?.name !== "NoSuchEntityException") { /* T21 reconcilia */ }
      }
    }
  },
};

registerDriver(iamDriver);
