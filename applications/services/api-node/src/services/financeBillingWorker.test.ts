/**
 * financeBillingWorker.test.ts — RFC-0002 Parte B (F2).
 *
 * Cobre o control-flow da passada de billing: transação BEGIN/COMMIT, as duas
 * UPDATEs (vencimento + suspensão), uma linha de auditoria por tenant suspenso,
 * invalidação de cache pós-COMMIT e ROLLBACK em erro. A correção da aritmética de
 * datas (fuso SP + carência) roda contra o Postgres real e é validada em runtime;
 * aqui garantimos que o worker chama o que deve e na ordem certa.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Q = { sql: string; params: unknown[] };

let calls: Q[] = [];
// Respostas programáveis por chamada, dirigidas por substring do SQL.
let overdueRows: Array<{ id: string }> = [];
let suspendedRows: Array<{ id: string }> = [];
let throwOnSuspend = false;
// Gate opcional para segurar o BEGIN em voo (usado no teste da guarda de reentrância).
let beginGate: Promise<void> | null = null;

const fakeClient = {
  query: async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    if (sql === "BEGIN" && beginGate) await beginGate;
    if (sql.startsWith("UPDATE charges")) return { rows: overdueRows, rowCount: overdueRows.length };
    if (sql.startsWith("UPDATE tenants")) {
      if (throwOnSuspend) throw new Error("boom");
      return { rows: suspendedRows, rowCount: suspendedRows.length };
    }
    return { rows: [], rowCount: 0 };
  },
  release: vi.fn(),
};

vi.mock("../db/client.js", () => ({
  pool: { connect: async () => fakeClient },
}));

const bustTenantStatus = vi.fn();
vi.mock("./tenantStatusCache.js", () => ({
  bustTenantStatus: (id: string) => bustTenantStatus(id),
}));

import { runFinanceBillingOnce, tick } from "./financeBillingWorker.js";

beforeEach(() => {
  calls = [];
  overdueRows = [];
  suspendedRows = [];
  throwOnSuspend = false;
  beginGate = null;
  bustTenantStatus.mockClear();
  fakeClient.release.mockClear();
});

describe("runFinanceBillingOnce (F2 — vencimento + suspensão)", () => {
  it("abre e fecha a transação (BEGIN … COMMIT) e libera a conexão", async () => {
    await runFinanceBillingOnce();
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls).toContain("COMMIT");
    expect(sqls.indexOf("BEGIN")).toBeLessThan(sqls.indexOf("COMMIT"));
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
  });

  it("vencimento só toca open/partially_paid com prazo passado (fuso SP)", async () => {
    await runFinanceBillingOnce();
    const upd = calls.find((c) => c.sql.startsWith("UPDATE charges"))!;
    expect(upd.sql).toContain("status IN ('open', 'partially_paid')");
    expect(upd.sql).toContain("America/Sao_Paulo");
    expect(upd.sql).toContain("SET status = 'overdue'");
  });

  it("suspensão só tenant ativo com assinatura vencida além da carência", async () => {
    await runFinanceBillingOnce();
    const upd = calls.find((c) => c.sql.startsWith("UPDATE tenants"))!;
    expect(upd.sql).toContain("t.status = 'active'");
    expect(upd.sql).toContain("c.kind = 'subscription'");
    expect(upd.sql).toContain("c.status = 'overdue'");
    // carência passada como parâmetro inteiro (default 3)
    expect(upd.params[0]).toBe(3);
  });

  it("audita e invalida cache uma vez por tenant suspenso — só após COMMIT", async () => {
    overdueRows = [{ id: "c1" }, { id: "c2" }];
    suspendedRows = [{ id: "t1" }, { id: "t2" }];
    const r = await runFinanceBillingOnce();

    const audits = calls.filter((c) => c.sql.includes("INSERT INTO finance_audit"));
    expect(audits).toHaveLength(2);
    expect(audits[0].sql).toContain("'tenant'");
    expect(audits[0].sql).toContain("'suspend'");

    // Cache bust só depois do COMMIT.
    const commitIdx = calls.findIndex((c) => c.sql === "COMMIT");
    const auditIdx = calls.findIndex((c) => c.sql.includes("INSERT INTO finance_audit"));
    expect(auditIdx).toBeLessThan(commitIdx);
    expect(bustTenantStatus).toHaveBeenCalledTimes(2);
    expect(bustTenantStatus).toHaveBeenCalledWith("t1");
    expect(bustTenantStatus).toHaveBeenCalledWith("t2");

    expect(r).toEqual({ markedOverdue: 2, suspended: 2 });
  });

  it("nada vencido/suspenso → sem auditoria, sem bust", async () => {
    const r = await runFinanceBillingOnce();
    expect(calls.some((c) => c.sql.includes("INSERT INTO finance_audit"))).toBe(false);
    expect(bustTenantStatus).not.toHaveBeenCalled();
    expect(r).toEqual({ markedOverdue: 0, suspended: 0 });
  });

  it("erro no meio → ROLLBACK, não faz bust e libera a conexão", async () => {
    throwOnSuspend = true;
    await expect(runFinanceBillingOnce()).rejects.toThrow("boom");
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.map((c) => c.sql)).not.toContain("COMMIT");
    expect(bustTenantStatus).not.toHaveBeenCalled();
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
  });
});

describe("tick (guarda de reentrância)", () => {
  it("pula a passada se uma anterior ainda está em voo", async () => {
    let release!: () => void;
    beginGate = new Promise<void>((res) => { release = res; });

    const p1 = tick();   // entra, seta running=true e trava no BEGIN (gate)
    const p2 = tick();   // running=true → deve pular sem tocar o banco

    release();           // libera a 1ª passada
    await Promise.all([p1, p2]);

    // Só a 1ª passada abriu transação/conexão; a 2ª foi ignorada.
    expect(calls.filter((c) => c.sql === "BEGIN")).toHaveLength(1);
    expect(fakeClient.release).toHaveBeenCalledTimes(1);
  });

  it("após terminar, uma nova passada roda normalmente (running foi resetado)", async () => {
    await tick();
    await tick();
    expect(calls.filter((c) => c.sql === "BEGIN")).toHaveLength(2);
  });
});
