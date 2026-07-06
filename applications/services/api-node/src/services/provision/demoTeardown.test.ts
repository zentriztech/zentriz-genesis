/**
 * DM-T10: teardown/TTL da demo — reaper de expiradas + rds.teardown pula demo.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── pool mock p/ reapExpiredDemos ─────────────────────────────────────────────
let lastSql = "";
let rowCount = 0;
const queryMock = vi.fn(async (sql: string) => { lastSql = sql; return { rows: [], rowCount }; });
vi.mock("../../db/client.js", () => ({ pool: { query: (sql: string) => queryMock(sql) } }));

import { reapExpiredDemos } from "./backendState.js";

beforeEach(() => { lastSql = ""; rowCount = 0; queryMock.mockClear(); });

describe("reapExpiredDemos", () => {
  it("marca demos expiradas ativas como destroying; durable intocado", async () => {
    rowCount = 3;
    const n = await reapExpiredDemos();
    expect(n).toBe(3);
    expect(lastSql).toContain("class = 'demo'");
    expect(lastSql).toContain("expires_at < now()");
    expect(lastSql).toContain("status = 'destroying'");
    expect(lastSql).toContain("IN ('running','running_degraded')");
  });

  it("nada expirado → 0", async () => {
    rowCount = 0;
    expect(await reapExpiredDemos()).toBe(0);
  });
});

// ── rds.teardown pula demo ────────────────────────────────────────────────────
describe("rds.teardown — demo pula RDS", () => {
  it("demo não chama nenhum comando RDS (DB é sidecar, some com a task)", async () => {
    vi.resetModules();
    const rdsSend = vi.fn(async () => ({}));
    vi.doMock("@aws-sdk/client-rds", async (o) => {
      const actual = await o<typeof import("@aws-sdk/client-rds")>();
      return { ...actual, RDSClient: class { send = (c: unknown) => rdsSend(); } };
    });
    vi.doMock("@aws-sdk/client-secrets-manager", async (o) => {
      const actual = await o<typeof import("@aws-sdk/client-secrets-manager")>();
      return { ...actual, SecretsManagerClient: class { send = async () => ({}); } };
    });
    vi.doMock("./backendState.js", () => ({
      recordResourceIntent: () => Promise.resolve("l"), markResourceCreated: () => Promise.resolve(),
      findCreatedResource: () => Promise.resolve(null), patchDeployment: () => Promise.resolve(),
    }));
    vi.doMock("./provisionChain.js", () => ({ registerDriver: () => {} }));
    const { rdsDriver } = await import("./rds.js");
    const ctx = {
      deploymentId: "dep-1", projectId: "p", tenantId: "t", runtimeTarget: "ecs_fargate",
      klass: "demo", ecrRepoUri: "r", imageTag: "t",
      creds: { region: "us-east-1", credentials: undefined }, scratch: {},
    } as unknown as import("./provisionChain.js").ProvisionContext;
    await rdsDriver.teardown!(ctx);
    expect(rdsSend).not.toHaveBeenCalled();
  });
});
