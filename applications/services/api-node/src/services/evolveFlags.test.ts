/**
 * Fase 1' — resolução da flag EVOLVE_CLAIM e do saldo livre mínimo (sem banco: db falso).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { evolveClaimEnabled, evolveClaimEnvDefault, readEvolveMinFreeBudgetUsd } from "./evolveFlags.js";

type Row = Record<string, unknown>;
function fakeDb(config: { global?: string; tenant?: Record<string, string>; parentTenant?: string | null; fail?: boolean }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> {
      calls.push({ sql, params });
      if (config.fail) throw new Error("db down");
      if (/FROM projects/.test(sql)) return { rows: config.parentTenant === undefined ? [] : [{ tenant_id: config.parentTenant }] };
      const tenant = params?.[1] as string | null;
      const rows: Row[] = [];
      if (tenant && config.tenant?.[tenant] !== undefined) rows.push({ tenant_id: tenant, value: config.tenant[tenant] });
      if (config.global !== undefined) rows.push({ tenant_id: null, value: config.global });
      return { rows: rows.slice(0, /LIMIT 1/.test(sql) ? 1 : rows.length) };
    },
  };
}

describe("EVOLVE_CLAIM — resolução da flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("padrão OFF: sem env e sem linha de configuração", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "");
    expect(await evolveClaimEnabled(fakeDb({}), { parentProjectId: "p", userTenantId: "t" })).toBe(false);
  });
  it("M-03: o env é só o DEFAULT de plataforma — vale sem linha de config e NUNCA sobrepõe o tenant nem o global", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "on");
    expect(await evolveClaimEnabled(fakeDb({}), { parentProjectId: "p" })).toBe(true); // sem config: env liga
    expect(await evolveClaimEnabled(fakeDb({ tenant: { A: "0" }, parentTenant: "A" }), { parentProjectId: "p" })).toBe(false); // tenant 0 vence env on
    expect(await evolveClaimEnabled(fakeDb({ global: "0" }), { parentProjectId: "p" })).toBe(false); // global 0 vence env on
    vi.stubEnv("EVOLVE_CLAIM", "off");
    expect(await evolveClaimEnabled(fakeDb({ tenant: { A: "1" }, parentTenant: "A" }), { parentProjectId: "p" })).toBe(true); // tenant 1 vence env off
    expect(await evolveClaimEnabled(fakeDb({ global: "1" }), { parentProjectId: "p" })).toBe(true);
    vi.stubEnv("EVOLVE_CLAIM", "1");
    expect(evolveClaimEnvDefault()).toBe(true);
    vi.stubEnv("EVOLVE_CLAIM", "banana");
    expect(evolveClaimEnvDefault()).toBeNull();
  });
  it("sem env: genesis_runtime_config global 1 liga; override do TENANT DO RECURSO vence o global (leitura por tenant pronta)", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "");
    expect(await evolveClaimEnabled(fakeDb({ global: "1", parentTenant: "A" }), { parentProjectId: "p" })).toBe(true);
    expect(await evolveClaimEnabled(fakeDb({ global: "1", tenant: { A: "0" }, parentTenant: "A" }), { parentProjectId: "p" })).toBe(false);
    expect(await evolveClaimEnabled(fakeDb({ global: "0", tenant: { A: "1" }, parentTenant: "A" }), { parentProjectId: "p" })).toBe(true);
    // tenant do recurso primeiro, o do usuário como reserva
    expect(await evolveClaimEnabled(fakeDb({ global: "0", tenant: { U: "1" } }), { parentProjectId: "p", userTenantId: "U" })).toBe(true);
  });
  it("valor inválido ou erro de banco ⇒ OFF (nunca lança)", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "");
    expect(await evolveClaimEnabled(fakeDb({ global: "2" }), { parentProjectId: "p" })).toBe(false);
    expect(await evolveClaimEnabled(fakeDb({ global: "talvez" }), { parentProjectId: "p" })).toBe(false);
    expect(await evolveClaimEnabled(fakeDb({ fail: true }), { parentProjectId: "p" })).toBe(false);
  });
  it("saldo livre mínimo vem do banco (não de constante): ausente ⇒ null; inválido ⇒ null; tenant vence global", async () => {
    expect(await readEvolveMinFreeBudgetUsd(fakeDb({}), "T")).toBeNull();
    expect(await readEvolveMinFreeBudgetUsd(fakeDb({ global: "5" }), "T")).toBe(5);
    expect(await readEvolveMinFreeBudgetUsd(fakeDb({ global: "5", tenant: { T: "0" } }), "T")).toBe(0);
    expect(await readEvolveMinFreeBudgetUsd(fakeDb({ global: "-3" }), "T")).toBeNull();
  });
});
