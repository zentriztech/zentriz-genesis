/**
 * dependencyGate.test.ts — gate de dependência + contrato (RFC-0003, G3/C3).
 * Fonte única compartilhada por /run e pela cascata/promoção (dispatchProjectRun).
 */
import { describe, it, expect, afterEach } from "vitest";
import { checkDependencyGate, type Queryable } from "./dependencyGate.js";

function queryableWithTriggers(rows: Record<string, unknown>[]): Queryable {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM project_triggers")) return { rows };
      return { rows: [] };
    },
  };
}

const savedFilesRoot = process.env.PROJECT_FILES_ROOT;
const savedHostRoot = process.env.HOST_PROJECT_FILES_ROOT;
afterEach(() => {
  if (savedFilesRoot === undefined) delete process.env.PROJECT_FILES_ROOT;
  else process.env.PROJECT_FILES_ROOT = savedFilesRoot;
  if (savedHostRoot === undefined) delete process.env.HOST_PROJECT_FILES_ROOT;
  else process.env.HOST_PROJECT_FILES_ROOT = savedHostRoot;
});

describe("checkDependencyGate", () => {
  it("sem predecessores → ok", async () => {
    const r = await checkDependencyGate(queryableWithTriggers([]), "p1");
    expect(r.ok).toBe(true);
  });

  it("predecessor não concluído → DEPENDENCY_NOT_READY", async () => {
    const r = await checkDependencyGate(
      queryableWithTriggers([{ trigger_project_id: "t1", title: "API", status: "running", product_id: "prod1" }]),
      "p1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block.code).toBe("DEPENDENCY_NOT_READY");
      expect(r.block.blockers?.[0]).toMatchObject({ id: "t1", status: "running" });
    }
  });

  it("todos accepted e PROJECT_FILES_ROOT ausente → ok (não checa contrato em disco)", async () => {
    delete process.env.PROJECT_FILES_ROOT;
    delete process.env.HOST_PROJECT_FILES_ROOT;
    const r = await checkDependencyGate(
      queryableWithTriggers([{ trigger_project_id: "t1", title: "API", status: "accepted", product_id: "prod1" }]),
      "p1",
    );
    expect(r.ok).toBe(true);
  });

  it("accepted mas sem api_contract.md em disco (filesRoot definido) → CONTRACT_MISSING", async () => {
    process.env.PROJECT_FILES_ROOT = "/tmp/genesis-nonexistent-files-root";
    const r = await checkDependencyGate(
      queryableWithTriggers([{ trigger_project_id: "t1", title: "orders-api", status: "accepted", product_id: "prod1" }]),
      "p1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.block.code).toBe("CONTRACT_MISSING");
  });

  it("predecessor DB-only é exceção ao contrato (não bloqueia)", async () => {
    process.env.PROJECT_FILES_ROOT = "/tmp/genesis-nonexistent-files-root";
    const r = await checkDependencyGate(
      queryableWithTriggers([{ trigger_project_id: "t1", title: "orders-db", status: "accepted", product_id: "prod1" }]),
      "p1",
    );
    expect(r.ok).toBe(true);
  });
});
