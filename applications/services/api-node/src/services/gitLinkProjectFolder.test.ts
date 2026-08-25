/**
 * gitLinkProjectFolder.test.ts — Ponto 3 (Jean): git-link da pasta local ao repo criado,
 * para o Deadpool usá-la como repo_dir (working tree) sem clone de rede.
 *
 * Integração hermética: um repositório BARE local faz de "remote" (seam remoteUrl via
 * file://), sem tocar a rede/GitHub. Verifica: (1) pasta ausente → degrada gracioso e NÃO
 * lança; (2) happy path → a pasta vira working tree git no branch alvo, com histórico COMUM
 * do remote (arquivo do remote presente, upstream = origin/<branch>, remote origin LIMPO
 * sem token).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

// getInstallationTokenForClone é o único símbolo de ./github.js que o helper usa.
vi.mock("./github.js", () => ({ getInstallationTokenForClone: async () => "fake-token" }));

let ROOT: string; // PROJECT_FILES_ROOT de teste
let REMOTE_URL: string; // file://<bare>
let gitLinkProjectFolder: typeof import("./githubPush.js").gitLinkProjectFolder;

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { timeout: 60_000 });
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "gitlink-"));
  ROOT = join(base, "uploads");
  process.env.PROJECT_FILES_ROOT = ROOT;

  // Constrói um "remote" bare com um branch dev populado (via um clone de trabalho).
  const bare = join(base, "remote.git");
  await mkdir(bare, { recursive: true });
  await git(bare, ["init", "--bare", "-q", "-b", "dev"]);
  REMOTE_URL = `file://${bare}`;

  const seed = join(base, "seed");
  await mkdir(seed, { recursive: true });
  await git(seed, ["init", "-q", "-b", "dev"]);
  await git(seed, ["config", "user.email", "t@t.com"]);
  await git(seed, ["config", "user.name", "T"]);
  await writeFile(join(seed, "README.md"), "# do remote\n");
  await writeFile(join(seed, "app.ts"), "export const x = 1;\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-q", "-m", "seed dev"]);
  await git(seed, ["remote", "add", "origin", bare]);
  await git(seed, ["push", "-q", "origin", "dev"]);

  // Import só depois de fixar PROJECT_FILES_ROOT (capturado no load do módulo).
  ({ gitLinkProjectFolder } = await import("./githubPush.js"));
});

describe("gitLinkProjectFolder — Ponto 3 (git-link p/ Deadpool)", () => {
  it("pasta local ausente → ok:false e NÃO lança", async () => {
    const res = await gitLinkProjectFolder({ projectId: "sem-apps", fullName: "o/r", installationId: 1, branch: "dev" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ausente");
  });

  it("happy path → working tree git no branch, com histórico comum do remote", async () => {
    const projectId = "proj-1";
    const apps = join(ROOT, projectId, "apps");
    await mkdir(apps, { recursive: true });
    await writeFile(join(apps, "app.ts"), "export const x = 1;\n"); // idêntico ao remote

    const res = await gitLinkProjectFolder({ projectId, fullName: "o/r", installationId: 1, branch: "dev", remoteUrl: REMOTE_URL });
    expect(res.ok).toBe(true);
    expect(res.localPath).toBe(apps);

    // .git existe → virou working tree.
    await expect(stat(join(apps, ".git"))).resolves.toBeDefined();
    // Branch atual = dev.
    const { stdout: branch } = await git(apps, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.trim()).toBe("dev");
    // Histórico comum: arquivo que só existia no remote está presente agora.
    await expect(readFile(join(apps, "README.md"), "utf-8")).resolves.toContain("do remote");
    // Upstream = origin/dev (fetch alinhou ao tip remoto).
    const { stdout: up } = await git(apps, ["rev-parse", "--abbrev-ref", "dev@{upstream}"]);
    expect(up.trim()).toBe("origin/dev");
    // Remote origin LIMPO (sem token embutido).
    const { stdout: remote } = await git(apps, ["remote", "get-url", "origin"]);
    expect(remote).not.toContain("fake-token");
    expect(remote).not.toContain("x-access-token");
  });
});
