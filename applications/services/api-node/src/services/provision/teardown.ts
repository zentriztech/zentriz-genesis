/**
 * teardown.ts — G1-T21 (Fase D). Destruição reversa in-container via AWS SDK v3.
 *
 * Roda no api-node (node:20-alpine) — usa SDK, nunca aws-cli (evita `aws: not found`).
 * Reconstrói o ProvisionContext a partir das colunas persistidas em backend_deployments
 * (+ ledger) e chama o teardown() de cada driver na ORDEM REVERSA da cadeia:
 *   route53 → alb → acm → ecs → migrating(no-op) → secrets → rds → networking → iam
 * Essa ordem garante, por ex., que os SGs (networking) só sejam apagados DEPOIS do ALB
 * e do service (senão ENI presa impede o delete do SG).
 *
 * Passo extra crítico entre ecs e networking: DRENAR as ENIs do Fargate — após
 * DeleteService, as ENIs demoram a sumir; apagar SG/subnet antes disso falha. Poll de
 * DescribeNetworkInterfaces por `group-id` até zerar.
 *
 * Idempotente: cada driver.teardown() ignora NotFound. Varredura final por tag
 * zentriz:deployment_id confirma zero recursos (best-effort — RGTA não lista IAM).
 */

import { DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";
import { GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { ec2Client } from "./awsClients.js";
import { resolveAwsCredentials, type ResolvedAwsCredentials } from "./awsCredentials.js";
import {
  getFullDeployment, setStatus, listLiveResources, markResourceDeleted,
  type FullDeploymentRow,
} from "./backendState.js";
import { CHAIN_ORDER, getDriver, type ProvisionContext } from "./provisionChain.js";
import "./drivers.js"; // registra os drivers (para getDriver funcionar)

/** Reconstrói o scratch que os teardown() dos drivers consultam. */
function scratchFromRow(row: FullDeploymentRow): Record<string, unknown> {
  return {
    clusterName: row.cluster_arn ?? "genesis",
    serviceArn: row.service_arn ?? undefined,
    targetGroupArn: row.target_group_arn ?? undefined,
    albArn: row.alb_arn ?? undefined,
    vpcId: row.vpc_id ?? undefined,
    subnetIds: row.subnet_ids ?? [],
    securityGroupIds: row.security_group_ids ?? [],
    albSecurityGroupId: row.security_group_ids?.[0],
    taskSecurityGroupId: row.security_group_ids?.[1],
    acmCertArn: row.acm_cert_arn ?? undefined,
    iamRolePath: row.iam_role_path ?? undefined,
  };
}

/** Poll até as ENIs associadas aos SGs do deployment sumirem (Fargate demora a soltar). */
async function drainNetworkInterfaces(creds: ResolvedAwsCredentials, securityGroupIds: string[]): Promise<void> {
  if (securityGroupIds.length === 0) return;
  const ec2 = ec2Client(creds);
  const maxAttempts = 20; // 20 × 15s = 5min
  for (let i = 0; i < maxAttempts; i++) {
    const out = await ec2.send(new DescribeNetworkInterfacesCommand({
      Filters: [{ Name: "group-id", Values: securityGroupIds }],
    }));
    if ((out.NetworkInterfaces ?? []).length === 0) return;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  // Não trava o teardown se sobrar ENI — o delete do SG apenas falhará e a reconciliação repete.
}

/** Varredura final por tag: retorna ARNs ainda presentes (RGTA não cobre IAM). */
export async function sweepRemaining(creds: ResolvedAwsCredentials, deploymentId: string): Promise<string[]> {
  const client = new ResourceGroupsTaggingAPIClient({ region: creds.region, credentials: creds.credentials });
  const found: string[] = [];
  let token: string | undefined;
  do {
    const out = await client.send(new GetResourcesCommand({
      TagFilters: [{ Key: "zentriz:deployment_id", Values: [deploymentId] }],
      PaginationToken: token,
    }));
    for (const m of out.ResourceTagMappingList ?? []) if (m.ResourceARN) found.push(m.ResourceARN);
    token = out.PaginationToken || undefined;
  } while (token);
  return found;
}

export interface TeardownResult {
  ok: boolean;
  remaining: string[];
  errors: string[];
}

/**
 * Destrói tudo de um deployment. Marca DESTROYING → (drivers reversos) → DESTROYED.
 * Se sobrar recurso na varredura, mantém DESTROY_FAILED para a reconciliação repetir.
 */
export async function teardownDeployment(deploymentId: string): Promise<TeardownResult> {
  const row = await getFullDeployment(deploymentId);
  if (!row) return { ok: true, remaining: [], errors: [] }; // já removido do DB

  await setStatus(deploymentId, "destroying");
  const creds = await resolveAwsCredentials({ tenantId: row.tenant_id, deploymentId });
  const ctx: ProvisionContext = {
    deploymentId, projectId: row.project_id, tenantId: row.tenant_id,
    runtimeTarget: row.runtime_target, klass: row.class,
    ecrRepoUri: row.ecr_repo_uri, imageTag: row.image_tag,
    creds, scratch: scratchFromRow(row),
  };

  const errors: string[] = [];
  const reverse = [...CHAIN_ORDER].reverse();
  for (const key of reverse) {
    const driver = getDriver(key);
    if (!driver?.teardown) continue;
    try {
      await driver.teardown(ctx);
      // Entre ecs e networking: drenar ENIs antes de apagar SGs.
      if (key === "ecs") {
        await drainNetworkInterfaces(creds, (row.security_group_ids ?? []).filter(Boolean));
      }
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Marca recursos vivos do ledger como deletados (best-effort).
  try {
    for (const r of await listLiveResources(deploymentId)) {
      if (r.status !== "deleted") await markResourceDeleted(r.id).catch(() => {});
    }
  } catch { /* segue */ }

  // Varredura final por tag.
  let remaining: string[] = [];
  try { remaining = await sweepRemaining(creds, deploymentId); } catch { /* RGTA best-effort */ }

  if (remaining.length === 0 && errors.length === 0) {
    await setStatus(deploymentId, "destroyed");
    return { ok: true, remaining: [], errors: [] };
  }
  await setStatus(deploymentId, "destroy_failed", `teardown incompleto: ${errors.join("; ")}`.slice(0, 900));
  return { ok: false, remaining, errors };
}
