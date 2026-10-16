import { describe, it, expect, vi, afterEach } from "vitest";
import { readRuntimeNumber } from "./runtimeTunables.js";

const T = "11111111-1111-4111-8111-111111111111";
const B = { min: 8_000, max: 32_000 };
const dbWith = (rows: Array<Record<string, unknown>>) => ({ query: vi.fn(async () => ({ rows })) });

afterEach(() => vi.restoreAllMocks());

describe("readRuntimeNumber", () => {
  it("devolve o inteiro configurado e consulta chave + tenant (override do tenant antes do global)", async () => {
    const db = dbWith([{ value: "20000" }]);
    await expect(readRuntimeNumber(db, "SPEC_CHAT_MAX_TOKENS", T, B)).resolves.toBe(20_000);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["SPEC_CHAT_MAX_TOKENS", T]);
    expect(sql).toContain("tenant_id IS NULL OR tenant_id = $2");
    expect(sql).toContain("ORDER BY tenant_id NULLS LAST");   // override do tenant vence o global
    expect(sql).toContain("LIMIT 1");
  });

  it("sem tenant só o global entra (tenant_id = NULL nunca casa)", async () => {
    const db = dbWith([{ value: "32000" }]);
    await expect(readRuntimeNumber(db, "K", null, B)).resolves.toBe(32_000);
    expect((db.query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(["K", null]);
  });

  it("chave ausente → null (o chamador usa o comportamento histórico)", async () => {
    await expect(readRuntimeNumber(dbWith([]), "K", T, B)).resolves.toBeNull();
  });

  it.each(["abc", "", "7999", "32001", "9000.5", "NaN", "-1"])("valor %j fora do contrato → null e com aviso", async (v) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readRuntimeNumber(dbWith([{ value: v }]), "K", T, B)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("banco fora → null com aviso (nunca derruba o chat)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { query: vi.fn(async () => { throw new Error("conexão recusada"); }) };
    await expect(readRuntimeNumber(db, "K", T, B)).resolves.toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain("conexão recusada");
  });
});
