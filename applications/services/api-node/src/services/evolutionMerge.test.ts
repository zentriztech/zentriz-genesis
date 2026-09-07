/**
 * evolutionMerge.test.ts — Bloco 4 (M1): a escada determinística de pré-condições do merge automático.
 *
 * Cobre: flag (skip), sem PR (skip), instalação ausente/revogada (blocked_permission), compat implícita
 * e major (política — só sem force), fail-closed sem evidência (nem force contorna), sem-testes/regressões
 * (força contorna), realidade do GitHub (base/head/conflito/proteção), `behind` → update-branch, sucesso
 * (grava + dispara hooks + atualiza sha_dev), retry squash→merge, e o claim atômico.
 *
 * Todas as primitivas de rede e I/O são mockadas — este teste é puramente sobre a MÁQUINA DE ESTADOS.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const gh = { getPullRequest: vi.fn(), mergePullRequest: vi.fn(), updatePullRequestBranch: vi.fn() };
vi.mock("./github.js", () => gh);
const checkpoint = { readEvolutionCheckpoint: vi.fn() };
vi.mock("./evolutionState.js", () => checkpoint);
vi.mock("./lineage.js", () => ({ resolveLineageRoot: vi.fn(async () => ({ id: "root", title: "R", product_id: null, depth: 0 })) }));
const hooks = { runPostMergeHooks: vi.fn(async () => {}) };
vi.mock("./postMerge/runPostMergeHooks.js", () => hooks);
vi.mock("./evolutionAccept.js", () => ({ buildPullRequestBody: vi.fn(async () => "corpo do PR") }));

const { tryAutoMergeEvolution, __setMergeSleepForTests } = await import("./evolutionMerge.js");
__setMergeSleepForTests(async () => {}); // sem espera real no backoff

const CLEAN_CHECKPOINT = { evolution_baseline: { status: "ok", final: { status: "ok", passed: 10, failed: 0, regressions: [] } } };

function makeDb(cfg: { row?: Record<string, unknown> | null; claim?: unknown[]; claimState?: { s?: string; sha?: string } }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT p\.title/.test(sql)) return { rows: cfg.row === null ? [] : [cfg.row ?? {}] };
    if (/"evolution_merge_state":"merging"/.test(sql)) return { rows: cfg.claim ?? [{ id: "child" }] };
    if (/SELECT extra->>'evolution_merge_state' AS s/.test(sql)) return { rows: cfg.claimState ? [cfg.claimState] : [] };
    return { rows: [] };
  }) };
  return { db, calls };
}

const baseRow = (extra: Record<string, unknown>) => ({
  title: "Extrato — Evolução v2", version_number: 2, extra,
  installation_id: 100, revoked_at: null, repo_full_name: "acme/produto",
});
const evolExtra = (over: Record<string, unknown> = {}) => ({
  evolution: true, evolution_pr_number: 5, evolution_compat: "minor", evolution_compat_explicit: true,
  evolution_head_sha: "HEAD", evolution_version: "1.1.0", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  __setMergeSleepForTests(async () => {});
  delete process.env.EVOLUTION_AUTO_MERGE;
  delete process.env.EVOLUTION_AUTO_MERGE_METHOD;
  delete process.env.EVOLUTION_AUTO_MERGE_MAX_COMPAT;
  delete process.env.EVOLUTION_AUTO_MERGE_ALLOW_NO_TESTS;
  delete process.env.EVOLUTION_AUTO_MERGE_ALLOW_HAS_HOOKS;
  checkpoint.readEvolutionCheckpoint.mockResolvedValue(CLEAN_CHECKPOINT);
  gh.getPullRequest.mockResolvedValue({ ok: true, merged: false, mergeable: true, mergeableState: "clean", headSha: "HEAD", baseRef: "dev" });
  gh.mergePullRequest.mockResolvedValue({ ok: true, sha: "MERGESHA" });
  gh.updatePullRequestBranch.mockResolvedValue({ ok: true });
});

describe("tryAutoMergeEvolution — política (não-force)", () => {
  it("flag OFF → skipped_flag (nada muda)", async () => {
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r.state).toBe("skipped_flag");
    expect(gh.getPullRequest).not.toHaveBeenCalled();
  });

  it("não-evolução → skipped_no_pr", async () => {
    const { db } = makeDb({ row: baseRow({ evolution: false }) });
    process.env.EVOLUTION_AUTO_MERGE = "on";
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("skipped_no_pr");
  });

  it("sem número de PR → skipped_no_pr", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_pr_number: undefined })) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("skipped_no_pr");
  });

  it("instalação revogada → blocked_permission (fail-closed)", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const row = { ...baseRow(evolExtra()), revoked_at: "2026-09-01" };
    const { db } = makeDb({ row });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_permission");
  });

  it("compat não declarada (implícita) → blocked_compat_implicit", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat_explicit: false })) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_compat_implicit");
  });

  it("compat MAJOR → blocked_major (exige humano)", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat: "major" })) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_major");
  });

  it("compat acima do teto (patch) → blocked_major", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    process.env.EVOLUTION_AUTO_MERGE_MAX_COMPAT = "patch";
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat: "minor" })) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_major");
  });

  it("sem checkpoint → blocked_no_evidence", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(null);
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_no_evidence");
  });

  it("baseline sem testes → blocked_no_tests", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    checkpoint.readEvolutionCheckpoint.mockResolvedValue({ evolution_baseline: { status: "no_tests" } });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_no_tests");
  });

  it("regressões no PASS_TO_PASS → blocked_regressions", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    checkpoint.readEvolutionCheckpoint.mockResolvedValue({ evolution_baseline: { status: "ok", final: { status: "ok", regressions: ["t1", "t2"] } } });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r.state).toBe("blocked_regressions");
    expect(r.detail).toMatch(/2 regress/);
  });
});

describe("tryAutoMergeEvolution — realidade do GitHub (nunca contornada por force)", () => {
  it("base do PR != dev → blocked_base_mismatch", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.getPullRequest.mockResolvedValue({ ok: true, merged: false, mergeable: true, mergeableState: "clean", headSha: "HEAD", baseRef: "main" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child", { force: true })).state).toBe("blocked_base_mismatch");
  });

  it("head mudou após publicação → blocked_head_moved", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.getPullRequest.mockResolvedValue({ ok: true, merged: false, mergeable: true, mergeableState: "clean", headSha: "OUTRO", baseRef: "dev" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child", { force: true })).state).toBe("blocked_head_moved");
  });

  it("dirty → blocked_conflict", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.getPullRequest.mockResolvedValue({ ok: true, merged: false, mergeable: false, mergeableState: "dirty", headSha: "HEAD", baseRef: "dev" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_conflict");
  });

  it("blocked → blocked_protection", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.getPullRequest.mockResolvedValue({ ok: true, merged: false, mergeable: false, mergeableState: "blocked", headSha: "HEAD", baseRef: "dev" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child")).state).toBe("blocked_protection");
  });

  it("behind → update-branch 1x e mergeia com o NOVO head", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.getPullRequest
      .mockResolvedValueOnce({ ok: true, merged: false, mergeable: false, mergeableState: "behind", headSha: "HEAD", baseRef: "dev" })
      .mockResolvedValueOnce({ ok: true, merged: false, mergeable: true, mergeableState: "clean", headSha: "NEWHEAD", baseRef: "dev" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(gh.updatePullRequestBranch).toHaveBeenCalledOnce();
    expect(r.state).toBe("merged");
    expect(gh.mergePullRequest).toHaveBeenCalledWith(100, expect.objectContaining({ sha: "NEWHEAD" }));
  });
});

describe("tryAutoMergeEvolution — force contorna política, não realidade nem evidência", () => {
  it("force + sem checkpoint → AINDA blocked_no_evidence (fail-closed absoluto)", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(null);
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat: "major" })) });
    expect((await tryAutoMergeEvolution(db as never, "child", { force: true })).state).toBe("blocked_no_evidence");
  });

  it("force + regressões → mergeia (humano assumiu o risco)", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue({ evolution_baseline: { status: "ok", final: { status: "ok", regressions: ["t1"] } } });
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat: "major" })) });
    const r = await tryAutoMergeEvolution(db as never, "child", { force: true, actorUserId: "u-42" });
    expect(r.state).toBe("merged");
  });
});

describe("tryAutoMergeEvolution — sucesso e efeitos", () => {
  it("merge limpo → grava sha_dev, dispara hooks, ator default 'genesis'", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db, calls } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r).toMatchObject({ state: "merged", sha: "MERGESHA" });
    // sha_dev da raiz + filho
    const shaUpd = calls.find((c) => /UPDATE project_github_repos SET sha_dev/.test(c.sql))!;
    expect(shaUpd.params[1]).toBe("MERGESHA");
    expect(shaUpd.params[0]).toEqual(expect.arrayContaining(["child", "root"]));
    // hook pós-merge com o sha
    expect(hooks.runPostMergeHooks).toHaveBeenCalledWith(db, "child", { mergeSha: "MERGESHA" });
    // estado persistido = merged, ator genesis
    const merged = calls.find((c) => /"evolution_merged_at"/.test(String(c.params[1] ?? "")));
    expect(JSON.parse(merged!.params[1] as string)).toMatchObject({ evolution_merge_state: "merged", evolution_merge_actor: "genesis" });
  });

  it("squash desabilitado (405) → retry com merge commit", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.mergePullRequest
      .mockResolvedValueOnce({ ok: false, status: 405, error: "Merge method squash is not allowed" })
      .mockResolvedValueOnce({ ok: true, sha: "MERGESHA" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r.state).toBe("merged");
    expect(gh.mergePullRequest).toHaveBeenLastCalledWith(100, expect.objectContaining({ method: "merge" }));
  });

  it("merge 403 → blocked_permission com acceptedPermissions", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    gh.mergePullRequest.mockResolvedValue({ ok: false, status: 403, error: "forbidden", acceptedPermissions: "pull_requests=write" });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r).toMatchObject({ state: "blocked_permission", acceptedPermissions: "pull_requests=write" });
  });

  it("PR já mergeado no extra → merged sem tocar a rede (idempotente)", async () => {
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_merged_at: "2026-09-04T00:00:00Z", evolution_merge_sha: "OLD" })) });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r).toEqual({ state: "merged", sha: "OLD" });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
  });
});

describe("tryAutoMergeEvolution — claim atômico (GAP 3)", () => {
  it("claim perdido e já merged → devolve merged", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db } = makeDb({ row: baseRow(evolExtra()), claim: [], claimState: { s: "merged", sha: "XYZ" } });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r).toEqual({ state: "merged", sha: "XYZ" });
  });

  it("claim perdido e outra tentativa em curso → failed", async () => {
    process.env.EVOLUTION_AUTO_MERGE = "on";
    const { db } = makeDb({ row: baseRow(evolExtra()), claim: [], claimState: { s: "merging" } });
    const r = await tryAutoMergeEvolution(db as never, "child");
    expect(r.state).toBe("failed");
  });
});

/**
 * 🔴 GAP-59 — a sonda (`evaluateOnly`). O veredito tem de ser AVALIAÇÃO PURA: aplica a política,
 * não toca a rede, não reivindica `merging` (senão trava o merge real que vem logo depois) e não
 * grava estado nenhum (senão a sonda passa a mentir sobre o histórico do projeto).
 */
describe("tryAutoMergeEvolution — evaluateOnly (GAP-59)", () => {
  const REGRESSION_CHECKPOINT = {
    evolution_baseline: { status: "ok", final: { status: "ok", passed: 9, failed: 1, regressions: ["t_pedido_status"] } },
  };

  it("flag OFF: a sonda NÃO para em skipped_flag — avalia a política até o fim", async () => {
    // Este é o defeito: com a flag desligada (default), o merge automático nunca chegou a avaliar
    // regressões, então o estado gravado ficava vazio e a rota manual não pedia confirmação.
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(REGRESSION_CHECKPOINT);
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true });
    expect(r.state).toBe("blocked_regressions");
    expect(r.detail).toContain("1 regressão");
  });

  it("política limpa → would_merge, sem tocar o GitHub", async () => {
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true });
    expect(r.state).toBe("would_merge");
    expect(gh.getPullRequest).not.toHaveBeenCalled();
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a sonda NÃO reivindica `merging` (senão o merge real logo depois bateria no próprio claim)", async () => {
    const { db, calls } = makeDb({ row: baseRow(evolExtra()) });
    await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true });
    expect(calls.some((c) => /"evolution_merge_state":"merging"/.test(c.sql))).toBe(false);
  });

  it("a sonda NÃO grava estado nem diálogo, mesmo quando bloqueia", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(REGRESSION_CHECKPOINT);
    const { db, calls } = makeDb({ row: baseRow(evolExtra()) });
    await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true });
    expect(calls.some((c) => /UPDATE projects SET extra/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /project_dialogue/.test(c.sql))).toBe(false);
  });

  it("sem evidência de testes → blocked_no_evidence (a rota recusa antes de forçar)", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(null);
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true })).state).toBe("blocked_no_evidence");
  });

  it("baseline sem testes → blocked_no_tests (risco que o humano precisa VER)", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue({ evolution_baseline: { status: "no_tests" } });
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true })).state).toBe("blocked_no_tests");
  });

  it("compat MAJOR → blocked_major na sonda", async () => {
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_compat: "major" })) });
    expect((await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true })).state).toBe("blocked_major");
  });

  it("evaluateOnly + force: a política ainda vale — avaliar com force devolveria `would_merge` justo no caso perigoso", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(REGRESSION_CHECKPOINT);
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    const r = await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true, force: true });
    expect(r.state).toBe("blocked_regressions");
  });

  it("já mergeado → merged (a sonda não reabre o que terminou)", async () => {
    const { db } = makeDb({ row: baseRow(evolExtra({ evolution_merged_at: "2026-09-04T00:00:00Z", evolution_merge_sha: "OLD" })) });
    expect(await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true })).toEqual({ state: "merged", sha: "OLD" });
  });

  it("merge real segue mergeando com force depois de uma sonda (a sonda não deixa resíduo)", async () => {
    checkpoint.readEvolutionCheckpoint.mockResolvedValue(REGRESSION_CHECKPOINT);
    const { db } = makeDb({ row: baseRow(evolExtra()) });
    expect((await tryAutoMergeEvolution(db as never, "child", { evaluateOnly: true })).state).toBe("blocked_regressions");
    const r = await tryAutoMergeEvolution(db as never, "child", { force: true, actorUserId: "u1" });
    expect(r).toMatchObject({ state: "merged", sha: "MERGESHA" });
  });
});
