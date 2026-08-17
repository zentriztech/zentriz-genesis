/**
 * invoiceProvider.test.ts — RFC-0002 Parte B (F3).
 * Garante o contrato da porta e do stub interno + o singleton plugável.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  InternalInvoiceProvider,
  getInvoiceProvider,
  _setInvoiceProvider,
  type InvoiceProvider,
} from "./invoiceProvider.js";

afterEach(() => {
  // Restaura o provedor padrão para não vazar estado entre testes.
  _setInvoiceProvider(new InternalInvoiceProvider());
});

describe("InternalInvoiceProvider (stub F3)", () => {
  it("nome é 'internal'", () => {
    expect(new InternalInvoiceProvider().name).toBe("internal");
  });

  it("deriva a referência do número (zero-padded 6 dígitos)", async () => {
    const p = new InternalInvoiceProvider();
    const r = await p.issue({ number: 42, tenantId: "t1", amountCents: 10000 });
    expect(r).toEqual({ provider: "internal", providerRef: "INT-000042" });
  });

  it("número grande não é truncado no padding", async () => {
    const p = new InternalInvoiceProvider();
    const r = await p.issue({ number: 1234567, tenantId: "t1", amountCents: 1 });
    expect(r.providerRef).toBe("INT-1234567");
  });
});

describe("singleton plugável", () => {
  it("getInvoiceProvider devolve o interno por padrão", () => {
    expect(getInvoiceProvider().name).toBe("internal");
  });

  it("_setInvoiceProvider troca o adaptador (preparo para F4)", async () => {
    const fake: InvoiceProvider = {
      name: "focus-nfe",
      async issue() { return { provider: "focus-nfe", providerRef: "NFSe-999" }; },
    };
    _setInvoiceProvider(fake);
    expect(getInvoiceProvider().name).toBe("focus-nfe");
    const r = await getInvoiceProvider().issue({ number: 1, tenantId: "t1", amountCents: 1 });
    expect(r.providerRef).toBe("NFSe-999");
  });
});
