/**
 * github.merge.test.ts — Bloco 4 (M1): primitivas de merge de PR (getPullRequest / mergePullRequest /
 * updatePullRequestBranch). Todas usam `requireApp:true` (recusa o PAT global — GAP 4) e NUNCA lançam:
 * qualquer erro do Octokit vira `{ ok:false, status, error }` para o chamador mapear em estado legível.
 * O Octokit é injetado pelo seam `__setOctokitFactoryForTests` (sem rede/credenciais).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  __setOctokitFactoryForTests,
  getPullRequest,
  mergePullRequest,
  updatePullRequestBranch,
} from "./github.js";

type FakeOctokit = { pulls: Record<string, (...a: unknown[]) => Promise<unknown>> };
function fakeFactory(oct: Partial<FakeOctokit["pulls"]>, capture?: (id: number, opts?: { requireApp?: boolean }) => void) {
  return async (id: number, opts?: { requireApp?: boolean }) => {
    capture?.(id, opts);
    return { pulls: oct } as unknown as import("@octokit/rest").Octokit;
  };
}

afterEach(() => __setOctokitFactoryForTests(null));

describe("getPullRequest", () => {
  it("mapeia state/merged/mergeable/mergeable_state/head/base e exige App (requireApp:true)", async () => {
    let seenRequireApp: boolean | undefined;
    __setOctokitFactoryForTests(fakeFactory(
      { get: vi.fn(async () => ({ data: { state: "open", merged: false, mergeable: true, mergeable_state: "clean", head: { sha: "abc123" }, base: { ref: "dev" }, merge_commit_sha: null } })) },
      (_id, opts) => { seenRequireApp = opts?.requireApp; },
    ));
    const r = await getPullRequest(42, { owner: "o", repo: "r", number: 7 });
    expect(seenRequireApp).toBe(true);
    expect(r).toMatchObject({ ok: true, state: "open", merged: false, mergeable: true, mergeableState: "clean", headSha: "abc123", baseRef: "dev" });
  });

  it("mergeable null → mergeable=null (chamador reconsulta)", async () => {
    __setOctokitFactoryForTests(fakeFactory({ get: vi.fn(async () => ({ data: { state: "open", merged: false, mergeable: null, mergeable_state: "unknown", head: { sha: "x" }, base: { ref: "dev" } } })) }));
    const r = await getPullRequest(1, { owner: "o", repo: "r", number: 1 });
    expect(r.ok && r.mergeable).toBeNull();
  });

  it("erro do Octokit → { ok:false, status } (nunca lança)", async () => {
    __setOctokitFactoryForTests(fakeFactory({ get: vi.fn(async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); }) }));
    const r = await getPullRequest(1, { owner: "o", repo: "r", number: 999 });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe("mergePullRequest", () => {
  it("sucesso → { ok:true, sha } com method e sha repassados", async () => {
    const merge = vi.fn(async () => ({ data: { sha: "merged-sha", merged: true } }));
    __setOctokitFactoryForTests(fakeFactory({ merge }));
    const r = await mergePullRequest(9, { owner: "o", repo: "r", number: 3, method: "squash", sha: "head-sha", commitTitle: "t", commitMessage: "m" });
    expect(r).toEqual({ ok: true, sha: "merged-sha", merged: true });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ merge_method: "squash", sha: "head-sha", pull_number: 3 }));
  });

  it("403 → captura X-Accepted-GitHub-Permissions", async () => {
    __setOctokitFactoryForTests(fakeFactory({ merge: vi.fn(async () => { throw Object.assign(new Error("forbidden"), { status: 403, response: { headers: { "x-accepted-github-permissions": "pull_requests=write" } } }); }) }));
    const r = await mergePullRequest(1, { owner: "o", repo: "r", number: 1 });
    expect(r).toMatchObject({ ok: false, status: 403, acceptedPermissions: "pull_requests=write" });
  });

  it("409 (head moveu) → { ok:false, status:409 }", async () => {
    __setOctokitFactoryForTests(fakeFactory({ merge: vi.fn(async () => { throw Object.assign(new Error("Head branch was modified"), { status: 409 }); }) }));
    const r = await mergePullRequest(1, { owner: "o", repo: "r", number: 1, sha: "stale" });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });
});

describe("updatePullRequestBranch", () => {
  it("sucesso → { ok:true } passando expected_head_sha", async () => {
    const updateBranch = vi.fn(async () => ({}));
    __setOctokitFactoryForTests(fakeFactory({ updateBranch }));
    const r = await updatePullRequestBranch(1, { owner: "o", repo: "r", number: 1, expectedHeadSha: "h" });
    expect(r.ok).toBe(true);
    expect(updateBranch).toHaveBeenCalledWith(expect.objectContaining({ expected_head_sha: "h", pull_number: 1 }));
  });

  it("falha → { ok:false, status } (nunca lança)", async () => {
    __setOctokitFactoryForTests(fakeFactory({ updateBranch: vi.fn(async () => { throw Object.assign(new Error("422"), { status: 422 }); }) }));
    const r = await updatePullRequestBranch(1, { owner: "o", repo: "r", number: 1 });
    expect(r).toMatchObject({ ok: false, status: 422 });
  });
});
