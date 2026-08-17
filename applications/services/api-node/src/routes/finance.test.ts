import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { recalcChargeStatus, maybeActivateTenant } from "./finance.js";

/**
 * Fake PoolClient dirigido por substring do SQL. Cada teste programa:
 *  - a linha da cobrança (amount_cents, status) devolvida pelo SELECT ... FOR UPDATE
 *  - a soma de pagamentos devolvida pelo SELECT SUM(...)
 * e captura os UPDATEs para assertar o estado final e o paid_at.
 */
function fakeClient(charge: { amount_cents: number; status: string } | null, paid: number) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM charges WHERE id")) {
        return { rows: charge ? [charge] : [] };
      }
      if (sql.includes("SUM(amount_cents)")) {
        return { rows: [{ paid: String(paid) }] };
      }
      if (sql.startsWith("UPDATE charges")) {
        updates.push({ sql, params: params ?? [] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, updates };
}

describe("recalcChargeStatus (M3 — único escritor de status por pagamentos)", () => {
  it("cobrança inexistente → null, sem UPDATE", async () => {
    const { client, updates } = fakeClient(null, 0);
    const r = await recalcChargeStatus(client, "x");
    expect(r).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("soma >= valor → paid, com paid_at = now()", async () => {
    const { client, updates } = fakeClient({ amount_cents: 10000, status: "open" }, 10000);
    const r = await recalcChargeStatus(client, "c1");
    expect(r).toEqual({ status: "paid", paidCents: 10000, amountCents: 10000 });
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("paid_at = now()");
    expect(updates[0].params[0]).toBe("paid");
  });

  it("0 < soma < valor → partially_paid, paid_at = NULL", async () => {
    const { client, updates } = fakeClient({ amount_cents: 10000, status: "open" }, 4000);
    const r = await recalcChargeStatus(client, "c1");
    expect(r?.status).toBe("partially_paid");
    expect(r?.paidCents).toBe(4000);
    expect(updates[0].sql).toContain("paid_at = NULL");
    expect(updates[0].params[0]).toBe("partially_paid");
  });

  it("sem pagamentos → volta a open", async () => {
    const { client, updates } = fakeClient({ amount_cents: 10000, status: "partially_paid" }, 0);
    const r = await recalcChargeStatus(client, "c1");
    expect(r?.status).toBe("open");
    expect(updates[0].params[0]).toBe("open");
  });

  it("cobrança canceled não é recomputada (estado terminal)", async () => {
    const { client, updates } = fakeClient({ amount_cents: 10000, status: "canceled" }, 10000);
    const r = await recalcChargeStatus(client, "c1");
    expect(r).toEqual({ status: "canceled", paidCents: 10000, amountCents: 10000 });
    expect(updates).toHaveLength(0);
  });

  it("cobrança draft não é recomputada por pagamento", async () => {
    const { client, updates } = fakeClient({ amount_cents: 10000, status: "draft" }, 5000);
    const r = await recalcChargeStatus(client, "c1");
    expect(r?.status).toBe("draft");
    expect(updates).toHaveLength(0);
  });

  it("valor zero com soma zero não vira paid (evita paid espúrio)", async () => {
    const { client, updates } = fakeClient({ amount_cents: 0, status: "open" }, 0);
    const r = await recalcChargeStatus(client, "c1");
    expect(r?.status).toBe("open");
    expect(updates[0].params[0]).toBe("open");
  });
});

/**
 * Fake para maybeActivateTenant (F2): programa o status do tenant e se há cobrança
 * de assinatura vencida. Captura UPDATE tenants e INSERT finance_audit.
 */
function fakeTenantClient(tenantStatus: string | null, hasOverdueSub: boolean) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT status FROM tenants WHERE id")) {
        return { rows: tenantStatus ? [{ status: tenantStatus }] : [] };
      }
      if (sql.includes("FROM charges") && sql.includes("status = 'overdue'")) {
        return { rows: hasOverdueSub ? [{ "?column?": 1 }] : [] };
      }
      calls.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("maybeActivateTenant (F2 — reativação por pagamento)", () => {
  it("tenant inexistente → false, sem UPDATE", async () => {
    const { client, calls } = fakeTenantClient(null, false);
    expect(await maybeActivateTenant(client, "t1", "u1")).toBe(false);
    expect(calls.filter((c) => c.sql.startsWith("UPDATE tenants"))).toHaveLength(0);
  });

  it("tenant já ativo → false, no-op", async () => {
    const { client, calls } = fakeTenantClient("active", false);
    expect(await maybeActivateTenant(client, "t1", "u1")).toBe(false);
    expect(calls.filter((c) => c.sql.startsWith("UPDATE tenants"))).toHaveLength(0);
  });

  it("inativo sem assinatura vencida → ativa + audita", async () => {
    const { client, calls } = fakeTenantClient("inactive", false);
    expect(await maybeActivateTenant(client, "t1", "u1")).toBe(true);
    const upd = calls.find((c) => c.sql.startsWith("UPDATE tenants"));
    expect(upd?.sql).toContain("status = 'active'");
    expect(calls.some((c) => c.sql.includes("INSERT INTO finance_audit"))).toBe(true);
  });

  it("suspenso mas ainda com assinatura vencida → NÃO reativa (evita flapping)", async () => {
    const { client, calls } = fakeTenantClient("suspended", true);
    expect(await maybeActivateTenant(client, "t1", "u1")).toBe(false);
    expect(calls.filter((c) => c.sql.startsWith("UPDATE tenants"))).toHaveLength(0);
  });

  it("suspenso e sem assinatura vencida → reativa", async () => {
    const { client } = fakeTenantClient("suspended", false);
    expect(await maybeActivateTenant(client, "t1", "u1")).toBe(true);
  });
});
