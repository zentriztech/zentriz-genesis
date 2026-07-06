/**
 * rds.ts — G1-T15 (Fase C). Driver do banco durável (RDS PostgreSQL 16).
 *
 * Cria: DB subnet group (≥2 AZ, das subnets do networking) + instância RDS
 * db.t3.micro PG16 single-AZ. IDEMPOTENTE por identifier (reusa, NUNCA recria).
 * Poller resumível espera `available` (6-15min) — como a cadeia é reexecutada no
 * resume-no-boot e o describe-before-create reencontra a instância, o poll retoma.
 *
 * Zero plaintext no código de aplicação: a senha do master é gerada uma vez e
 * gravada num secret dedicado `genesis/<id>/db-master` (recuperada no resume via
 * GetSecretValue). A montagem do DATABASE_URL + env do app fica no driver secrets.
 *
 * durable → deletion protection ON + final snapshot; demo → OFF + skip snapshot.
 */

import {
  CreateDBInstanceCommand, DescribeDBInstancesCommand, DeleteDBInstanceCommand,
  CreateDBSubnetGroupCommand, DescribeDBSubnetGroupsCommand, ModifyDBInstanceCommand,
  type RDSClient,
} from "@aws-sdk/client-rds";
import {
  CreateSecretCommand, GetSecretValueCommand, type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "node:crypto";
import { rdsClient, secretsClient, withRetry } from "./awsClients.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

const ENGINE_VERSION = (process.env.GENESIS_RDS_PG_VERSION ?? "16").trim();
const DB_NAME = "appdb";
const MASTER_USER = "genesis";

function dbIdentifier(deploymentId: string): string {
  return `genesis-${deploymentId.slice(0, 12)}`;
}
function subnetGroupName(deploymentId: string): string {
  return `genesis-${deploymentId.slice(0, 12)}`;
}
function masterSecretName(deploymentId: string): string {
  return `genesis/${deploymentId}/db-master`;
}

/** Senha forte sem caracteres proibidos pelo RDS (/, @, ", espaço). Hex é seguro. */
function generatePassword(): string {
  return randomBytes(24).toString("hex"); // 48 chars alfanuméricos
}

/** Recupera (ou gera+grava) a senha do master, resistente a resume. */
async function ensureMasterPassword(sm: SecretsManagerClient, ctx: ProvisionContext): Promise<string> {
  const name = masterSecretName(ctx.deploymentId);
  try {
    const got = await sm.send(new GetSecretValueCommand({ SecretId: name }));
    if (got.SecretString) return JSON.parse(got.SecretString).password as string;
  } catch (err) {
    if ((err as { name?: string })?.name !== "ResourceNotFoundException") throw err;
  }
  const password = generatePassword();
  const ledgerId = await recordResourceIntent(ctx.deploymentId, "secret_db_master", name, ctx.creds.region);
  try {
    const out = await sm.send(new CreateSecretCommand({
      Name: name, SecretString: JSON.stringify({ username: MASTER_USER, password }),
      Tags: [{ Key: "zentriz:product", Value: "genesis" }, { Key: "zentriz:deployment_id", Value: ctx.deploymentId }],
    }));
    await markResourceCreated(ledgerId, out.ARN!, { name });
    return password;
  } catch (err) {
    if ((err as { name?: string })?.name === "ResourceExistsException") {
      const got = await sm.send(new GetSecretValueCommand({ SecretId: name }));
      return JSON.parse(got.SecretString!).password as string;
    }
    throw err;
  }
}

async function ensureSubnetGroup(client: RDSClient, ctx: ProvisionContext): Promise<string> {
  const name = subnetGroupName(ctx.deploymentId);
  const subnetIds = (ctx.scratch.subnetIds as string[] | undefined) ?? [];
  if (subnetIds.length < 2) throw new Error("RDS_NO_SUBNETS: networking não populou subnetIds (≥2 AZ)");
  try {
    await client.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: name }));
    return name; // já existe
  } catch (err) {
    if ((err as { name?: string })?.name !== "DBSubnetGroupNotFoundFault") throw err;
  }
  const ledgerId = await recordResourceIntent(ctx.deploymentId, "db_subnet_group", name, ctx.creds.region);
  await client.send(new CreateDBSubnetGroupCommand({
    DBSubnetGroupName: name, DBSubnetGroupDescription: `Genesis ${ctx.deploymentId}`, SubnetIds: subnetIds,
    Tags: [{ Key: "zentriz:product", Value: "genesis" }, { Key: "zentriz:deployment_id", Value: ctx.deploymentId }],
  }));
  await markResourceCreated(ledgerId, name, { subnetIds });
  return name;
}

interface RdsEndpoint { address: string; port: number; arn: string; status: string; }

async function describeInstance(client: RDSClient, identifier: string): Promise<RdsEndpoint | null> {
  try {
    const out = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    const inst = out.DBInstances?.[0];
    if (!inst) return null;
    return {
      address: inst.Endpoint?.Address ?? "",
      port: inst.Endpoint?.Port ?? 5432,
      arn: inst.DBInstanceArn ?? "",
      status: inst.DBInstanceStatus ?? "unknown",
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "DBInstanceNotFoundFault") return null;
    throw err;
  }
}

/** Poll até available. Resumível: cada chamada re-descreve; timeout amplo (~15min). */
async function waitAvailable(client: RDSClient, identifier: string): Promise<RdsEndpoint> {
  const maxAttempts = 60;        // 60 × 15s = 15min
  for (let i = 0; i < maxAttempts; i++) {
    const ep = await describeInstance(client, identifier);
    if (ep && ep.status === "available" && ep.address) return ep;
    if (ep && ["failed", "incompatible-parameters", "incompatible-restore"].includes(ep.status)) {
      throw new Error(`RDS_FAILED: instância ${identifier} em estado ${ep.status}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(`RDS_TIMEOUT: ${identifier} não ficou available em 15min`);
}

export const rdsDriver: ProvisionDriver = {
  key: "rds",
  status: "provisioning",

  async provision(ctx: ProvisionContext): Promise<void> {
    const client = rdsClient(ctx.creds);
    const sm = secretsClient(ctx.creds);
    const identifier = dbIdentifier(ctx.deploymentId);
    const isDemo = ctx.klass === "demo";

    const password = await ensureMasterPassword(sm, ctx);
    const subnetGroup = await ensureSubnetGroup(client, ctx);
    const taskSg = ctx.scratch.taskSecurityGroupId as string | undefined;

    // describe-before-create: se já existe (re-run/resume), não recria.
    let ep = await describeInstance(client, identifier);
    if (!ep) {
      const ledgerId = await recordResourceIntent(ctx.deploymentId, "rds_instance", identifier, ctx.creds.region);
      await withRetry(
        () => client.send(new CreateDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          Engine: "postgres",
          EngineVersion: ENGINE_VERSION,
          DBInstanceClass: "db.t3.micro",
          AllocatedStorage: 20,
          MasterUsername: MASTER_USER,
          MasterUserPassword: password,
          DBName: DB_NAME,
          DBSubnetGroupName: subnetGroup,
          VpcSecurityGroupIds: taskSg ? [taskSg] : undefined,
          MultiAZ: false,
          PubliclyAccessible: false,
          StorageEncrypted: true,
          BackupRetentionPeriod: isDemo ? 0 : 7,
          DeletionProtection: !isDemo,
          Tags: [
            { Key: "zentriz:product", Value: "genesis" },
            { Key: "zentriz:deployment_id", Value: ctx.deploymentId },
            { Key: "zentriz:project_id", Value: ctx.projectId },
          ],
        })),
        { maxAttempts: 3, retryable: (e) => (e as { name?: string })?.name === "InvalidParameterValue" },
      );
      // grava o ARN assim que disponível (o describe seguinte traz o ARN definitivo)
      const created = await describeInstance(client, identifier);
      if (created?.arn) await markResourceCreated(ledgerId, created.arn, { identifier });
    }

    // Poll até available (resumível).
    ep = await waitAvailable(client, identifier);

    await patchDeployment(ctx.deploymentId, {
      rds_arn: ep.arn, rds_endpoint: `${ep.address}:${ep.port}`, db_subnet_group: subnetGroup,
    });

    // Disponibiliza p/ o driver secrets montar o DATABASE_URL.
    ctx.scratch.rdsEndpoint = ep.address;
    ctx.scratch.rdsPort = ep.port;
    ctx.scratch.rdsPassword = password;
    ctx.scratch.rdsUser = MASTER_USER;
    ctx.scratch.rdsDbName = DB_NAME;
    ctx.scratch.databaseUrl = `postgresql://${MASTER_USER}:${password}@${ep.address}:${ep.port}/${DB_NAME}`;
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const client = rdsClient(ctx.creds);
    const identifier = dbIdentifier(ctx.deploymentId);
    const isDemo = ctx.klass === "demo";
    // Durable tem DeletionProtection ON → precisa desativar ANTES do delete (senão falha).
    if (!isDemo) {
      await client.send(new ModifyDBInstanceCommand({
        DBInstanceIdentifier: identifier, DeletionProtection: false, ApplyImmediately: true,
      })).catch(() => { /* not found ou já off — segue */ });
    }
    try {
      await client.send(new DeleteDBInstanceCommand({
        DBInstanceIdentifier: identifier,
        SkipFinalSnapshot: isDemo,                                    // durable gera snapshot; demo não
        FinalDBSnapshotIdentifier: isDemo ? undefined : `${identifier}-final`,
        DeleteAutomatedBackups: isDemo,
      }));
    } catch (err) {
      // Not found = já removida (idempotente).
      if ((err as { name?: string })?.name !== "DBInstanceNotFoundFault") { /* T22 reconcilia */ }
    }
    // Subnet group só some depois da instância; a reconciliação remove no ciclo seguinte.
  },
};

registerDriver(rdsDriver);
