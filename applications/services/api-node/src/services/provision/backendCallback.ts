/**
 * backendCallback.ts — G1-T12 (Fase C).
 *
 * Trata o callback do backend_deploy_runner (host) para a rota
 * POST /api/projects/:id/deploy/backend/:deploymentId/callback.
 *
 * Contrato de fases (o runner emite; a API reage):
 *   { progress: 'installing' | 'building' | 'pushing' }  → só avança o status durável
 *   { progress: 'pushed', image_uri, ecr_repo_uri, image_tag } → grava artefato e DISPARA
 *        a cadeia SDK (runProvisionChain) de forma assíncrona (não bloqueia o callback)
 *   { status: 'failed', error_code, error_msg, error_details } → marca failed
 *
 * Idempotente: repetição de 'pushed' não re-dispara a cadeia se já saiu de 'pushing'.
 */

import { pool } from "../../db/client.js";
import { setStatus, patchDeployment, type BackendStatus } from "./backendState.js";
import { runProvisionChain } from "./provisionChain.js";

export interface BackendCallbackBody {
  progress?: "installing" | "building" | "pushing" | "pushed";
  status?: "failed" | "running" | "running_degraded";
  image_uri?: string;
  ecr_repo_uri?: string;
  image_tag?: string;
  error_code?: string;
  error_msg?: string;
  error_details?: unknown;
}

export interface CallbackResult { http: number; body: Record<string, unknown>; }

const PROGRESS_TO_STATUS: Record<string, BackendStatus> = {
  installing: "provisioning",
  building: "building",
  pushing: "pushing",
};

export async function handleBackendCallback(
  projectId: string,
  deploymentId: string,
  body: BackendCallbackBody,
): Promise<CallbackResult> {
  const dep = (await pool.query<{ id: string; project_id: string; status: BackendStatus }>(
    "SELECT id, project_id, status FROM backend_deployments WHERE id=$1 AND project_id=$2",
    [deploymentId, projectId],
  )).rows[0];
  if (!dep) return { http: 404, body: { code: "DEPLOYMENT_NOT_FOUND" } };

  // Terminal: falha reportada pelo runner (build/push).
  if (body.status === "failed") {
    const errText = [
      body.error_code ? `[${body.error_code}]` : "",
      body.error_msg ?? "",
      body.error_details ? JSON.stringify(body.error_details).slice(0, 500) : "",
    ].filter(Boolean).join(" ");
    await setStatus(deploymentId, "failed", errText.slice(0, 2000));
    return { http: 200, body: { ok: true, status: "failed" } };
  }

  // Progresso terminal do runner = 'pushed' → grava artefato + dispara cadeia SDK.
  if (body.progress === "pushed") {
    await patchDeployment(deploymentId, {
      ecr_repo_uri: body.ecr_repo_uri ?? null,
      image_tag: body.image_tag ?? null,
    });
    // Só dispara a cadeia se ainda não avançou além de 'pushing' (idempotência).
    const advanced = ["migrating", "creating_service", "waiting_cert_dns", "running", "running_degraded"];
    if (!advanced.includes(dep.status)) {
      // Assíncrono: o callback retorna 200 imediato; a cadeia roda em background.
      // Erros da cadeia são absorvidos (runProvisionChain já marca 'failed' + compensa).
      const full = (await pool.query(
        `SELECT id, project_id, tenant_id, provider, runtime_target, class,
                ecr_repo_uri, image_tag, app_url, health_url, status, error_msg
           FROM backend_deployments WHERE id=$1`, [deploymentId],
      )).rows[0];
      if (full) {
        setImmediate(() => { void runProvisionChain(full).catch(() => { /* já tratado */ }); });
      }
    }
    return { http: 200, body: { ok: true, phase: "pushed" } };
  }

  // Progresso intermediário (installing/building/pushing) → avança status durável.
  if (body.progress && PROGRESS_TO_STATUS[body.progress]) {
    await setStatus(deploymentId, PROGRESS_TO_STATUS[body.progress]);
    return { http: 200, body: { ok: true, phase: body.progress } };
  }

  return { http: 400, body: { code: "INVALID_BODY", message: "progress ou status obrigatório" } };
}
