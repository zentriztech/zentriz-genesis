import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { pool } from "../db/client.js";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "";
const GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID ?? "";
const GITHUB_APP_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET ?? "";

// AES-256-CBC key from env — must be 32 bytes (64 hex chars)
const ENCRYPTION_KEY = Buffer.from((process.env.ENCRYPTION_KEY ?? "").padEnd(64, "0").slice(0, 64), "hex");
const IV_LENGTH = 16;

// Limite de blobs criados em paralelo. `Promise.all(batch.map(createBlob))` disparava
// até 80 requisições simultâneas — em projetos grandes (ex.: mobile RN CLI) isso estoura
// o SECONDARY RATE LIMIT do GitHub (403 em /git/blobs, sem retry-after útil). Um teto baixo
// de concorrência + retry com backoff resolve sem quebrar o push de projetos grandes.
const BLOB_CONCURRENCY = 6;

/** Executa `fn` sobre `items` preservando a ordem, com no máximo `limit` execuções simultâneas. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Cria um blob com retry em rate-limit. GitHub sinaliza secondary rate limit com 403
 * (às vezes 429) + possíveis headers `retry-after` / `x-ratelimit-remaining=0`. Fazemos
 * backoff exponencial (respeitando retry-after quando presente) antes de desistir.
 */
async function createBlobWithRetry(
  octokit: Octokit,
  owner: string,
  repo: string,
  contentBase64: string,
): Promise<string> {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data: blob } = await octokit.git.createBlob({ owner, repo, content: contentBase64, encoding: "base64" });
      return blob.sha;
    } catch (err: unknown) {
      const e = err as { status?: number; response?: { headers?: Record<string, string> } };
      const status = e.status;
      const headers = e.response?.headers ?? {};
      const isRateLimit =
        status === 429 ||
        (status === 403 && (headers["retry-after"] != null || headers["x-ratelimit-remaining"] === "0" ||
          /rate limit|abuse|secondary/i.test(String((err as { message?: string }).message ?? ""))));
      if (!isRateLimit || attempt === maxAttempts - 1) throw err;
      const retryAfter = Number(headers["retry-after"]);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * Math.pow(2, attempt), 30_000);
      console.log(`[GitHub] createBlob rate-limited (status ${status}) — retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error("createBlob: esgotou retries de rate-limit");
}

export function encryptText(text: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptText(encrypted: string): string {
  const [ivHex, dataHex] = encrypted.split(":");
  if (!ivHex || !dataHex) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

export type GitHubInstallationInfo = {
  installationId: number;
  githubLogin: string;
  installationType: "Organization" | "User";
  reposAuthorized: "all" | "selected";
  selectedRepos: string[];
};

// FT-12: tenant-level app config — resolved before env fallback
interface TenantAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

async function _getTenantAppConfig(installationId: number): Promise<TenantAppConfig | null> {
  try {
    const res = await pool.query(
      `SELECT app_id, private_key_encrypted, app_client_id, app_client_secret
       FROM tenant_github_installations
       WHERE installation_id = $1 AND app_id IS NOT NULL AND private_key_encrypted IS NOT NULL
       LIMIT 1`,
      [installationId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0] as Record<string, unknown>;
    return {
      appId:        String(row.app_id ?? ""),
      privateKey:   decryptText(String(row.private_key_encrypted ?? "")),
      clientId:     String(row.app_client_id ?? ""),
      clientSecret: row.app_client_secret ? decryptText(String(row.app_client_secret)) : "",
    };
  } catch {
    return null; // column may not exist yet (migration pending) — fallback to env
  }
}

/** Reads global private key from env (lazy, file or inline). */
function _getGlobalPrivateKey(): string {
  const filePath = process.env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (filePath) {
    try {
      return readFileSync(filePath, "utf-8").trim();
    } catch (err) {
      throw new Error(`Cannot read GitHub App private key from ${filePath}: ${err}`);
    }
  }
  return process.env.GITHUB_APP_PRIVATE_KEY ?? "";
}

function isGlobalAppConfigured(): boolean {
  if (!GITHUB_APP_ID) return false;
  const keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  return Boolean(keyFile || keyInline);
}

/**
 * FT-12: Returns an authenticated Octokit for an installation.
 * Priority: (1) tenant app_id + private_key from DB, (2) global env App, (3) PAT fallback.
 */
async function getOctokitForInstallation(installationId: number): Promise<Octokit> {
  // 1. Try tenant-specific GitHub App
  const tenantCfg = await _getTenantAppConfig(installationId);
  if (tenantCfg?.appId && tenantCfg?.privateKey) {
    const auth = createAppAuth({
      appId:        tenantCfg.appId,
      privateKey:   tenantCfg.privateKey,
      clientId:     tenantCfg.clientId || undefined,
      clientSecret: tenantCfg.clientSecret || undefined,
    });
    const { token } = await auth({ type: "installation", installationId });
    return new Octokit({ auth: token });
  }

  // 2. Global App from env
  if (isGlobalAppConfigured()) {
    const auth = createAppAuth({
      appId:        GITHUB_APP_ID,
      privateKey:   _getGlobalPrivateKey(),
      clientId:     GITHUB_APP_CLIENT_ID || undefined,
      clientSecret: GITHUB_APP_CLIENT_SECRET || undefined,
    });
    const { token } = await auth({ type: "installation", installationId });
    return new Octokit({ auth: token });
  }

  // 3. PAT fallback (dev/local without App configured)
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("No GitHub credentials. Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, ENCRYPTION_KEY, or GITHUB_TOKEN.");
  return new Octokit({ auth: token });
}

/**
 * FT-17: Returns a short-lived installation token (raw string) usable for
 * `git clone https://x-access-token:<TOKEN>@github.com/...`.
 * Priority mirrors getOctokitForInstallation: tenant App → global App → PAT.
 * Token lifetime ~1h — safe for one clone operation.
 */
export async function getInstallationTokenForClone(installationId: number): Promise<string> {
  const tenantCfg = await _getTenantAppConfig(installationId);
  if (tenantCfg?.appId && tenantCfg?.privateKey) {
    const auth = createAppAuth({
      appId:        tenantCfg.appId,
      privateKey:   tenantCfg.privateKey,
      clientId:     tenantCfg.clientId || undefined,
      clientSecret: tenantCfg.clientSecret || undefined,
    });
    const { token } = await auth({ type: "installation", installationId });
    return token;
  }
  if (isGlobalAppConfigured()) {
    const auth = createAppAuth({
      appId:        GITHUB_APP_ID,
      privateKey:   _getGlobalPrivateKey(),
      clientId:     GITHUB_APP_CLIENT_ID || undefined,
      clientSecret: GITHUB_APP_CLIENT_SECRET || undefined,
    });
    const { token } = await auth({ type: "installation", installationId });
    return token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) throw new Error("No GitHub credentials for clone token.");
  return pat;
}

/**
 * FT-12: Fetches metadata about an installation directly from GitHub.
 * Accepts optional tenant-level app credentials; falls back to global env App.
 */
export async function getInstallationInfo(
  installationId: number,
  tenantAppConfig?: { appId: string; privateKey: string; clientId?: string; clientSecret?: string }
): Promise<GitHubInstallationInfo> {
  const cfg = tenantAppConfig ?? (isGlobalAppConfigured() ? {
    appId: GITHUB_APP_ID,
    privateKey: _getGlobalPrivateKey(),
    clientId: GITHUB_APP_CLIENT_ID || undefined,
    clientSecret: GITHUB_APP_CLIENT_SECRET || undefined,
  } : null);

  if (!cfg) throw new Error("GitHub App not configured.");

  const auth = createAppAuth({
    appId:        cfg.appId,
    privateKey:   cfg.privateKey,
    clientId:     cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: `Bearer ${token}` });

  const { data } = await octokit.apps.getInstallation({ installation_id: installationId });

  const account = data.account as { login?: string; type?: string } | null;
  return {
    installationId,
    githubLogin: account?.login ?? "",
    installationType: (account?.type === "Organization" ? "Organization" : "User") as "Organization" | "User",
    reposAuthorized: (data.repository_selection === "all" ? "all" : "selected") as "all" | "selected",
    selectedRepos: [],
  };
}

/**
 * Creates a new repository in the tenant's GitHub org/account.
 * Used by Genesis when starting a new project.
 */
export async function createRepository(
  installationId: number,
  opts: {
    org?: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }
): Promise<{ url: string; fullName: string }> {
  const octokit = await getOctokitForInstallation(installationId);

  let data;
  if (opts.org) {
    const res = await octokit.repos.createInOrg({
      org: opts.org,
      name: opts.name,
      description: opts.description,
      private: opts.private ?? true,
      auto_init: opts.autoInit ?? true,
    });
    data = res.data;
  } else {
    const res = await octokit.repos.createForAuthenticatedUser({
      name: opts.name,
      description: opts.description,
      private: opts.private ?? true,
      auto_init: opts.autoInit ?? true,
    });
    data = res.data;
  }

  return { url: data.clone_url, fullName: data.full_name };
}

/**
 * Commits and pushes one or more files to a repository branch.
 * Used by Genesis to store generated artifacts.
 */
export async function commitAndPush(
  installationId: number,
  opts: {
    owner: string;
    repo: string;
    branch?: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }
): Promise<{ sha: string }> {
  const octokit = await getOctokitForInstallation(installationId);
  const branch = opts.branch ?? "main";

  // Get current commit SHA for the branch
  const { data: refData } = await octokit.git.getRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: `heads/${branch}`,
  });
  const latestSha = refData.object.sha;

  // Get base tree
  const { data: commitData } = await octokit.git.getCommit({
    owner: opts.owner,
    repo: opts.repo,
    commit_sha: latestSha,
  });
  const baseTreeSha = commitData.tree.sha;

  // Create blobs and build tree (concorrência limitada + retry em rate-limit)
  const treeItems = await mapWithConcurrency(opts.files, BLOB_CONCURRENCY, async (file) => {
    const sha = await createBlobWithRetry(
      octokit, opts.owner, opts.repo, Buffer.from(file.content).toString("base64"),
    );
    return { path: file.path, mode: "100644" as const, type: "blob" as const, sha };
  });

  const { data: tree } = await octokit.git.createTree({
    owner: opts.owner,
    repo: opts.repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  const { data: commit } = await octokit.git.createCommit({
    owner: opts.owner,
    repo: opts.repo,
    message: opts.message,
    tree: tree.sha,
    parents: [latestSha],
  });

  await octokit.git.updateRef({
    owner: opts.owner,
    repo: opts.repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
  });

  return { sha: commit.sha };
}

/**
 * Creates a GitHub Actions workflow file in the repository.
 * Used by Genesis to set up CI/CD for generated projects.
 */
/**
 * Creates a branch if it does not already exist.
 * sourceBranch is the branch to copy from (defaults to "main").
 */
/**
 * Reads all files under PROJECT_FILES_ROOT/{projectId}/apps/ and pushes them
 * to the specified branch in batches of 80 (GitHub tree API limit is ~100).
 *
 * Files in node_modules/, .next/, dist/, .git/ are skipped.
 * Binary files are base64-encoded. Text files are UTF-8.
 *
 * Returns the SHA of the final commit.
 */
export async function pushProjectFiles(
  installationId: number,
  owner: string,
  repo: string,
  branch: string,
  projectFilesRoot: string,
  projectId: string,
): Promise<{ sha: string; fileCount: number }> {
  const { readdir, stat, readFile } = await import("fs/promises");
  const pathMod = await import("path");

  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", "coverage", ".nyc_output"]);
  const BATCH_SIZE = 80; // stay well under GitHub's 100-blob limit

  // Collect all file paths
  const allFiles: Array<{ relativePath: string; absolutePath: string }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = pathMod.join(dir, entry);
      let s: Awaited<ReturnType<typeof stat>>;
      try { s = await stat(full); } catch { continue; }
      if (s.isDirectory()) {
        await walk(full);
      } else if (s.size < 1_500_000) { // skip files > 1.5MB
        const appsDir = pathMod.join(projectFilesRoot, projectId, "apps");
        allFiles.push({ relativePath: pathMod.relative(appsDir, full), absolutePath: full });
      }
    }
  }

  const appsDir = pathMod.join(projectFilesRoot, projectId, "apps");
  await walk(appsDir);

  // GATE 1 fix: o pipeline gera os artefatos de deploy (Dockerfile, entrypoint, compose)
  // em project/, FORA de apps/. Sem eles no repo, o deploy backend clona e não acha
  // Dockerfile (DOCKERFILE_MISSING). Incluímos os arquivos de deploy na RAIZ do repo,
  // ao lado do código (que veio achatado de apps/). Só copiamos se ainda não existirem
  // em apps/ (não sobrescreve um Dockerfile que o Dev tenha posto no próprio apps/).
  const DEPLOY_FILES_FROM_PROJECT = ["Dockerfile", "docker-entrypoint.sh", ".dockerignore"];
  const projectDir = pathMod.join(projectFilesRoot, projectId, "project");
  const alreadyHave = new Set(allFiles.map((f) => f.relativePath));
  for (const fname of DEPLOY_FILES_FROM_PROJECT) {
    if (alreadyHave.has(fname)) continue; // Dev já entregou este arquivo em apps/
    const candidate = pathMod.join(projectDir, fname);
    try {
      const s = await stat(candidate);
      if (s.isFile() && s.size < 1_500_000) {
        allFiles.push({ relativePath: fname, absolutePath: candidate });
      }
    } catch { /* arquivo não existe em project/ — segue */ }
  }

  if (allFiles.length === 0) return { sha: "", fileCount: 0 };

  const octokit = await getOctokitForInstallation(installationId);

  // Get current branch HEAD — mesmo problema de propagação eventual do GitHub
  // após createRef: retry com backoff antes de desistir.
  let refData: Awaited<ReturnType<typeof octokit.git.getRef>>["data"] | null = null;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      refData = r.data;
      break;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== 404 || attempt === maxAttempts - 1) throw err;
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.log(`[GitHub] push: heads/${branch} 404 — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  if (!refData) throw new Error(`branch heads/${branch} not found after ${maxAttempts} attempts`);
  let currentSha = refData.object.sha;

  // Process in batches
  const batches: typeof allFiles[] = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    // Get base tree from current commit
    const { data: commitData } = await octokit.git.getCommit({ owner, repo, commit_sha: currentSha });
    const baseTreeSha = commitData.tree.sha;

    // Create blobs for each file (concorrência limitada + retry em rate-limit — evita
    // secondary rate limit do GitHub em projetos grandes, ex.: mobile RN CLI)
    const treeItems = await mapWithConcurrency(batch, BLOB_CONCURRENCY, async (f) => {
      const raw = await readFile(f.absolutePath);
      const sha = await createBlobWithRetry(octokit, owner, repo, raw.toString("base64"));
      return { path: f.relativePath, mode: "100644" as const, type: "blob" as const, sha };
    });

    const { data: tree } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: treeItems });

    const batchMsg = batches.length > 1
      ? `feat: Genesis — batch ${batchIdx + 1}/${batches.length} (${batch.length} files)`
      : `feat: Genesis — push ${allFiles.length} generated files`;

    const { data: newCommit } = await octokit.git.createCommit({
      owner, repo,
      message: batchMsg,
      tree: tree.sha,
      parents: [currentSha],
    });

    await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });
    currentSha = newCommit.sha;
  }

  return { sha: currentSha, fileCount: allFiles.length };
}

export async function createBranchIfNotExists(
  installationId: number,
  owner: string,
  repo: string,
  branch: string,
  sourceBranch = "main",
): Promise<void> {
  const octokit = await getOctokitForInstallation(installationId);
  // Check if branch already exists
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return; // already exists
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
  // Get SHA of source branch — pode dar 404 se GitHub ainda não terminou auto_init.
  // Retry com backoff exponencial: 1s, 2s, 4s, 8s, 16s (total ~30s).
  let sourceRef: Awaited<ReturnType<typeof octokit.git.getRef>>["data"] | null = null;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = await octokit.git.getRef({ owner, repo, ref: `heads/${sourceBranch}` });
      sourceRef = r.data;
      break;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== 404 || attempt === maxAttempts - 1) throw err;
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.log(`[GitHub] source branch heads/${sourceBranch} 404 — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  if (!sourceRef) throw new Error(`source branch heads/${sourceBranch} not found after ${maxAttempts} attempts`);
  await octokit.git.createRef({
    owner, repo,
    ref: `refs/heads/${branch}`,
    sha: sourceRef.object.sha,
  });
}

/**
 * Ensures dev, staging, and main branches exist in order:
 *   main (created by auto_init) → staging ← dev
 * Safe to call multiple times (idempotent).
 */
export async function ensureThreeBranches(
  installationId: number,
  owner: string,
  repo: string,
): Promise<void> {
  // staging branches from main, dev branches from staging
  await createBranchIfNotExists(installationId, owner, repo, "staging", "main");
  await createBranchIfNotExists(installationId, owner, repo, "dev", "staging");
}

/**
 * Sets (or updates) a GitHub Actions secret in a repository.
 * The value is encrypted with the repo's public key using libsodium before sending.
 *
 * Requires: tweetsodium (npm install tweetsodium)
 */
export async function setRepoSecret(
  installationId: number,
  owner: string,
  repo: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sodium = require("tweetsodium") as {
    seal: (message: Uint8Array, recipientPublicKey: Uint8Array) => Uint8Array;
  };

  const octokit = await getOctokitForInstallation(installationId);

  // Get repo public key for encrypting the secret
  const { data: keyData } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });

  // Encrypt secret value with the repo public key
  const messageBytes  = Buffer.from(secretValue);
  const keyBytes      = Buffer.from(keyData.key, "base64");
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  const encryptedValue = Buffer.from(encryptedBytes).toString("base64");

  await octokit.rest.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: secretName,
    encrypted_value: encryptedValue,
    key_id: keyData.key_id,
  });
}

/**
 * Remove um secret do repo (idempotente — 404 é tratado como sucesso). Usado no teardown de
 * demos: as credenciais de cloud sincronizadas não devem permanecer no repo depois que o
 * ambiente efêmero é destruído.
 */
export async function deleteRepoSecret(
  installationId: number,
  owner: string,
  repo: string,
  secretName: string,
): Promise<void> {
  const octokit = await getOctokitForInstallation(installationId);
  try {
    await octokit.rest.actions.deleteRepoSecret({ owner, repo, secret_name: secretName });
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
}

export async function createWorkflow(
  installationId: number,
  opts: {
    owner: string;
    repo: string;
    workflowName: string;
    workflowContent: string;
    branch?: string;
    commitMessage?: string;
  }
): Promise<{ sha: string }> {
  return commitAndPush(installationId, {
    owner: opts.owner,
    repo: opts.repo,
    branch: opts.branch,
    message: opts.commitMessage ?? `ci: add ${opts.workflowName} workflow`,
    files: [
      {
        path: `.github/workflows/${opts.workflowName}.yml`,
        content: opts.workflowContent,
      },
    ],
  });
}

// ── Item 2 (deploy via GitHub): dispatch on-demand + monitoramento ──────────────
//
// Genesis dispara o workflow (workflow_dispatch) e MONITORA/auto-cura até o GitHub
// retornar OK. Um workflow só é dispatchável se existir na branch DEFAULT do repo,
// então o caller garante o commit em main+branch-de-deploy antes de disparar.

/**
 * Dispara um workflow por workflow_dispatch. `workflowFile` é o basename do arquivo
 * em .github/workflows/ (ex.: "genesis-deploy.yml"). `ref` é a branch/tag alvo (o
 * checkout roda contra ela). `inputs` chega ao workflow como github.event.inputs.
 */
export async function dispatchWorkflow(
  installationId: number,
  opts: { owner: string; repo: string; workflowFile: string; ref: string; inputs?: Record<string, string> },
): Promise<void> {
  const octokit = await getOctokitForInstallation(installationId);
  await octokit.rest.actions.createWorkflowDispatch({
    owner: opts.owner,
    repo: opts.repo,
    workflow_id: opts.workflowFile,
    ref: opts.ref,
    inputs: opts.inputs,
  });
}

export interface WorkflowRunInfo {
  id: number;
  status: string | null;          // queued | in_progress | completed
  conclusion: string | null;      // success | failure | cancelled | ...
  htmlUrl: string;
  displayTitle: string;
  createdAt: string;
}

/**
 * Lista runs recentes do repo (opcionalmente filtrando por branch/evento). Usado pelo
 * monitor p/ correlacionar o run disparado (o dispatch não retorna o run id — casamos
 * pelo `display_title`, que o workflow carimba com o genesis_deploy_id via run-name).
 */
export async function listRecentWorkflowRuns(
  installationId: number,
  opts: { owner: string; repo: string; branch?: string; event?: string; perPage?: number },
): Promise<WorkflowRunInfo[]> {
  const octokit = await getOctokitForInstallation(installationId);
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: opts.owner,
    repo: opts.repo,
    branch: opts.branch,
    event: opts.event,
    per_page: opts.perPage ?? 20,
  });
  return (data.workflow_runs ?? []).map((r) => ({
    id: r.id,
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
    htmlUrl: r.html_url,
    displayTitle: r.display_title ?? r.name ?? "",
    createdAt: r.created_at,
  }));
}

/** Estado de um run específico. */
export async function getWorkflowRunStatus(
  installationId: number,
  opts: { owner: string; repo: string; runId: number },
): Promise<WorkflowRunInfo | null> {
  const octokit = await getOctokitForInstallation(installationId);
  try {
    const { data: r } = await octokit.rest.actions.getWorkflowRun({
      owner: opts.owner, repo: opts.repo, run_id: opts.runId,
    });
    return {
      id: r.id,
      status: r.status ?? null,
      conclusion: r.conclusion ?? null,
      htmlUrl: r.html_url,
      displayTitle: r.display_title ?? r.name ?? "",
      createdAt: r.created_at,
    };
  } catch {
    return null;
  }
}
