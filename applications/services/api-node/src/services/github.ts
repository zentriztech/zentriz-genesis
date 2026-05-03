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

  // Create blobs and build tree
  const treeItems = await Promise.all(
    opts.files.map(async (file) => {
      const { data: blob } = await octokit.git.createBlob({
        owner: opts.owner,
        repo: opts.repo,
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
    })
  );

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

  if (allFiles.length === 0) return { sha: "", fileCount: 0 };

  const octokit = await getOctokitForInstallation(installationId);

  // Get current branch HEAD
  const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
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

    // Create blobs for each file
    const treeItems = await Promise.all(
      batch.map(async (f) => {
        const raw = await readFile(f.absolutePath);
        const content = raw.toString("base64");
        const { data: blob } = await octokit.git.createBlob({ owner, repo, content, encoding: "base64" });
        return { path: f.relativePath, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
      })
    );

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
  // Get SHA of source branch
  const { data: sourceRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${sourceBranch}` });
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
