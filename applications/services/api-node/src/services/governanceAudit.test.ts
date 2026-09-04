import { describe, it, expect, vi } from "vitest";
import { recordSelfApproval } from "./governanceAudit.js";

function fakeDb(impl?: (sql: string, params: unknown[]) => unknown) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (impl) return impl(sql, params);
    return { rows: [], rowCount: 1 };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

const PID = "11111111-1111-4111-8111-111111111111";
const PRD = "22222222-2222-4222-8222-222222222222";
const USR = "33333333-3333-4333-8333-333333333333";

describe("governanceAudit.recordSelfApproval (R4 PR5 / D4)", () => {
  it("grava action=spec_self_approved com snapshot explícito de auto-aprovação", async () => {
    const db = fakeDb();
    await recordSelfApproval(db as never, {
      actorUserId: USR, actorEmail: "dono@tenant.com.br", actorRole: "tenant_admin",
      projectId: PID, productId: PRD, source: "specs_upload", rawValue: "validate-only",
    });
    expect(db.calls).toHaveLength(1);
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/INSERT INTO governance_audit/);
    expect(sql).toMatch(/'spec_self_approved'/);
    expect(params.slice(0, 4)).toEqual([USR, "tenant_admin", PID, PRD]);
    const snapshot = JSON.parse(params[4] as string);
    expect(snapshot).toMatchObject({ selfApproved: true, approvedBy: "dono@tenant.com.br", approvedByIsSubmitter: true, source: "specs_upload", rawValue: "validate-only" });
  });

  it("sub não-UUID (token estático) vira NULL nas colunas UUID e fica no snapshot", async () => {
    const db = fakeDb();
    await recordSelfApproval(db as never, { actorUserId: "runner-service", actorRole: "user", projectId: "nao-uuid", source: "products_ingest_zip" });
    const { params } = db.calls[0];
    expect(params[0]).toBeNull();
    expect(params[2]).toBeNull();
    expect(JSON.parse(params[4] as string).actorSub).toBe("runner-service");
  });

  it("falha do banco NÃO propaga (auditoria é best-effort)", async () => {
    const db = fakeDb(() => { throw new Error("CHECK violation"); });
    await expect(recordSelfApproval(db as never, { actorUserId: USR, actorRole: "user", source: "products_ingest_proposal" })).resolves.toBeUndefined();
  });
});
