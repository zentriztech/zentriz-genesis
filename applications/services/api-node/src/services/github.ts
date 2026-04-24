import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "";
const GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID ?? "";
const GITHUB_APP_CLIENT_SECRET = process.env.GITHUB_APP_CLIENT_SECRET ?? "";

export type GitHubInstallationInfo = {
  installationId: number;
  githubLogin: string;
  installationType: "Organization" | "User";
  reposAuthorized: "all" | "selected";
  selectedRepos: string[];
};

/** Lazy — reads the private key on first use, not at module load time. */
function _getPrivateKey(): string {
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

function isAppConfigured(): boolean {
  const appId = process.env.GITHUB_APP_ID ?? "";
  if (!appId) return false;
  const keyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  return Boolean(keyFile || keyInline);
}

/**
 * Returns an authenticated Octokit client for a given installation.
 * Falls back to GITHUB_TOKEN when App is not configured (dev/local).
 */
async function getOctokitForInstallation(installationId: number): Promise<Octokit> {
  if (!isAppConfigured()) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("No GitHub credentials. Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.");
    return new Octokit({ auth: token });
  }

  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: _getPrivateKey(),
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
  });

  const { token } = await auth({ type: "installation", installationId });
  return new Octokit({ auth: token });
}

/**
 * Fetches metadata about an installation directly from GitHub.
 * Used during onboarding to validate and store installation details.
 */
export async function getInstallationInfo(installationId: number): Promise<GitHubInstallationInfo> {
  if (!isAppConfigured()) throw new Error("GitHub App not configured.");

  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: _getPrivateKey(),
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
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
