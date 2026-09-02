/**
 * deployCredentials.test.ts — política do pipeline do HOST (flag + whitelist + fail-closed).
 *
 * Modelo: o host SEMPRE publica na conta da Zentriz; só a whitelist pode usar essa infra pelo
 * host; qualquer outro tenant é bloqueado (o cloud dele é servido por GitHub Actions). Não há
 * mais roteamento para a conta do tenant pelo host (o antigo source "tenant" / GATE 2).
 *
 * Matriz coberta:
 *   - flag OFF (default)                 → "zentriz-fallback" (legado), SEM tocar o banco;
 *   - flag ON + whitelist via env CSV    → "zentriz-whitelist";
 *   - flag ON + whitelist via coluna DB  → "zentriz-whitelist";
 *   - flag ON + fora da whitelist        → "blocked" (fail-closed; razão cita GitHub Actions);
 *   - helpers isByocEnforced / isTenantExemptEnv / isTenantExempt (env + DB + degradação).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const query = vi.fn();
vi.mock("../../db/client.js", () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
}));

import {
  resolveDeployCredentials,
  isByocEnforced,
  isTenantExempt,
  isTenantExemptEnv,
} from "./deployCredentials.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CABRAL = "22222222-2222-2222-2222-222222222222";
const SALIF = "33333333-3333-3333-3333-333333333333";

const ENV_KEYS = ["GENESIS_BYOC_ENFORCED", "GENESIS_BYOC_EXEMPT_TENANTS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  query.mockReset();
  // Default: nenhum tenant marcado no banco.
  query.mockResolvedValue({ rows: [] });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isByocEnforced (a chave)", () => {
  it("default (unset) é OFF", () => {
    expect(isByocEnforced()).toBe(false);
  });
  it.each(["1", "true", "TRUE", "yes", "on", " On "])("liga com %j", (v) => {
    process.env.GENESIS_BYOC_ENFORCED = v;
    expect(isByocEnforced()).toBe(true);
  });
  it.each(["0", "false", "no", "off", ""])("segue OFF com %j", (v) => {
    process.env.GENESIS_BYOC_ENFORCED = v;
    expect(isByocEnforced()).toBe(false);
  });
});

describe("isTenantExemptEnv (whitelist via env CSV)", () => {
  it("vazio → ninguém isento", () => {
    expect(isTenantExemptEnv(TENANT)).toBe(false);
  });
  it("CSV com espaços e case-insensitive", () => {
    process.env.GENESIS_BYOC_EXEMPT_TENANTS = ` ${CABRAL.toUpperCase()} , ${SALIF} `;
    expect(isTenantExemptEnv(CABRAL)).toBe(true);
    expect(isTenantExemptEnv(SALIF)).toBe(true);
    expect(isTenantExemptEnv(TENANT)).toBe(false);
  });
});

describe("isTenantExempt (env + coluna DB)", () => {
  it("env CSV isenta sem tocar o banco", async () => {
    process.env.GENESIS_BYOC_EXEMPT_TENANTS = CABRAL;
    expect(await isTenantExempt(CABRAL)).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
  it("coluna byoc_exempt=true isenta", async () => {
    query.mockResolvedValue({ rows: [{ byoc_exempt: true }] });
    expect(await isTenantExempt(TENANT)).toBe(true);
  });
  it("coluna byoc_exempt=false / sem linha → não isento", async () => {
    query.mockResolvedValue({ rows: [{ byoc_exempt: false }] });
    expect(await isTenantExempt(TENANT)).toBe(false);
    query.mockResolvedValue({ rows: [] });
    expect(await isTenantExempt(TENANT)).toBe(false);
  });
  it("erro de banco degrada para não isento (fail-closed)", async () => {
    query.mockRejectedValue(new Error("db down"));
    expect(await isTenantExempt(TENANT)).toBe(false);
  });
});

describe("resolveDeployCredentials", () => {
  it("flag OFF → zentriz-fallback SEM tocar o banco (anti-regressão)", async () => {
    const d = await resolveDeployCredentials(TENANT);
    expect(d.source).toBe("zentriz-fallback");
    expect(query).not.toHaveBeenCalled();
  });

  it("flag ON + whitelist via env → zentriz-whitelist", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "true";
    process.env.GENESIS_BYOC_EXEMPT_TENANTS = `${CABRAL},${SALIF}`;
    expect((await resolveDeployCredentials(CABRAL)).source).toBe("zentriz-whitelist");
    expect((await resolveDeployCredentials(SALIF)).source).toBe("zentriz-whitelist");
  });

  it("flag ON + whitelist via coluna DB → zentriz-whitelist", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "1";
    query.mockResolvedValue({ rows: [{ byoc_exempt: true }] });
    expect((await resolveDeployCredentials(TENANT)).source).toBe("zentriz-whitelist");
  });

  it("flag ON + fora da whitelist → blocked (fail-closed, cita GitHub Actions)", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "true";
    query.mockResolvedValue({ rows: [{ byoc_exempt: false }] });
    const d = await resolveDeployCredentials(TENANT);
    expect(d.source).toBe("blocked");
    if (d.source === "blocked") expect(d.reason).toMatch(/GitHub Actions/i);
  });
});
