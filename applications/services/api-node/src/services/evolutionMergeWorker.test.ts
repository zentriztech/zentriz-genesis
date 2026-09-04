/**
 * evolutionMergeWorker.test.ts — Bloco 4 (M2): o observador seleciona só evoluções aceitas com PR
 * pendente e não mergeado, delega a `tryAutoMergeEvolution` (actor "external"), conta os merges e é
 * resiliente a falha por projeto. start/stop respeita a flag EVOLUTION_MERGE_WATCH (default OFF).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const merge = { tryAutoMergeEvolution: vi.fn() };
vi.mock("./evolutionMerge.js", () => merge);
vi.mock("../db/client.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const { reconcileEvolutionMerges, startEvolutionMergeWorker, stopEvolutionMergeWorker } = await import("./evolutionMergeWorker.js");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EVOLUTION_MERGE_WATCH;
});
afterEach(() => stopEvolutionMergeWorker());

describe("reconcileEvolutionMerges", () => {
  it("seleciona candidatos e delega a tryAutoMergeEvolution com actor 'external'; conta merges", async () => {
    merge.tryAutoMergeEvolution
      .mockResolvedValueOnce({ state: "merged", sha: "a" })
      .mockResolvedValueOnce({ state: "blocked_checks" });
    const db = { query: vi.fn(async (sql: string) => {
      expect(sql).toMatch(/status = 'accepted'/);
      expect(sql).toMatch(/evolution_pr_number' IS NOT NULL/);
      expect(sql).toMatch(/evolution_merged_at' IS NULL/);
      return { rows: [{ id: "p1" }, { id: "p2" }] };
    }) };
    const r = await reconcileEvolutionMerges(db as never);
    expect(r).toEqual({ scanned: 2, merged: 1 });
    expect(merge.tryAutoMergeEvolution).toHaveBeenCalledWith(db, "p1", { actorUserId: "external" });
    expect(merge.tryAutoMergeEvolution).toHaveBeenCalledWith(db, "p2", { actorUserId: "external" });
  });

  it("falha em um projeto não derruba o tick nem os demais", async () => {
    merge.tryAutoMergeEvolution
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ state: "merged" });
    const db = { query: vi.fn(async () => ({ rows: [{ id: "p1" }, { id: "p2" }] })) };
    const r = await reconcileEvolutionMerges(db as never);
    expect(r).toEqual({ scanned: 2, merged: 1 });
  });

  it("nenhum candidato → não chama o merge", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const r = await reconcileEvolutionMerges(db as never);
    expect(r).toEqual({ scanned: 0, merged: 0 });
    expect(merge.tryAutoMergeEvolution).not.toHaveBeenCalled();
  });
});

describe("start/stop worker", () => {
  it("flag OFF → não inicia timer (idempotente)", () => {
    startEvolutionMergeWorker();
    // sem flag, start é no-op — stop não deve lançar
    expect(() => stopEvolutionMergeWorker()).not.toThrow();
  });

  it("flag ON → inicia e para sem lançar", () => {
    process.env.EVOLUTION_MERGE_WATCH = "on";
    startEvolutionMergeWorker();
    startEvolutionMergeWorker(); // idempotente
    expect(() => stopEvolutionMergeWorker()).not.toThrow();
  });
});
