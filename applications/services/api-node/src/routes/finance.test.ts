import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { recalcChargeStatus, maybeActivateTenant, issueInvoiceForCharge } from "./finance.js";

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

/**
 * Fake para issueInvoiceForCharge (F3): programa a cobrança devolvida pelo SELECT ...
 * FOR UPDATE e se já existe nota emitida (dup). Captura INSERT/UPDATE/audit e devolve
 * uma linha de nota com número sequencial fixo (42) para checar a referência do provedor.
 */
function fakeInvoiceClient(
  charge: Record<string, unknown> | null,
  hasIssuedInvoice: boolean,
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("FOR UPDATE OF c")) {
        return { rows: charge ? [charge] : [] };
      }
      if (sql.includes("FROM invoices WHERE charge_id")) {
        return { rows: hasIssuedInvoice ? [{ id: "inv-existing" }] : [] };
      }
      if (sql.startsWith("INSERT INTO invoices")) {
        return { rows: [{ id: "inv1", number: 42, tenant_id: charge?.tenant_id, charge_id: "c1", amount_cents: charge?.amount_cents, status: "issued", provider: "internal", provider_ref: null }] };
      }
      if (sql.startsWith("UPDATE invoices SET provider")) {
        return { rows: [{ id: "inv1", number: 42, tenant_id: charge?.tenant_id, charge_id: "c1", amount_cents: charge?.amount_cents, status: "issued", provider: params?.[0], provider_ref: params?.[1] }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("issueInvoiceForCharge (F3 — emissão de nota interna a partir de cobrança paga)", () => {
  it("cobrança inexistente → 404, sem INSERT", async () => {
    const { client, calls } = fakeInvoiceClient(null, false);
    const r = await issueInvoiceForCharge(client, "c1", "u1");
    expect(r).toEqual({ ok: false, httpStatus: 404, code: "NOT_FOUND", message: "Cobrança não encontrada" });
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO invoices"))).toBe(false);
  });

  it("cobrança não paga → 409, sem INSERT", async () => {
    const { client, calls } = fakeInvoiceClient({ id: "c1", tenant_id: "t1", amount_cents: 10000, status: "open", competence_month: "2026-08", description: null }, false);
    const r = await issueInvoiceForCharge(client, "c1", "u1");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.httpStatus).toBe(409); expect(r.message).toContain("cobrança paga"); }
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO invoices"))).toBe(false);
  });

  it("cobrança paga que já tem nota emitida → 409 (dupla emissão)", async () => {
    const { client, calls } = fakeInvoiceClient({ id: "c1", tenant_id: "t1", amount_cents: 10000, status: "paid", competence_month: "2026-08", description: "Assinatura 2026-08" }, true);
    const r = await issueInvoiceForCharge(client, "c1", "u1");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.httpStatus).toBe(409); expect(r.code).toBe("CONFLICT"); }
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO invoices"))).toBe(false);
  });

  it("cobrança paga sem nota → emite, deriva ref do provedor e audita", async () => {
    const { client, calls } = fakeInvoiceClient({ id: "c1", tenant_id: "t1", amount_cents: 10000, status: "paid", competence_month: "2026-08", description: "Assinatura 2026-08", tenant_name: "ACME" }, false);
    const r = await issueInvoiceForCharge(client, "c1", "u1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Provedor interno deriva INT-<número zero-padded 6>.
      expect(r.invoice.provider).toBe("internal");
      expect(r.invoice.provider_ref).toBe("INT-000042");
    }
    // UPDATE grava o provider_ref e há uma linha de auditoria 'invoice'/'issue'.
    const upd = calls.find((c) => c.sql.startsWith("UPDATE invoices SET provider"));
    expect(upd?.params[1]).toBe("INT-000042");
    const auditCall = calls.find((c) => c.sql.includes("INSERT INTO finance_audit"));
    expect(auditCall?.params[0]).toBe("invoice");
    expect(auditCall?.params[2]).toBe("issue");
  });

  it("cobrança paga sem descrição → usa descrição sintética por cobrança", async () => {
    const { client, calls } = fakeInvoiceClient({ id: "c1", tenant_id: "t1", amount_cents: 5000, status: "paid", competence_month: null, description: null }, false);
    const r = await issueInvoiceForCharge(client, "c1", "u1");
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.sql.startsWith("INSERT INTO invoices"));
    // params: [tenant_id, charge_id, amount_cents, description, competence_month, created_by]
    expect(String(ins?.params[3])).toContain("Nota referente à cobrança c1");
  });
});
