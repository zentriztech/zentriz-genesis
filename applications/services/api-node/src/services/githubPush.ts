/**
 * githubPush — Triggered when a tenant accepts a project.
 *
 * Flow:
 * 1. Check tenant has GitHub App installed
 * 2. Idempotency check: skip if project_github_repos already exists
 * 3. Create repository (private, auto_init=true)
 * 4. Ensure 3 branches: main, staging, dev
 * 5. Push all apps/ files to branch "dev"
 * 6. If tenant has cloud connection: sync GitHub Secrets + push deploy workflow
 * 7. Save to project_github_repos
 * 8. Add dialogue entry so portal shows the repo link
 */

import { pool } from "../db/client.js";
import { syncSecretsToGitHub, getCloudConnection } from "./cloudConnector.js";
import {
  createRepository,
  ensureThreeBranches,
  pushProjectFiles,
} from "./github.js";
import { notifyTelegramTenant } from "../routes/telegram.js";

const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/shared/uploads").trim();
// #60: base URL do Deadpool para registrar o vínculo projeto-deployado → código-fonte.
// Vazio = integração desligada (skip silencioso; nunca falha o push).
const DEADPOOL_BASE_URL = (process.env.DEADPOOL_BASE_URL ?? "").trim().replace(/\/+$/, "");
const DEADPOOL_API_TOKEN = (process.env.DEADPOOL_API_TOKEN ?? "").trim();

/** Slug determinístico (lowercase, sem sufixo) — casa com o systemId/serviceId do envelope Connect. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Slugify project title to a valid GitHub repo name
function toRepoName(title: string): string {
  const base = slugify(title).slice(0, 50);
  // Append short random suffix to avoid collisions
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "genesis-project"}-${suffix}`;
}

/**
 * #60 — Registra o vínculo (systemId, serviceId) → repo_url no Deadpool, para que o
 * plano de sustainment consiga clonar o código-fonte do projeto deployado.
 * Out-of-band, best-effort: NUNCA lança (não pode falhar o aceite/push). O Genesis é
 * quem detém repo_url + installation_id no momento da criação do repositório.
 */
async function registerProjectWithDeadpool(args: {
  systemId: string;
  serviceId: string | null;
  repoUrl: string;
  installationId: number | string;
}): Promise<void> {
  if (!DEADPOOL_BASE_URL) return; // integração desligada
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (DEADPOOL_API_TOKEN) headers["Authorization"] = `Bearer ${DEADPOOL_API_TOKEN}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${DEADPOOL_BASE_URL}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          systemId: args.systemId,
          serviceId: args.serviceId,
          repoUrl: args.repoUrl,
          installationId: String(args.installationId),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[GitHubPush] Deadpool register-project returned ${res.status} (non-fatal)`);
      } else {
        console.log(`[GitHubPush] ✓ registered ${args.systemId}/${args.serviceId ?? "*"} with Deadpool`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn("[GitHubPush] Deadpool register-project failed (non-fatal):", err);
  }
}

export async function pushProjectToGitHub(projectId: string): Promise<void> {
  const client = await pool.connect();
  try {
    // ── 1. Load project + tenant ──────────────────────────────────────────────
    const projRes = await client.query(
      `SELECT p.id, p.title, p.tenant_id, p.created_by, p.product_id,
              pr.name AS product_name, pr.system_id AS product_system_id,
              gi.installation_id, gi.github_login, gi.installation_type
       FROM projects p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
       WHERE p.id = $1`,
      [projectId],
    );
    const row = projRes.rows[0];
    if (!row) { console.warn(`[GitHubPush] Project ${projectId} not found`); return; }
    if (!row.installation_id) {
      console.log(`[GitHubPush] Tenant has no GitHub App installation — skipping`);
      // #59: never fail silently — surface WHY no repo was created so the portal/tenant sees it.
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, `⚠️ Repositório GitHub não criado: o tenant ainda não instalou o GitHub App da Zentriz. Instale o App (Settings → Integrações) e reprocesse o projeto para publicar o código.`],
      );
      return;
    }

    // ── 2. Idempotency ────────────────────────────────────────────────────────
    const existing = await client.query(
      "SELECT repo_url FROM project_github_repos WHERE project_id = $1",
      [projectId],
    );
    if (existing.rows.length > 0) {
      console.log(`[GitHubPush] Repo already exists for ${projectId}: ${existing.rows[0].repo_url}`);
      return;
    }

    const installationId = row.installation_id as number;
    const owner = row.github_login as string;
    const repoName = toRepoName((row.title as string) ?? "genesis-project");

    console.log(`[GitHubPush] Creating repo ${owner}/${repoName} for project ${projectId}`);

    // ── 3. Create repo ────────────────────────────────────────────────────────
    const { url: repoUrl, fullName } = await createRepository(installationId, {
      org: row.installation_type === "Organization" ? owner : undefined,
      name: repoName,
      description: `Generated by Zentriz Genesis — ${row.title ?? projectId}`,
      private: true,
      autoInit: true,
    });

    // ── 4. 3 branches ─────────────────────────────────────────────────────────
    await ensureThreeBranches(installationId, owner, repoName);

    // ── 5. Push files to dev ──────────────────────────────────────────────────
    const { sha: shaDevResult, fileCount } = await pushProjectFiles(
      installationId, owner, repoName, "dev",
      PROJECT_FILES_ROOT, projectId,
    );

    // ── 6. Cloud connection: sync secrets + push deploy workflow ──────────────
    let deployMsg = "";
    try {
      const tenantId = row.tenant_id as string;
      const cloudConn = await getCloudConnection(tenantId);
      if (cloudConn) {
        const { synced, provider } = await syncSecretsToGitHub(
          tenantId, owner, repoName, installationId,
        );
        deployMsg = ` | ${provider.toUpperCase()} secrets synced (${synced})`;
        console.log(`[GitHubPush] Cloud secrets synced: ${synced} secrets for ${provider}`);

        // Push deploy workflow to the repo
        const { commitAndPush } = await import("./github.js");
        const workflowContent = getDeployWorkflow(cloudConn.provider, repoName);
        if (workflowContent) {
          await commitAndPush(installationId, {
            owner, repo: repoName, branch: "dev",
            message: `ci: add ${cloudConn.provider} deploy workflow (generated by Genesis)`,
            files: [{ path: ".github/workflows/deploy.yml", content: workflowContent }],
          });
          deployMsg += " | deploy.yml committed";
        }
      }
    } catch (cloudErr) {
      console.warn("[GitHubPush] Cloud connector step failed (non-fatal):", cloudErr);
    }

    // ── 7. Save to DB ─────────────────────────────────────────────────────────
    const cloneUrl = repoUrl;
    await client.query(
      `INSERT INTO project_github_repos
         (project_id, repo_name, repo_full_name, repo_url, clone_url, default_branch, pushed_at, sha_dev)
       VALUES ($1, $2, $3, $4, $5, 'main', now(), $6)
       ON CONFLICT (project_id) DO UPDATE
         SET pushed_at = now(), sha_dev = $6`,
      [projectId, repoName, fullName, `https://github.com/${fullName}`, cloneUrl, shaDevResult],
    );

    // ── 7b. Registrar vínculo com o Deadpool (#60) ────────────────────────────
    // systemId canônico do manifesto (product.systemId, ex.: "zvoices") quando presente;
    // senão slug do nome do produto; para projeto standalone, slug do título.
    // serviceId = slug do título do projeto (dentro do produto). Casam com o
    // systemId/serviceId do envelope Connect que o Deadpool consome.
    const canonicalSystemId = (row.product_system_id as string | null)?.trim();
    const systemId = canonicalSystemId
      || (row.product_name ? slugify(row.product_name as string) : slugify((row.title as string) ?? projectId));
    const serviceId = (canonicalSystemId || row.product_name) ? slugify((row.title as string) ?? projectId) : null;
    await registerProjectWithDeadpool({
      systemId,
      serviceId,
      repoUrl: `https://github.com/${fullName}`,
      installationId,
    });

    // ── 8. Dialogue entry ─────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
       VALUES ($1, 'system', 'system', 'step', $2)`,
      [projectId, `Repositório GitHub criado: https://github.com/${fullName} — ${fileCount} arquivos enviados para branch dev${deployMsg}.`],
    );

    console.log(`[GitHubPush] ✓ ${fullName} — ${fileCount} files pushed to dev (${shaDevResult.slice(0, 8)})${deployMsg}`);

    // ── 9. Telegram (best-effort, nunca bloqueia) ─────────────────────────────
    if (row.tenant_id) {
      notifyTelegramTenant(
        row.tenant_id,
        `🐙 Repositório GitHub criado para *${row.title}*\nhttps://github.com/${fullName}`,
      ).catch(() => {});
    }
  } catch (err) {
    console.error(`[GitHubPush] Failed for project ${projectId}:`, err);
    // Fire-and-forget: never throw — must not fail the accept request.
    // #59: but never swallow silently — record WHY so the portal/tenant sees the failure.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      // #59: 403 "Resource not accessible by integration" ao criar repo em org = o GitHub App
      // não tem a permissão de REPOSITÓRIO "Administration: Read & write" (distinta de
      // "Organization administration"). É configuração do App (dono aprova), não erro de código.
      const hint =
        status === 403 || /not accessible by integration/i.test(msg)
          ? " → O GitHub App precisa da permissão de repositório 'Administration: Read & write' (Settings do App → Permissions → Repository → Administration), e o proprietário da organização deve aprovar a nova permissão na instalação."
          : "";
      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [projectId, `⚠️ Falha ao criar o repositório GitHub: ${msg}. O projeto foi aceito, mas o código ainda não foi publicado.${hint}`],
      );
    } catch (dialogueErr) {
      console.error(`[GitHubPush] Could not record failure dialogue for ${projectId}:`, dialogueErr);
    }
  } finally {
    client.release();
  }
}

// ── Deploy workflow templates ─────────────────────────────────────────────────

function getDeployWorkflow(provider: "aws" | "azure" | "gcp", repoName: string): string | null {
  if (provider === "aws") {
    return `name: Deploy to AWS ECS
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ secrets.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push image
        run: |
          IMAGE_URI=\${{ secrets.AWS_ECR_REGISTRY }}/${repoName}:\${{ github.sha }}
          docker build -t $IMAGE_URI apps/
          docker push $IMAGE_URI
      - name: Force new ECS deployment
        run: |
          aws ecs update-service \\
            --cluster \${{ secrets.AWS_ECS_CLUSTER }} \\
            --service ${repoName} \\
            --force-new-deployment \\
            --region \${{ secrets.AWS_REGION }}
`;
  }
  if (provider === "azure") {
    return `name: Deploy to Azure Container Apps
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          creds: \${{ secrets.AZURE_CREDENTIALS }}
      - name: Build and push to ACR
        run: |
          ACR=$(az acr list -g \${{ secrets.AZURE_RESOURCE_GROUP }} --query "[0].loginServer" -o tsv)
          az acr build --registry $ACR --image ${repoName}:\${{ github.sha }} apps/
      - name: Update Container App
        run: |
          ACR=$(az acr list -g \${{ secrets.AZURE_RESOURCE_GROUP }} --query "[0].loginServer" -o tsv)
          az containerapp update \\
            --name \${{ secrets.AZURE_CONTAINER_APP }} \\
            --resource-group \${{ secrets.AZURE_RESOURCE_GROUP }} \\
            --image $ACR/${repoName}:\${{ github.sha }}
`;
  }
  if (provider === "gcp") {
    return `name: Deploy to GCP Cloud Run
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: \${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
      - name: Build and push image
        run: |
          gcloud auth configure-docker gcr.io --quiet
          docker build -t gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }} apps/
          docker push gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }}
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy ${repoName} \\
            --image gcr.io/\${{ secrets.GCP_PROJECT_ID }}/${repoName}:\${{ github.sha }} \\
            --region \${{ secrets.GCP_REGION }} \\
            --platform managed \\
            --allow-unauthenticated \\
            --project \${{ secrets.GCP_PROJECT_ID }}
`;
  }
  return null;
}
