/**
 * G1-T12: handleBackendCallback — mapeamento de fases + disparo idempotente da cadeia.
 * Mocka db/client e provisionChain (não toca Postgres nem AWS).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let depRow: Record<string, unknown> | null = { id: "dep-1", project_id: "proj-1", status: "pushing" };
const queryMock = vi.fn(async (sql: string) => {
  if (/FROM backend_deployments WHERE id=\$1 AND project_id/.test(sql)) {
    return { rows: depRow ? [depRow] : [] };
  }
  if (/FROM backend_deployments WHERE id=\$1/.test(sql)) {
    return { rows: depRow ? [{ ...depRow, tenant_id: "t-1", provider: "aws", runtime_target: "ecs_fargate",
      class: "durable", ecr_repo_uri: "acct/repo", image_tag: "abc", app_url: null, health_url: null,
      error_msg: null }] : [] };
  }
  return { rows: [] };
});
vi.mock("../../db/client.js", () => ({ pool: { query: (...a: unknown[]) => queryMock(...(a as [string])) } }));

const setStatus = vi.fn((..._a: unknown[]) => Promise.resolve());
const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("./backendState.js", () => ({
  setStatus: (...a: unknown[]) => setStatus(...a),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));

const runProvisionChain = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("./provisionChain.js", () => ({
  runProvisionChain: (...a: unknown[]) => runProvisionChain(...a),
  registerDriver: () => {}, // drivers.js (side-effect import) chama isto
}));
// Neutraliza o barrel de drivers (side-effect) no teste de callback.
vi.mock("./drivers.js", () => ({}));

import { handleBackendCallback } from "./backendCallback.js";

beforeEach(() => {
  setStatus.mockClear(); patchDeployment.mockClear(); runProvisionChain.mockClear();
  depRow = { id: "dep-1", project_id: "proj-1", status: "pushing" };
});

describe("handleBackendCallback", () => {
  it("deployment inexistente → 404", async () => {
    depRow = null;
    const r = await handleBackendCallback("proj-1", "dep-1", { progress: "building" });
    expect(r.http).toBe(404);
  });

  it("progress 'building' → avança status building, não dispara cadeia", async () => {
    const r = await handleBackendCallback("proj-1", "dep-1", { progress: "building" });
    expect(r.http).toBe(200);
    expect(setStatus).toHaveBeenCalledWith("dep-1", "building");
    expect(runProvisionChain).not.toHaveBeenCalled();
  });

  it("progress 'pushed' → grava artefato e dispara a cadeia SDK", async () => {
    const r = await handleBackendCallback("proj-1", "dep-1", {
      progress: "pushed", ecr_repo_uri: "acct/repo", image_tag: "abc123",
    });
    expect(r.http).toBe(200);
    expect(patchDeployment).toHaveBeenCalledWith("dep-1", expect.objectContaining({ ecr_repo_uri: "acct/repo" }));
    await new Promise((res) => setImmediate(res)); // deixa o setImmediate rodar
    expect(runProvisionChain).toHaveBeenCalledTimes(1);
  });

  it("pushed idempotente: se já em 'running', NÃO redispara a cadeia", async () => {
    depRow = { id: "dep-1", project_id: "proj-1", status: "running" };
    await handleBackendCallback("proj-1", "dep-1", { progress: "pushed", ecr_repo_uri: "acct/repo" });
    await new Promise((res) => setImmediate(res));
    expect(runProvisionChain).not.toHaveBeenCalled();
  });

  it("status 'failed' → marca failed com código+msg", async () => {
    const r = await handleBackendCallback("proj-1", "dep-1", {
      status: "failed", error_code: "BUILD_FAILED", error_msg: "docker build exit 1",
    });
    expect(r.http).toBe(200);
    expect(setStatus.mock.calls[0][1]).toBe("failed");
    expect(String(setStatus.mock.calls[0][2])).toContain("BUILD_FAILED");
  });

  it("body vazio → 400", async () => {
    const r = await handleBackendCallback("proj-1", "dep-1", {});
    expect(r.http).toBe(400);
  });
});
