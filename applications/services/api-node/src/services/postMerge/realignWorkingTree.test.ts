/**
 * realignWorkingTree.test.ts — Bloco 4 (M3): realinhamento pós-merge da working tree local para 'dev'.
 * Integração hermética com um repositório BARE local como "remote" (file://), sem tocar a rede.
 * Cobre: happy path (evolution/v2 limpo → HEAD passa a 'dev' no SHA do merge); árvore suja → deferred
 * sem tocar nada; HEAD em deadpool/<id> → deferred; token via header não persiste no config.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

vi.mock("../github.js", () => ({
  getInstallationTokenForClone: async () => "fake-token",
  repoShortName: (f: string) => (f.split("/").pop() ?? f),
}));

let ROOT: string;
let BARE: string;
let SEED: string;
let realignAfterMerge: typeof import("./realignWorkingTree.js").realignAfterMerge;

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { timeout: 60_000 });
}

/** Cria a working tree local do filho git-linkada ao remote, no branch informado. */
async function linkChild(childId: string, branch: string): Promise<string> {
  const apps = join(ROOT, childId, "apps");
  await mkdir(apps, { recursive: true });
  await git(apps, ["init", "-q", "-b", "dev"]);
  await git(apps, ["config", "user.email", "t@t.com"]);
  await git(apps, ["config", "user.name", "T"]);
  await git(apps, ["remote", "add", "origin", BARE]);
  await git(apps, ["fetch", "--depth=1", "-q", "origin", "dev"]);
  await git(apps, ["reset", "--hard", "-q", "origin/dev"]);
  if (branch !== "dev") await git(apps, ["checkout", "-q", "-B", branch]);
  return apps;
}

/** Empurra um novo commit ao 'dev' do remote (simula o merge da evolução) e devolve o SHA. */
async function pushToRemoteDev(content: string): Promise<string> {
  await writeFile(join(SEED, "app.ts"), content);
  await git(SEED, ["add", "-A"]);
  await git(SEED, ["commit", "-q", "-m", "merge evolução"]);
  await git(SEED, ["push", "-q", "origin", "dev"]);
  return (await git(SEED, ["rev-parse", "HEAD"])).stdout.trim();
}

function makeDb(childRow: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/SELECT c\.extra/.test(sql)) return { rows: childRow === null ? [] : [childRow] };
      if (/UPDATE projects SET extra/.test(sql)) updates.push(JSON.parse(String(params[1] ?? "{}")));
      return { rows: [] };
    }),
  };
  return { db, updates };
}

const baseRow = (extra: Record<string, unknown>) => ({
  extra, repo_full_name: "acme/produto", installation_id: 100, revoked_at: null,
});

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "realign-"));
  ROOT = join(base, "uploads");
  process.env.PROJECT_FILES_ROOT = ROOT;
  BARE = join(base, "remote.git");
  await mkdir(BARE, { recursive: true });
  await git(BARE, ["init", "--bare", "-q", "-b", "dev"]);
  SEED = join(base, "seed");
  await mkdir(SEED, { recursive: true });
  await git(SEED, ["init", "-q", "-b", "dev"]);
  await git(SEED, ["config", "user.email", "t@t.com"]);
  await git(SEED, ["config", "user.name", "T"]);
  await writeFile(join(SEED, "app.ts"), "export const x = 1;\n");
  await git(SEED, ["add", "-A"]);
  await git(SEED, ["commit", "-q", "-m", "seed dev"]);
  await git(SEED, ["remote", "add", "origin", BARE]);
  await git(SEED, ["push", "-q", "origin", "dev"]);
  ({ realignAfterMerge } = await import("./realignWorkingTree.js"));
});

beforeEach(() => vi.clearAllMocks());

describe("realignAfterMerge", () => {
  it("evolution/v2 limpo → HEAD passa a 'dev' no SHA do merge; estado 'done'", async () => {
    const apps = await linkChild("c-happy", "evolution/v2");
    const mergeSha = await pushToRemoteDev("export const x = 2;\n");
    const { db, updates } = makeDb(baseRow({ evolution_branch: "evolution/v2" }));

    await realignAfterMerge(db as never, "c-happy", mergeSha);

    expect((await git(apps, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("dev");
    expect((await git(apps, ["rev-parse", "HEAD"])).stdout.trim()).toBe(mergeSha);
    const done = updates.find((u) => u.evolution_realign_state === "done");
    expect(done).toBeTruthy();
    expect(done!.evolution_realign_head).toBe(mergeSha);
    expect(done!.evolution_realign_merge_matches).toBe(true);
    // Token não persiste no config.
    const cfg = await readFile(join(apps, ".git", "config"), "utf-8");
    expect(cfg).not.toContain("fake-token");
  });

  it("árvore suja → deferred_dirty, sem mover o HEAD", async () => {
    const apps = await linkChild("c-dirty", "evolution/v2");
    await writeFile(join(apps, "novo.ts"), "sujeira não commitada\n");
    const headBefore = (await git(apps, ["rev-parse", "HEAD"])).stdout.trim();
    const { db, updates } = makeDb(baseRow({ evolution_branch: "evolution/v2" }));

    await realignAfterMerge(db as never, "c-dirty", "qualquer");

    expect(updates.some((u) => u.evolution_realign_state === "deferred_dirty")).toBe(true);
    expect((await git(apps, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("evolution/v2");
    expect((await git(apps, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
  });

  it("HEAD em deadpool/<id> (trabalho do Auto Care) → deferred_dirty", async () => {
    const apps = await linkChild("c-deadpool", "deadpool/inc-1");
    const { db, updates } = makeDb(baseRow({ evolution_branch: "evolution/v2" }));
    await realignAfterMerge(db as never, "c-deadpool", "qualquer");
    expect(updates.some((u) => u.evolution_realign_state === "deferred_dirty")).toBe(true);
    expect((await git(apps, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("deadpool/inc-1");
  });

  it("instalação revogada → blocked_permission (fail-closed), sem mexer no git", async () => {
    await linkChild("c-revoked", "evolution/v2");
    const { db, updates } = makeDb({ ...baseRow({ evolution_branch: "evolution/v2" }), revoked_at: "2026-09-01" });
    await realignAfterMerge(db as never, "c-revoked", "x");
    expect(updates.some((u) => u.evolution_realign_state === "blocked_permission")).toBe(true);
  });

  it("já 'done' → no-op idempotente", async () => {
    const { db } = makeDb(baseRow({ evolution_realign_state: "done" }));
    await realignAfterMerge(db as never, "c-done", "x");
    // Só o SELECT inicial; nenhum UPDATE.
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
