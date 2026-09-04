/**
 * cloudDeploy.test.ts — Bloco 4 (M5): redeploy com a mesma identidade de linhagem + rollback por SHA.
 * Cobre: branch de deploy por estado (evolution/vN antes do merge, dev depois); startCloudDeploy grava
 * lineage_root_id/git_sha/trigger_kind/supersedes e marca o reverso superseded_by no deploy anterior;
 * teardownExpired (via reconcile) ignora deploys substituídos; deployTargets injeta genesis_git_sha +
 * ref: em todos os 12 templates de deploy. DB por regex de SQL; github/cloudConnector/lineage mockados.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Estado configurável por teste ─────────────────────────────────────────────
let repoExtra: Record<string, unknown> = {};
const captured: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("../../db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/FROM project_github_repos/.test(sql)) {
        return { rows: [{ repo_name: "produto", repo_full_name: "acme/produto", default_branch: "main",
          installation_id: 100, github_login: "acme", extra: repoExtra }] };
      }
      if (/SELECT extra FROM projects WHERE/.test(sql)) return { rows: [{ extra: {} }] };
      if (/INSERT INTO cloud_deployments/.test(sql)) return { rows: [{ id: "dep-new" }] };
      if (/SELECT d\.\*/.test(sql)) return { rows: [{ status: "done" }] }; // runDeployAttempt early-return
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("../cloudConnector.js", () => ({
  getCloudConnection: async () => ({ provider: "aws" }),
  syncSecretsToGitHub: async () => {},
  removeSyncedSecrets: async () => {},
}));
vi.mock("../lineage.js", () => ({
  resolveLineageRoot: async () => ({ id: "root-1", title: "Produto", product_id: null, depth: 1 }),
}));
vi.mock("../github.js", () => ({
  commitAndPush: async () => {},
  dispatchWorkflow: async () => {},
  listRecentWorkflowRuns: async () => [],
  getWorkflowRunStatus: async () => null,
  getBranchSha: async () => "abc123sha",
}));

const { startCloudDeploy, reconcileCloudDeployments } = await import("./cloudDeploy.js");
const { getCloudDeployWorkflow, DEPLOY_FORMATS } = await import("./deployTargets.js");

const baseParams = {
  projectId: "child-1", tenantId: "t1", userId: "u1", connectionId: "conn-1",
  format: "container" as const, expiresAt: null, consentedTeardown: false,
};

function insertCall() {
  return captured.find((c) => /INSERT INTO cloud_deployments/.test(c.sql));
}

beforeEach(() => {
  captured.length = 0;
  repoExtra = {};
});

describe("startCloudDeploy — branch por estado + rastreio de linhagem", () => {
  it("evolução NÃO mergeada → deploya a branch evolution/vN", async () => {
    repoExtra = { evolution: true, evolution_branch: "evolution/v2" };
    const r = await startCloudDeploy({ ...baseParams });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.branch).toBe("evolution/v2");
    expect(insertCall()!.params[5]).toBe("evolution/v2"); // coluna branch
  });

  it("evolução JÁ mergeada → deploya 'dev'", async () => {
    repoExtra = { evolution: true, evolution_branch: "evolution/v2", evolution_merged_at: "2026-09-04T00:00:00Z" };
    const r = await startCloudDeploy({ ...baseParams });
    if (r.ok) expect(r.branch).toBe("dev");
    expect(insertCall()!.params[5]).toBe("dev");
  });

  it("projeto normal → 'dev'", async () => {
    const r = await startCloudDeploy({ ...baseParams });
    if (r.ok) expect(r.branch).toBe("dev");
  });

  it("grava lineage_root_id, git_sha, trigger_kind e supersedes; marca o reverso no deploy anterior", async () => {
    const r = await startCloudDeploy({
      ...baseParams, branch: "dev", gitSha: "MERGESHA", triggerKind: "evolution_merge", supersedesId: "dep-prev",
    });
    expect(r.ok).toBe(true);
    const ins = insertCall()!;
    // 'pending' é literal no VALUES → o param 12 (git_sha) cai no índice 11 do array.
    expect(ins.params[11]).toBe("MERGESHA");       // git_sha
    expect(ins.params[12]).toBe("root-1");          // lineage_root_id (da raiz)
    expect(ins.params[13]).toBe("evolution_merge"); // trigger_kind
    expect(ins.params[14]).toBe("dep-prev");        // supersedes_deployment_id
    // reverso: marca o deploy anterior como substituído por este
    const rev = captured.find((c) => /UPDATE cloud_deployments SET superseded_by_deployment_id/.test(c.sql));
    expect(rev).toBeTruthy();
    expect(rev!.params).toEqual(["dep-prev", "dep-new"]);
  });

  it("trigger_kind default = 'manual' e supersedes null quando não informados", async () => {
    await startCloudDeploy({ ...baseParams });
    const ins = insertCall()!;
    expect(ins.params[13]).toBe("manual");
    expect(ins.params[14]).toBeNull();
    expect(captured.some((c) => /UPDATE cloud_deployments SET superseded_by_deployment_id/.test(c.sql))).toBe(false);
  });
});

describe("reconcileCloudDeployments — teardown ignora deploys substituídos", () => {
  it("a query de demos vencidas filtra superseded_by_deployment_id IS NULL", async () => {
    await reconcileCloudDeployments();
    const expiredQ = captured.find((c) =>
      /status='deployed'/.test(c.sql) && /expires_at < now\(\)/.test(c.sql) && /consented_teardown = true/.test(c.sql));
    expect(expiredQ).toBeTruthy();
    expect(expiredQ!.sql).toMatch(/superseded_by_deployment_id IS NULL/);
  });
});

describe("deployTargets — checkout por SHA em todos os 12 templates", () => {
  for (const provider of ["aws", "azure", "gcp"] as const) {
    for (const format of DEPLOY_FORMATS) {
      it(`${provider}:${format} declara input genesis_git_sha e faz checkout com ref`, () => {
        const yaml = getCloudDeployWorkflow(provider, format, "produto");
        expect(yaml).toMatch(/genesis_git_sha:/);
        expect(yaml).toContain("ref: ${{ github.event.inputs.genesis_git_sha || github.ref }}");
      });
    }
  }
});
