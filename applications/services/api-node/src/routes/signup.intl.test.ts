/**
 * signup.intl.test.ts — cobre o cadastro internacional (2026-09-24): país opcional
 * (default 'BR'), CNPJ com checksum só no Brasil (fora daqui é texto livre), UF só é
 * maiúscula/2-letras no Brasil (fora daqui, estado/província fica como o usuário digitou).
 * Signup.ts não tinha teste nenhum antes desta mudança — este arquivo cobre só o que foi
 * alterado (não é uma suíte completa da rota).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/emailVerification.js", () => ({
  createVerificationCode: vi.fn(async () => ({ ok: true, expiresAt: new Date() })),
  verifyCode: vi.fn(async () => ({ ok: true })),
  invalidatePending: vi.fn(async () => {}),
}));
vi.mock("../services/inbox.js", () => ({
  resolveInboxProductId: vi.fn(async () => "inbox-product-id"),
}));
vi.mock("../services/emailSender.js", () => ({
  isSesConfigured: () => false,
  sendEmail: vi.fn(async () => {}),
  renderVerificationEmail: () => ({ subject: "", html: "", text: "" }),
}));

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
const clientQueryMock = vi.fn(async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  const s = sql.trim().toUpperCase();
  if (s.startsWith("BEGIN") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK")) return { rows: [] };
  if (s.includes("INSERT INTO TENANTS")) {
    return { rows: [{ id: "tenant-1", name: params[0], plan_id: params[1], status: "inactive", email: params[2], email_confirmed: true, created_at: new Date() }] };
  }
  if (s.includes("INSERT INTO USERS")) {
    return { rows: [{ id: "user-1", email: params[0], name: params[1], tenant_id: params[3], role: "tenant_admin", status: "active", created_at: new Date() }] };
  }
  if (s.includes("SELECT MONTHLY_PRICE_CENTS")) {
    return { rows: [{ monthly_price_cents: 0 }] };
  }
  if (s.includes("INSERT INTO CHARGES")) {
    return { rows: [] };
  }
  return { rows: [] };
});
const poolQueryMock = vi.fn(async (sql: string, params: unknown[] = []) => {
  const s = sql.trim().toUpperCase();
  if (s.startsWith("SELECT ID FROM PLANS")) return { rows: [{ id: params[0] }] };
  if (s.startsWith("SELECT ID FROM USERS")) return { rows: [] };
  return { rows: [] };
});
vi.mock("../db/client.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => clientQueryMock(sql, params),
      release: () => {},
    }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { signupRoutes } from "./signup.js";

let app: FastifyInstance;

beforeEach(async () => {
  calls.length = 0;
  clientQueryMock.mockClear();
  poolQueryMock.mockClear();
  app = Fastify();
  await app.register(signupRoutes);
  await app.ready();
});

function baseBody(overrides: Record<string, unknown>) {
  return {
    name: "Empresa Teste",
    planId: "plan_ouro",
    adminName: "Admin Teste",
    adminEmail: `qa-${Math.random().toString(36).slice(2)}@example.com`,
    password: "Sup3rSecret!",
    code: "123456",
    ...overrides,
  };
}

function tenantInsertCall(): Call {
  const c = calls.find((c) => c.sql.toUpperCase().includes("INSERT INTO TENANTS"));
  if (!c) throw new Error("INSERT INTO tenants não foi chamado");
  return c;
}

describe("POST /api/tenant/signup — cadastro internacional", () => {
  it("sem country (comportamento antigo): default BR, CNPJ inválido é rejeitado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tenant/signup",
      payload: baseBody({ cnpj: "11.111.111/0001-11" }), // dígitos verificadores errados
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: "CNPJ inválido" });
  });

  it("país não-Brasil: CNPJ/Tax ID vira texto livre (sem checksum) e persiste como enviado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tenant/signup",
      payload: baseBody({
        country: "Estados Unidos",
        cnpj: "US-TAX-98765",
        addressState: "California",
        addressCity: "San Francisco",
      }),
    });
    expect(res.statusCode).toBe(201);
    const insert = tenantInsertCall();
    // ordem dos params no INSERT: tenantName, planId, adminEmail, cnpj, country, ...,
    // addressCep, addressStreet, addressNumber, addressComplement, addressDistrict, addressCity, addressState
    expect(insert.params[3]).toBe("US-TAX-98765"); // cnpj livre, sem normalização/checksum
    expect(insert.params[4]).toBe("ESTADOS UNIDOS"); // country normalizado (upper), guardado como veio
    expect(insert.params[13]).toBe("San Francisco");
    expect(insert.params[14]).toBe("California"); // NÃO uppercased fora do Brasil
  });

  it("país Brasil explícito: UF vai em maiúsculas (comportamento preservado)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tenant/signup",
      payload: baseBody({ country: "Brasil", addressState: "sp", addressCity: "São Paulo" }),
    });
    expect(res.statusCode).toBe(201);
    const insert = tenantInsertCall();
    expect(insert.params[4]).toBe("BRASIL");
    expect(insert.params[14]).toBe("SP");
  });
});
