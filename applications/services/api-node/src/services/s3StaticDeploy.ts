/**
 * s3StaticDeploy.ts — FT-17 orchestrator do lado da API.
 *
 * A API cria a row 'provisioning' no DB e delega o build+upload ao full-test-server.
 * Callback do full-test-server (POST /api/projects/:id/deploy/ephemeral/:did/callback)
 * atualiza status → 'running' | 'failed'.
 *
 * IMPORTANTE: aqui NÃO builda nem faz upload. Só orquestra.
 */
import { pool } from "../db/client.js";
import { detectStaticProject, type DetectionResult } from "./staticDetector.js";
import { generateBucketName, isS3Configured } from "./s3.js";
import { join } from "node:path";

export interface S3StaticDeployResult {
  deploymentId: string;
  provider: "s3-static";
  status: "provisioning";
  bucketName: string;
  ttlDays: number;
  expiresAt: string;
}

export interface S3StaticDeployReject {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type S3StaticDeployOutcome =
  | { ok: true; result: S3StaticDeployResult }
  | S3StaticDeployReject;

export interface DeployRequest {
  projectId: string;
  tenantId: string;
  consentedByUserId: string;
  ttlDays?: number;
}

const FTS_URL = () => (process.env.FULL_TEST_SERVER_URL ?? "http://host.docker.internal:7878").trim();
const PROJECT_FILES_ROOT = () => (process.env.PROJECT_FILES_ROOT ?? "/project-files").trim();
const HOST_PROJECT_FILES_ROOT = () => (process.env.HOST_PROJECT_FILES_ROOT ?? "/opt/genesis-files").trim();

/**
 * Deploy orquestrador: valida elegibilidade, cria row DB, dispara full-test-server.
 * Retorna 202 imediato — o build é assíncrono.
 */
export async function deployS3Static(req: DeployRequest): Promise<S3StaticDeployOutcome> {
  const ttlDays = Math.min(Number(req.ttlDays ?? process.env.S3_STATIC_TTL_DAYS ?? "7"), 30);

  if (!isS3Configured()) {
    return {
      ok: false,
      code: "S3_NOT_CONFIGURED",
      message: "Deploy S3 não está configurado no servidor. Contate o administrador.",
    };
  }

  // Detectar tipo do projeto
  // NOTE: no api container, PROJECT_FILES_ROOT = /project-files (bind mount).
  //       No host, HOST_PROJECT_FILES_ROOT = /opt/genesis-files.
  //       O staticDetector roda dentro do container api → usa /project-files.
  const projectDir = join(PROJECT_FILES_ROOT(), req.projectId);
  const appsDir = join(projectDir, "apps");

  let detection: DetectionResult;
  try {
    detection = await detectStaticProject(appsDir);
  } catch (err) {
    return {
      ok: false,
      code: "DETECT_ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!detection.eligible) {
    return {
      ok: false,
      code: detection.code ?? "BUILD_INCOMPATIBLE",
      message: detection.reasons.join(" · ") || "App não é elegível para deploy estático",
      details: { ...detection.details, reasons: detection.reasons, type: detection.type },
    };
  }

  const client = await pool.connect();
  let deploymentId: string;
  let bucketName: string;

  try {
    // Idempotência: já existe deployment ativo?
    const existing = await client.query<{ id: string; bucket_name: string | null; app_url: string | null; expires_at: Date }>(
      `SELECT id, bucket_name, app_url, expires_at
         FROM ephemeral_deployments
        WHERE project_id = $1
          AND status IN ('provisioning', 'running', 'running_degraded')
        LIMIT 1`,
      [req.projectId],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        ok: true,
        result: {
          deploymentId: row.id,
          provider: "s3-static",
          status: "provisioning",
          bucketName: row.bucket_name ?? "",
          ttlDays,
          expiresAt: row.expires_at.toISOString(),
        },
      };
    }

    bucketName = generateBucketName(req.projectId);
    const expiresAt = new Date(Date.now() + ttlDays * 86400_000);

    // INSERT com UNIQUE INDEX parcial protege contra race
    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO ephemeral_deployments
         (project_id, tenant_id, provider, status, ttl_minutes, ttl_days,
          expires_at, bucket_name, deployment_type, consented_by, consented_at,
          error_msg)
       VALUES ($1, $2, 's3-static', 'provisioning', $3, $4, $5, $6, $7, $8, now(), 'installing')
       RETURNING id`,
      [
        req.projectId,
        req.tenantId,
        ttlDays * 24 * 60, // ttl_minutes para retrocompat
        ttlDays,
        expiresAt,
        bucketName,
        detection.type,
        req.consentedByUserId,
      ],
    );
    deploymentId = insertRes.rows[0].id;
  } catch (err) {
    // UNIQUE INDEX violation = race
    const msg = err instanceof Error ? err.message : String(err);
    if (/uq_ephemeral_active_per_project/.test(msg)) {
      return {
        ok: false,
        code: "DEPLOYMENT_IN_PROGRESS",
        message: "Já existe um deployment em progresso para este projeto",
      };
    }
    throw err;
  } finally {
    client.release();
  }

  // Dispara full-test-server (assíncrono — não bloqueia)
  const hostProjectDir = join(HOST_PROJECT_FILES_ROOT(), req.projectId);
  const payload = {
    project_id: req.projectId,
    tenant_id: req.tenantId,
    project_dir: hostProjectDir,
    deployment_id: deploymentId,
    bucket_name: bucketName,
    deployment_type: detection.type,
    ttl_days: ttlDays,
    warnings: detection.warnings,
    // Callback vem do full-test-server (host, fora do Docker network) — precisa ser URL alcançável do host.
    // Prioridade: GENESIS_PUBLIC_URL (produção HTTPS) > CALLBACK_BASE_URL > host.docker.internal em dev.
    genesis_api_url:
      process.env.GENESIS_PUBLIC_URL ??
      process.env.CALLBACK_BASE_URL ??
      "http://host.docker.internal:3000",
    genesis_token: process.env.GENESIS_API_TOKEN ?? "",
    aws_s3_access_key_id: process.env.AWS_S3_DEPLOY_ACCESS_KEY_ID ?? "",
    aws_s3_secret_access_key: process.env.AWS_S3_DEPLOY_SECRET_ACCESS_KEY ?? "",
    aws_s3_region: process.env.AWS_S3_DEPLOY_REGION ?? "us-east-1",
  };

  try {
    // Fire-and-forget via fetch nativo do Node 20+ (container api não tem curl)
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(`${FTS_URL()}/launch-s3-deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!resp.ok) {
      const txt = await resp.text().catch(() => resp.statusText);
      throw new Error(`full-test-server returned ${resp.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    // Falha ao acionar full-test-server → marca failed
    await pool.query(
      `UPDATE ephemeral_deployments SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2`,
      [`launch failed: ${err instanceof Error ? err.message : String(err)}`, deploymentId],
    );
    return {
      ok: false,
      code: "LAUNCH_FAILED",
      message: "Não foi possível acionar o build server. Tente novamente.",
    };
  }

  return {
    ok: true,
    result: {
      deploymentId,
      provider: "s3-static",
      status: "provisioning",
      bucketName,
      ttlDays,
      expiresAt: new Date(Date.now() + ttlDays * 86400_000).toISOString(),
    },
  };
}
