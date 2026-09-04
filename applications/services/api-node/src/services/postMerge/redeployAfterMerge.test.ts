/**
 * redeployAfterMerge.test.ts — Bloco 4 (M6): redeploy pós-merge com a MESMA identidade da linhagem.
 * Cobre: sem deploy anterior → skipped_no_prev (NUNCA cria o 1º deploy); conexão revogada →
 * blocked_connection; demo com prazo → herda expires_at/consented_teardown e chama startCloudDeploy com
 * branch:"dev", gitSha=merge, triggerKind:"evolution_merge", supersedesId=prev.id; idempotência.
 * DB mockado por regex de SQL; lineage/cloudConnector/startCloudDeploy mockados.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let prevRow: Record<string, unknown> | undefined;
let connActive: boolean;
const startDeploy = vi.fn(async (_p: Record<string, unknown>) => ({ ok: true as const, deploymentId: "dep-new", provider: "aws" as const, format: "container" as const, branch: "dev" }));

vi.mock("../lineage.js", () => ({
  resolveLineageRoot: async () => ({ id: "root-1", title: "P", product_id: null, depth: 1 }),
}));
vi.mock("../cloudConnector.js", () => ({
  getCloudConnection: async () => (connActive ? { provider: "aws" } : null),
}));
vi.mock("../provision/cloudDeploy.js", () => ({
  startCloudDeploy: (p: Record<string, unknown>) => startDeploy(p),
}));

const { redeployAfterMerge } = await import("./redeployAfterMerge.js");

const CHILD = "child-1";

function makeDb(childExtra: Record<string, unknown>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SELECT tenant_id, parent_project_id, extra FROM projects/.test(sql)) {
        return { rows: [{ tenant_id: "t1", parent_project_id: "parent-1", extra: childExtra }] };
      }
      if (/FROM cloud_deployments\s+WHERE status = 'deployed'/.test(sql)) {
        return { rows: prevRow ? [prevRow] : [] };
      }
      return { rows: [] };
    }),
  };
  return { db, calls };
}

function persisted(calls: Array<{ sql: string; params: unknown[] }>): Record<string, unknown> | null {
  const upd = calls.find((c) => /UPDATE projects SET extra = COALESCE/.test(c.sql));
  return upd ? JSON.parse(upd.params[1] as string) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  prevRow = undefined;
  connActive = true;
  startDeploy.mockResolvedValue({ ok: true, deploymentId: "dep-new", provider: "aws", format: "container", branch: "dev" });
});

describe("redeployAfterMerge", () => {
  it("sem deploy anterior na linhagem → skipped_no_prev (não cria o 1º deploy)", async () => {
    const { db, calls } = makeDb({});
    await redeployAfterMerge(db as never, CHILD, "MERGESHA");
    expect(startDeploy).not.toHaveBeenCalled();
    expect(persisted(calls)?.evolution_redeploy_state).toBe("skipped_no_prev");
  });

  it("conexão revogada/inativa → blocked_connection", async () => {
    prevRow = { id: "dep-prev", connection_id: "conn-1", deploy_format: "container", expires_at: null, consented_teardown: false };
    connActive = false;
    const { db, calls } = makeDb({});
    await redeployAfterMerge(db as never, CHILD, "MERGESHA");
    expect(startDeploy).not.toHaveBeenCalled();
    expect(persisted(calls)?.evolution_redeploy_state).toBe("blocked_connection");
  });

  it("demo com prazo → herda expires_at/consented_teardown e redeploya 'dev' no SHA do merge, supersedes o anterior", async () => {
    const exp = "2026-12-31T00:00:00.000Z";
    prevRow = { id: "dep-prev", connection_id: "conn-1", deploy_format: "static", expires_at: exp, consented_teardown: true };
    const { db, calls } = makeDb({});
    await redeployAfterMerge(db as never, CHILD, "MERGESHA");
    expect(startDeploy).toHaveBeenCalledTimes(1);
    const arg = startDeploy.mock.calls[0][0];
    expect(arg.branch).toBe("dev");
    expect(arg.gitSha).toBe("MERGESHA");
    expect(arg.triggerKind).toBe("evolution_merge");
    expect(arg.supersedesId).toBe("dep-prev");
    expect(arg.format).toBe("static");
    expect((arg.expiresAt as Date).toISOString()).toBe(exp);
    expect(arg.consentedTeardown).toBe(true);
    const state = persisted(calls);
    expect(state?.evolution_redeploy_state).toBe("dispatched");
    expect(state?.evolution_redeploy_id).toBe("dep-new");
  });

  it("deploy permanente (sem prazo) → não herda demo (expiresAt null, consentedTeardown false)", async () => {
    prevRow = { id: "dep-prev", connection_id: "conn-1", deploy_format: "container", expires_at: null, consented_teardown: false };
    const { db } = makeDb({});
    await redeployAfterMerge(db as never, CHILD, "MERGESHA");
    const arg = startDeploy.mock.calls[0][0];
    expect(arg.expiresAt).toBeNull();
    expect(arg.consentedTeardown).toBe(false);
  });

  it("idempotente: já rodou (evolution_redeploy_at presente) → no-op", async () => {
    prevRow = { id: "dep-prev", connection_id: "conn-1", deploy_format: "container", expires_at: null, consented_teardown: false };
    const { db, calls } = makeDb({ evolution_redeploy_at: "2026-09-04T00:00:00Z" });
    await redeployAfterMerge(db as never, CHILD, "MERGESHA");
    expect(startDeploy).not.toHaveBeenCalled();
    // só a leitura do filho; nada persistido
    expect(calls.filter((c) => /UPDATE projects/.test(c.sql)).length).toBe(0);
  });
});
