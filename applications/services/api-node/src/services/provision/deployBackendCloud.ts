/**
 * deployBackendCloud.ts — G1-T12 (Fase C). O análogo de s3StaticDeploy para BACKEND.
 *
 * Orquestra o lado da API (não builda nem chama a AWS diretamente aqui):
 *   1. valida elegibilidade (project_type resolve p/ backend; repo GitHub presente)
 *   2. resolve credencial via AwsCredentialProvider (seam G1-T1)
 *   3. cria row backend_deployments PROVISIONING (write-ahead, idempotente)
 *   4. dispara o full-test-server /launch-backend-deploy (host: clone+build+push ECR)
 *   5. retorna 202 imediato
 *
 * A cadeia SDK (iam→networking→rds→ecs→alb...) roda no callback 'pushed' (runProvisionChain).
 */

import { pool } from "../../db/client.js";
import { getInstallationTokenForClone } from "../github.js";
import { resolveAwsCredentials } from "./awsCredentials.js";
import { resolveRuntimeTarget } from "./backendDeployDetector.js";
import { createOrGetActiveDeployment, setStatus, patchDeployment } from "./backendState.js";

export interface BackendDeployResult {
  deploymentId: string;
  provider: "aws";
  status: string;
  runtimeTarget: string;
  ecrRepoName: string;
}

export interface BackendDeployReject { ok: false; code: string; message: string; details?: Record<string, unknown>; }
export type BackendDeployOutcome = { ok: true; result: BackendDeployResult; reused: boolean } | BackendDeployReject;

export interface BackendDeployRequest {
  projectId: string;
  tenantId: string;
  projectType: string | null;
  extraTarget: string | null;
}

const FTS_URL = () => (process.env.FULL_TEST_SERVER_URL ?? "http://host.docker.internal:7878").trim();

/** Nome determinístico do repositório ECR — 1 repo por projeto (segundo run reusa). */
export function ecrRepoName(projectId: string): string {
  return `genesis/${projectId}`;
}

export async function deployBackendCloud(req: BackendDeployRequest): Promise<BackendDeployOutcome> {
  // 1. Elegibilidade por tipo (mesma função do dispatch — fonte única de verdade).
  const { runtimeTarget, isBackend, error } = resolveRuntimeTarget(req.projectType, req.extraTarget);
  if (error) return { ok: false, code: "INVALID_RUNTIME_TARGET", message: error };
  if (!isBackend || runtimeTarget === "s3") {
    return { ok: false, code: "NOT_BACKEND", message: "Projeto não é backend — use o caminho S3." };
  }

  // 2. Repo GitHub obrigatório (fonte de verdade do build), como no S3.
  const repoQ = await pool.query<{
    clone_url: string | null; default_branch: string | null;
    repo_full_name: string; installation_id: number | null;
  }>(
    `SELECT r.clone_url, r.default_branch, r.repo_full_name, gi.installation_id
       FROM project_github_repos r
       JOIN projects p ON p.id = r.project_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
      WHERE r.project_id = $1 LIMIT 1`,
    [req.projectId],
  );
  if (repoQ.rows.length === 0 || !repoQ.rows[0].clone_url) {
    return { ok: false, code: "REPO_REQUIRED",
      message: "Este projeto não possui repositório GitHub. Crie o repositório antes de provisionar o backend." };
  }
  const repoRow = repoQ.rows[0];
  if (!repoRow.installation_id) {
    return { ok: false, code: "GITHUB_INSTALLATION_MISSING",
      message: "Tenant não possui GitHub App instalado — não é possível autenticar o clone." };
  }

  // 3. Credencial (GATE 1 = conta Zentriz, cadeia ambient). Só valida que o seam resolve.
  const creds = await resolveAwsCredentials({ tenantId: req.tenantId, deploymentId: null });
  const repoName = ecrRepoName(req.projectId);

  // 4. Row write-ahead PROVISIONING (idempotente por projeto ativo).
  const { row, reused } = await createOrGetActiveDeployment({
    projectId: req.projectId,
    tenantId: req.tenantId,
    provider: "aws",
    runtimeTarget,
    klass: "durable",
    ecrRepoUri: null, // preenchido no callback 'pushed' com a URI real do ECR
  });
  if (reused) {
    return { ok: true, reused: true, result: {
      deploymentId: row.id, provider: "aws", status: row.status,
      runtimeTarget: row.runtime_target, ecrRepoName: repoName,
    } };
  }

  // 5. Installation token curto p/ o runner clonar (branch dev).
  let installationToken: string;
  try {
    installationToken = await getInstallationTokenForClone(repoRow.installation_id);
  } catch (err) {
    await setStatus(row.id, "failed", `installation token error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, code: "GITHUB_TOKEN_ERROR",
      message: "Não foi possível gerar token de acesso ao GitHub para clonar o repositório." };
  }

  // 6. Dispara o full-test-server (host) — build+push ECR. Fire-and-forget com timeout.
  const payload = {
    project_id: req.projectId,
    tenant_id: req.tenantId,
    deployment_id: row.id,
    ecr_repo_name: repoName,
    image_tag: row.id.slice(0, 8),
    git_clone_url: repoRow.clone_url,
    git_branch: "dev",
    git_installation_token: installationToken,
    git_repo_full_name: repoRow.repo_full_name,
    genesis_api_url:
      process.env.GENESIS_PUBLIC_URL ?? process.env.CALLBACK_BASE_URL ?? "http://host.docker.internal:3000",
    genesis_token: process.env.GENESIS_API_TOKEN ?? "",
    // GATE 1: credenciais da conta Zentriz. Preferimos as dedicadas de provisão; caem
    // no par S3 como último recurso (mesma conta). Região do seam de credencial.
    aws_access_key_id: process.env.GENESIS_PROVISION_ACCESS_KEY_ID ?? process.env.AWS_S3_DEPLOY_ACCESS_KEY_ID ?? "",
    aws_secret_access_key: process.env.GENESIS_PROVISION_SECRET_ACCESS_KEY ?? process.env.AWS_S3_DEPLOY_SECRET_ACCESS_KEY ?? "",
    aws_region: creds.region,
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(`${FTS_URL()}/launch-backend-deploy`, {
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
    await setStatus(row.id, "failed", `launch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, code: "LAUNCH_FAILED", message: "Não foi possível acionar o build server. Tente novamente." };
  }

  // Reflete a intenção de artefato (URI real vem no callback 'pushed').
  await patchDeployment(row.id, { image_tag: row.id.slice(0, 8) });

  return { ok: true, reused: false, result: {
    deploymentId: row.id, provider: "aws", status: "provisioning",
    runtimeTarget, ecrRepoName: repoName,
  } };
}
