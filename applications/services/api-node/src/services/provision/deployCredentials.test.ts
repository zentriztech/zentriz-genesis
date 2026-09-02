/**
 * deployCredentials.test.ts — política BYOC do pipeline (flag + whitelist + fail-closed).
 *
 * Matriz coberta:
 *   - flag OFF (default)                       → "zentriz-fallback" (legado), SEM consultar o banco;
 *   - flag ON + tenant com chaves estáticas    → "tenant" (BYOC, empurra na conta dele);
 *   - flag ON + tenant só-role (cross-account) → "blocked" (GATE 2 pendente; não cai na Zentriz);
 *   - flag ON + sem conta + na whitelist        → "zentriz-whitelist";
 *   - flag ON + sem conta + fora da whitelist   → "blocked" (fail-closed);
 *   - helpers isByocEnforced / isTenantExempt (parsing das envs).
 *
 * getAwsDeployCredentials é dublê (a leitura+decrypt do banco tem teste próprio em
 * cloudConnector.test.ts); aqui isolamos a DECISÃO de política.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getAwsDeployCredentials = vi.fn();
vi.mock("../cloudConnector.js", () => ({
  getAwsDeployCredentials: (...args: unknown[]) => getAwsDeployCredentials(...args),
}));

import {
  resolveDeployCredentials,
  isByocEnforced,
  isTenantExempt,
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
  getAwsDeployCredentials.mockReset();
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

describe("isTenantExempt (whitelist Cabral/Salif)", () => {
  it("vazio → ninguém isento", () => {
    expect(isTenantExempt(TENANT)).toBe(false);
  });
  it("CSV com espaços e case-insensitive", () => {
    process.env.GENESIS_BYOC_EXEMPT_TENANTS = ` ${CABRAL.toUpperCase()} , ${SALIF} `;
    expect(isTenantExempt(CABRAL)).toBe(true);
    expect(isTenantExempt(SALIF)).toBe(true);
    expect(isTenantExempt(TENANT)).toBe(false);
  });
});

describe("resolveDeployCredentials", () => {
  it("flag OFF → zentriz-fallback SEM tocar o banco (anti-regressão)", async () => {
    const d = await resolveDeployCredentials(TENANT);
    expect(d.source).toBe("zentriz-fallback");
    expect(getAwsDeployCredentials).not.toHaveBeenCalled();
  });

  it("flag ON + tenant com chaves estáticas → tenant (BYOC)", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "true";
    getAwsDeployCredentials.mockResolvedValue({
      accessKeyId: "AKIATENANT",
      secretAccessKey: "sekret",
      region: "eu-west-1",
      roleArn: null,
    });
    const d = await resolveDeployCredentials(TENANT);
    expect(d).toEqual({
      source: "tenant",
      accessKeyId: "AKIATENANT",
      secretAccessKey: "sekret",
      region: "eu-west-1",
      roleArn: null,
    });
  });

  it("flag ON + tenant só-role (sem chaves) → blocked (GATE 2 pendente)", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "on";
    getAwsDeployCredentials.mockResolvedValue({
      accessKeyId: "",
      secretAccessKey: "",
      region: "eu-central-1",
      roleArn: "arn:aws:iam::999:role/x",
    });
    const d = await resolveDeployCredentials(TENANT);
    expect(d.source).toBe("blocked");
    if (d.source === "blocked") expect(d.reason).toMatch(/role|GATE 2/i);
  });

  it("flag ON + sem conta + na whitelist → zentriz-whitelist (Cabral/Salif)", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "1";
    process.env.GENESIS_BYOC_EXEMPT_TENANTS = `${CABRAL},${SALIF}`;
    getAwsDeployCredentials.mockResolvedValue(null);
    expect((await resolveDeployCredentials(CABRAL)).source).toBe("zentriz-whitelist");
    expect((await resolveDeployCredentials(SALIF)).source).toBe("zentriz-whitelist");
  });

  it("flag ON + sem conta + fora da whitelist → blocked (fail-closed)", async () => {
    process.env.GENESIS_BYOC_ENFORCED = "true";
    getAwsDeployCredentials.mockResolvedValue(null);
    const d = await resolveDeployCredentials(TENANT);
    expect(d.source).toBe("blocked");
    if (d.source === "blocked") expect(d.reason).toMatch(/Cloud|configur/i);
  });
});
