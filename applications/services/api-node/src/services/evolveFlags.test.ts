/**
 * Fase 1' — resolução da flag EVOLVE_CLAIM e do saldo livre mínimo (sem banco: db falso).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { evolveClaimEnabled, evolveClaimEnvOverride, readEvolveMinFreeBudgetUsd } from "./evolveFlags.js";

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
      const v = (tenant && config.tenant?.[tenant]) ?? config.global;
      return { rows: v === undefined ? [] : [{ value: v }] };
    },
  };
}

describe("EVOLVE_CLAIM — resolução da flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("padrão OFF: sem env e sem linha de configuração", async () => {
    vi.stubEnv("EVOLVE_CLAIM", "");
    expect(await evolveClaimEnabled(fakeDb({}), { parentProjectId: "p", userTenantId: "t" })).toBe(false);
  });
  it("env on/off vence tudo (chave geral) e não consulta o banco", async () => {
    const db = fakeDb({ global: "1" });
    vi.stubEnv("EVOLVE_CLAIM", "off");
    expect(await evolveClaimEnabled(db, { parentProjectId: "p" })).toBe(false);
    vi.stubEnv("EVOLVE_CLAIM", "on");
    expect(await evolveClaimEnabled(db, { parentProjectId: "p" })).toBe(true);
    expect(db.calls).toHaveLength(0);
    vi.stubEnv("EVOLVE_CLAIM", "1");
    expect(evolveClaimEnvOverride()).toBe(true);
    vi.stubEnv("EVOLVE_CLAIM", "banana");
    expect(evolveClaimEnvOverride()).toBeNull();
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
