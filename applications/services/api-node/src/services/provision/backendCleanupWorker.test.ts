/**
 * G1-T22: backendCleanupWorker — watchdog SÓ fases mecânicas, sweep de teardown, não toca S3.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
vi.mock("../../db/client.js", () => ({ pool: { query: (sql: string, p?: unknown[]) => queryImpl(sql, p) } }));

const teardownDeployment = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, remaining: [], errors: [] }));
vi.mock("./teardown.js", () => ({ teardownDeployment: (...a: unknown[]) => teardownDeployment(...a) }));

let forTeardown: Array<{ id: string }> = [];
vi.mock("./backendState.js", () => ({
  listDeploymentsForTeardown: () => Promise.resolve(forTeardown),
}));

import { runBackendWatchdogOnce, runBackendCleanupOnce } from "./backendCleanupWorker.js";

beforeEach(() => { teardownDeployment.mockClear(); forTeardown = []; });

describe("runBackendWatchdogOnce", () => {
  it("query só marca fases MECÂNICAS e exclui migrating/waiting_cert_dns", async () => {
    let captured = "";
    let capturedParams: unknown[] | undefined;
    queryImpl = async (sql, params) => { captured = sql; capturedParams = params; return { rows: [], rowCount: 0 }; };
    await runBackendWatchdogOnce();
    // A tabela é backend_deployments (NÃO ephemeral_deployments — não toca S3)
    expect(captured).toContain("backend_deployments");
    expect(captured).not.toContain("ephemeral_deployments");
    // Fases mecânicas no parâmetro; migrating/waiting_cert_dns AUSENTES
    const phases = (capturedParams?.[0] ?? []) as string[];
    expect(phases).toEqual(["building", "pushing", "creating_service"]);
    expect(phases).not.toContain("migrating");
    expect(phases).not.toContain("waiting_cert_dns");
  });

  it("reporta quantos marcou failed", async () => {
    queryImpl = async () => ({ rows: [{ id: "d1" }, { id: "d2" }], rowCount: 2 });
    const r = await runBackendWatchdogOnce();
    expect(r.marked_failed).toBe(2);
  });
});

describe("runBackendCleanupOnce", () => {
  it("chama teardown para cada deploy com recursos vivos", async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });
    forTeardown = [{ id: "d1" }, { id: "d2" }];
    const r = await runBackendCleanupOnce();
    expect(teardownDeployment).toHaveBeenCalledTimes(2);
    expect(r.swept).toBe(2);
  });

  it("teardown que falha conta como erro, não trava o sweep", async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });
    forTeardown = [{ id: "d1" }, { id: "d2" }];
    teardownDeployment.mockResolvedValueOnce({ ok: false, remaining: ["arn:x"], errors: ["boom"] } as never);
    const r = await runBackendCleanupOnce();
    expect(r.errors).toBe(1);
    expect(r.swept).toBe(1);
  });

  it("nada para limpar → no-op", async () => {
    forTeardown = [];
    const r = await runBackendCleanupOnce();
    expect(teardownDeployment).not.toHaveBeenCalled();
    expect(r.swept).toBe(0);
  });
});
