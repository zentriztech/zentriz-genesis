/**
 * secrets.ts — G1-T15 (Fase C). Driver de segredos da aplicação (Secrets Manager).
 *
 * Grava um secret `genesis/<id>/app` com o env sensível do backend:
 *   DATABASE_URL (do driver rds) + JWT_SECRET forte (gerado por deployment) +
 *   NODE_ENV=production + PORT. A task-def (T17) referencia este secret por ARN via
 *   `containerDefinitions[].secrets` — ZERO senha em texto na definição da task.
 *
 * Depois de conhecer o ARN do secret, ESCOPA o grant do exec role
 * (secretsmanager:GetSecretValue no ARN exato) — o IAM (T13) não tinha o ARN ainda.
 *
 * Idempotente: se o secret já existe (re-run/resume), atualiza o valor (PutSecretValue).
 */

import {
  CreateSecretCommand, PutSecretValueCommand, GetSecretValueCommand, DeleteSecretCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { PutRolePolicyCommand, type IAMClient } from "@aws-sdk/client-iam";
import { randomBytes } from "node:crypto";
import { iamClient, secretsClient, withRetry } from "./awsClients.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

function appSecretName(deploymentId: string): string {
  return `genesis/${deploymentId}/app`;
}

/** JWT_SECRET forte por deployment (64 hex = 256 bits). */
function generateJwtSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Monta o mapa de env sensível a partir do scratch (rds) + defaults. */
function buildSecretPayload(ctx: ProvisionContext): Record<string, string> {
  const databaseUrl = (ctx.scratch.databaseUrl as string | undefined) ?? "";
  const port = String(Number(ctx.scratch.containerPort) || 3004);
  return {
    DATABASE_URL: databaseUrl,
    JWT_SECRET: (ctx.scratch.jwtSecret as string | undefined) ?? generateJwtSecret(),
    NODE_ENV: "production",
    PORT: port,
  };
}

/** Anexa ao exec role o grant de leitura escopado ao ARN do secret + kms:Decrypt. */
async function scopeSecretGrantToExecRole(
  iam: IAMClient, ctx: ProvisionContext, secretArn: string,
): Promise<void> {
  const execRoleName = ctx.scratch.executionRoleName as string | undefined;
  if (!execRoleName) return; // IAM driver não rodou (não deve ocorrer na cadeia normal)
  const doc = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "ReadAppSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn },
      // KMS decrypt via chave gerenciada da AWS p/ Secrets Manager (GATE 1: sem CMK própria).
      { Sid: "KmsDecrypt", Effect: "Allow", Action: "kms:Decrypt", Resource: "*",
        Condition: { StringEquals: { "kms:ViaService": `secretsmanager.${ctx.creds.region}.amazonaws.com` } } },
    ],
  });
  await withRetry(
    () => iam.send(new PutRolePolicyCommand({ RoleName: execRoleName, PolicyName: "genesis-secret-read", PolicyDocument: doc })),
    { retryable: (e) => (e as { name?: string })?.name === "NoSuchEntityException" },
  );
}

async function ensureAppSecret(sm: SecretsManagerClient, ctx: ProvisionContext, payload: Record<string, string>): Promise<string> {
  const name = appSecretName(ctx.deploymentId);
  const value = JSON.stringify(payload);

  const prior = await findCreatedResource(ctx.deploymentId, "secret_app");
  if (prior?.arn) {
    // Atualiza o valor (idempotente — resume pode ter novo DATABASE_URL).
    await sm.send(new PutSecretValueCommand({ SecretId: prior.arn, SecretString: value })).catch(() => {});
    return prior.arn;
  }

  const ledgerId = await recordResourceIntent(ctx.deploymentId, "secret_app", name, ctx.creds.region);
  try {
    const out = await sm.send(new CreateSecretCommand({
      Name: name, SecretString: value,
      Tags: [{ Key: "zentriz:product", Value: "genesis" }, { Key: "zentriz:deployment_id", Value: ctx.deploymentId }],
    }));
    await markResourceCreated(ledgerId, out.ARN!, { name });
    return out.ARN!;
  } catch (err) {
    if ((err as { name?: string })?.name === "ResourceExistsException") {
      // Já existe (criado em run anterior sem ledger) — recupera ARN e atualiza valor.
      const got = await sm.send(new GetSecretValueCommand({ SecretId: name }));
      const arn = got.ARN!;
      await sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: value })).catch(() => {});
      await markResourceCreated(ledgerId, arn, { name });
      return arn;
    }
    throw err;
  }
}

export const secretsDriver: ProvisionDriver = {
  key: "secrets",
  status: "provisioning",

  async provision(ctx: ProvisionContext): Promise<void> {
    const sm = secretsClient(ctx.creds);
    const iam = iamClient(ctx.creds);

    const payload = buildSecretPayload(ctx);
    // Guarda o JWT_SECRET no scratch p/ reuso consistente em re-run dentro da mesma execução.
    ctx.scratch.jwtSecret = payload.JWT_SECRET;

    const secretArn = await ensureAppSecret(sm, ctx, payload);
    await scopeSecretGrantToExecRole(iam, ctx, secretArn);

    await patchDeployment(ctx.deploymentId, { secret_arn: secretArn });
    ctx.scratch.appSecretArn = secretArn;
    // Chaves do secret p/ a task-def mapear em containerDefinitions[].secrets (T17).
    ctx.scratch.appSecretKeys = Object.keys(payload);
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const sm = secretsClient(ctx.creds);
    for (const name of [appSecretName(ctx.deploymentId), `genesis/${ctx.deploymentId}/db-master`]) {
      // ForceDeleteWithoutRecovery p/ liberar o nome imediatamente (idempotente).
      await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })).catch(() => {});
    }
  },
};

registerDriver(secretsDriver);
