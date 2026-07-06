/**
 * backendState.ts — G1-T12 (Fase C).
 *
 * Camada de ESTADO DURÁVEL (write-ahead) do provisionamento backend. Toda mutação de
 * `backend_deployments` e do ledger `backend_deployment_resources` passa por aqui, para
 * que o teardown/saga (G1-T21) e o resume-no-boot leiam um estado consistente.
 *
 * Princípio write-ahead: registramos a INTENÇÃO de criar um recurso (com nome
 * determinístico) ANTES de chamar a AWS. Se o processo morrer no meio, o ledger já
 * sabe que aquele recurso pode existir na conta — e a compensação/reconciliação o
 * encontra pelo nome mesmo sem ARN.
 */

import type { PoolClient } from "pg";
import { pool } from "../../db/client.js";

/** Fases não-terminais que o resume-no-boot re-anexa (espelha idx_backend_resumable_status). */
export const RESUMABLE_STATUSES = [
  "provisioning", "building", "pushing", "migrating",
  "creating_service", "waiting_cert_dns", "destroying",
] as const;

/** Fases em que um deployment é considerado ATIVO (ocupa o unique index por projeto). */
export const ACTIVE_STATUSES = [
  "provisioning", "building", "pushing", "migrating",
  "creating_service", "waiting_cert_dns", "running", "running_degraded",
] as const;

export type BackendStatus =
  | "provisioning" | "building" | "pushing" | "migrating" | "creating_service"
  | "waiting_cert_dns" | "running" | "running_degraded" | "failed"
  | "destroying" | "destroy_failed" | "destroyed";

export interface BackendDeploymentRow {
  id: string;
  project_id: string;
  tenant_id: string | null;
  provider: string;
  runtime_target: string;
  class: string;
  ecr_repo_uri: string | null;
  image_tag: string | null;
  app_url: string | null;
  health_url: string | null;
  status: BackendStatus;
  error_msg: string | null;
}

export interface ResourceRow {
  id: string;
  deployment_id: string;
  resource_type: string;
  intended_name: string | null;
  arn: string | null;
  region: string | null;
  status: "pending" | "created" | "delete-requested" | "deleted" | "failed";
  detail: Record<string, unknown> | null;
  error_msg: string | null;
}

/** Busca o deployment ATIVO de um projeto (idempotência do 202). */
export async function findActiveDeployment(projectId: string): Promise<BackendDeploymentRow | null> {
  const r = await pool.query<BackendDeploymentRow>(
    `SELECT id, project_id, tenant_id, provider, runtime_target, class,
            ecr_repo_uri, image_tag, app_url, health_url, status, error_msg
       FROM backend_deployments
      WHERE project_id = $1 AND status = ANY($2)
      LIMIT 1`,
    [projectId, ACTIVE_STATUSES as unknown as string[]],
  );
  return r.rows[0] ?? null;
}

export interface CreateDeploymentInput {
  projectId: string;
  tenantId: string | null;
  provider?: string;
  runtimeTarget: string;
  klass?: "durable" | "demo";
  ecrRepoUri?: string | null;
  imageTag?: string | null;
}

/**
 * Cria a row write-ahead PROVISIONING. Idempotente: se já existe deployment ativo
 * para o projeto (unique index parcial), devolve o existente sem duplicar.
 * O segundo POST /deploy cai aqui e reusa.
 */
export async function createOrGetActiveDeployment(
  input: CreateDeploymentInput,
): Promise<{ row: BackendDeploymentRow; reused: boolean }> {
  const existing = await findActiveDeployment(input.projectId);
  if (existing) return { row: existing, reused: true };

  const client = await pool.connect();
  try {
    const ins = await client.query<BackendDeploymentRow>(
      `INSERT INTO backend_deployments
         (project_id, tenant_id, provider, runtime_target, class, status,
          ecr_repo_uri, image_tag, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'provisioning', $6, $7, NULL)
       RETURNING id, project_id, tenant_id, provider, runtime_target, class,
                 ecr_repo_uri, image_tag, app_url, health_url, status, error_msg`,
      [
        input.projectId, input.tenantId, input.provider ?? "aws",
        input.runtimeTarget, input.klass ?? "durable",
        input.ecrRepoUri ?? null, input.imageTag ?? null,
      ],
    );
    return { row: ins.rows[0], reused: false };
  } catch (err) {
    // Race no unique index parcial → outro request criou ao mesmo tempo; reusa.
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_backend_active_per_project/.test(msg)) {
      const again = await findActiveDeployment(input.projectId);
      if (again) return { row: again, reused: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Transição de status (com error_msg opcional). Nunca sai de estado terminal. */
export async function setStatus(
  deploymentId: string,
  status: BackendStatus,
  errorMsg?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE backend_deployments
        SET status = $2,
            error_msg = COALESCE($3, error_msg),
            destroyed_at = CASE WHEN $2 = 'destroyed' THEN now() ELSE destroyed_at END,
            updated_at = now()
      WHERE id = $1
        AND status NOT IN ('destroyed')`,
    [deploymentId, status, errorMsg ?? null],
  );
}

/** Grava campos de resultado/artefato (URL, ARNs de topo, etc.). Campos allow-list. */
const PATCHABLE = new Set([
  "ecr_repo_uri", "image_tag", "cluster_arn", "task_def_arn", "service_arn",
  "migrate_task_arn", "vpc_id", "target_group_arn", "alb_arn", "listener_arn",
  "rds_arn", "rds_endpoint", "db_subnet_group", "secret_arn", "kms_cmk_arn",
  "acm_cert_arn", "route53_record", "iam_role_path", "log_group", "budget_arn",
  "cost_estimate_hourly", "app_url", "health_url",
]);
const PATCHABLE_ARRAY = new Set(["subnet_ids", "security_group_ids"]);

export async function patchDeployment(
  deploymentId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [deploymentId];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (PATCHABLE.has(k) || PATCHABLE_ARRAY.has(k)) {
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return;
  await pool.query(
    `UPDATE backend_deployments SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    vals,
  );
}

// ── Ledger de recursos (backend_deployment_resources) ────────────────────────

/**
 * Write-ahead de um recurso: grava a INTENÇÃO (pending) com nome determinístico
 * ANTES da chamada AWS. Idempotente por (deployment_id, resource_type, intended_name)
 * — o unique index deixa o describe-before-create seguro no re-run.
 * Retorna o id da linha do ledger.
 */
export async function recordResourceIntent(
  deploymentId: string,
  resourceType: string,
  intendedName: string,
  region: string | null,
  detail?: Record<string, unknown>,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO backend_deployment_resources
       (deployment_id, resource_type, intended_name, region, status, detail)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (deployment_id, resource_type, intended_name)
       DO UPDATE SET updated_at = now()
     RETURNING id`,
    [deploymentId, resourceType, intendedName, region, detail ? JSON.stringify(detail) : null],
  );
  return r.rows[0].id;
}

/** Marca um recurso como criado, gravando o ARN/ID real. */
export async function markResourceCreated(
  resourceId: string,
  arn: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE backend_deployment_resources
        SET status = 'created', arn = $2,
            detail = COALESCE($3, detail), updated_at = now()
      WHERE id = $1`,
    [resourceId, arn, detail ? JSON.stringify(detail) : null],
  );
}

export async function markResourceFailed(resourceId: string, errorMsg: string): Promise<void> {
  await pool.query(
    `UPDATE backend_deployment_resources
        SET status = 'failed', error_msg = $2, updated_at = now()
      WHERE id = $1`,
    [resourceId, errorMsg.slice(0, 1000)],
  );
}

export async function markResourceDeleted(resourceId: string): Promise<void> {
  await pool.query(
    `UPDATE backend_deployment_resources
        SET status = 'deleted', updated_at = now() WHERE id = $1`,
    [resourceId],
  );
}

/**
 * Recursos VIVOS (created/pending/delete-requested) de um deployment, ordenados por
 * criação — a compensação saga percorre em ordem REVERSA para desfazer.
 */
export async function listLiveResources(
  deploymentId: string,
  client?: PoolClient,
): Promise<ResourceRow[]> {
  const q = client ?? pool;
  const r = await q.query<ResourceRow>(
    `SELECT id, deployment_id, resource_type, intended_name, arn, region, status, detail, error_msg
       FROM backend_deployment_resources
      WHERE deployment_id = $1 AND status IN ('pending','created','delete-requested','failed')
      ORDER BY created_at ASC`,
    [deploymentId],
  );
  return r.rows;
}

/** Recurso já criado de um tipo (describe-before-create no re-run). */
export async function findCreatedResource(
  deploymentId: string,
  resourceType: string,
): Promise<ResourceRow | null> {
  const r = await pool.query<ResourceRow>(
    `SELECT id, deployment_id, resource_type, intended_name, arn, region, status, detail, error_msg
       FROM backend_deployment_resources
      WHERE deployment_id = $1 AND resource_type = $2 AND status = 'created'
      LIMIT 1`,
    [deploymentId, resourceType],
  );
  return r.rows[0] ?? null;
}

/** Deployments em fases não-terminais — usados pelo resume-no-boot. */
export async function listResumableDeployments(): Promise<BackendDeploymentRow[]> {
  const r = await pool.query<BackendDeploymentRow>(
    `SELECT id, project_id, tenant_id, provider, runtime_target, class,
            ecr_repo_uri, image_tag, app_url, health_url, status, error_msg
       FROM backend_deployments
      WHERE status = ANY($1)`,
    [RESUMABLE_STATUSES as unknown as string[]],
  );
  return r.rows;
}

/** Row completo com todos os ARNs/ids de infra — usado pelo teardown p/ reconstruir o contexto. */
export interface FullDeploymentRow extends BackendDeploymentRow {
  cluster_arn: string | null;
  service_arn: string | null;
  target_group_arn: string | null;
  alb_arn: string | null;
  vpc_id: string | null;
  subnet_ids: string[] | null;
  security_group_ids: string[] | null;
  rds_arn: string | null;
  secret_arn: string | null;
  acm_cert_arn: string | null;
  route53_record: string | null;
  iam_role_path: string | null;
}

export async function getFullDeployment(deploymentId: string): Promise<FullDeploymentRow | null> {
  const r = await pool.query<FullDeploymentRow>(
    `SELECT id, project_id, tenant_id, provider, runtime_target, class,
            ecr_repo_uri, image_tag, app_url, health_url, status, error_msg,
            cluster_arn, service_arn, target_group_arn, alb_arn, vpc_id,
            subnet_ids, security_group_ids, rds_arn, secret_arn, acm_cert_arn,
            route53_record, iam_role_path
       FROM backend_deployments WHERE id = $1`,
    [deploymentId],
  );
  return r.rows[0] ?? null;
}

/** Deployments marcados p/ destruição (worker de cleanup / resume-no-boot). */
export async function listDeploymentsForTeardown(): Promise<BackendDeploymentRow[]> {
  const r = await pool.query<BackendDeploymentRow>(
    `SELECT id, project_id, tenant_id, provider, runtime_target, class,
            ecr_repo_uri, image_tag, app_url, health_url, status, error_msg
       FROM backend_deployments
      WHERE status IN ('destroying','failed')
        AND EXISTS (
          SELECT 1 FROM backend_deployment_resources r
           WHERE r.deployment_id = backend_deployments.id
             AND r.status IN ('pending','created','delete-requested','failed')
        )`,
  );
  return r.rows;
}
