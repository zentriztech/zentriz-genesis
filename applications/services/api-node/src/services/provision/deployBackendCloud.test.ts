/**
 * DM-T11a: deployBackendCloud mapeia delivery_mode → klass (demo≠produção) + barra source_only.
 * validateDeployMatrix é REAL (fonte de verdade); o resto é mockado (sem AWS/DB/GitHub).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Repo GitHub presente + installation → passa a elegibilidade.
vi.mock("../../db/client.js", () => ({
  pool: { query: async () => ({ rows: [{ clone_url: "https://github.com/x/y", default_branch: "main",
    repo_full_name: "x/y", installation_id: 42 }] }) },
}));
vi.mock("../github.js", () => ({ getInstallationTokenForClone: async () => "tok" }));
vi.mock("../../auth.js", () => ({ signDeployCallbackToken: () => "cbtok" }));
vi.mock("./awsCredentials.js", () => ({ resolveAwsCredentials: async () => ({ region: "us-east-1", credentials: undefined }) }));

const createCalls: Array<{ klass?: string }> = [];
vi.mock("./backendState.js", () => ({
  createOrGetActiveDeployment: async (input: { klass?: string }) => {
    createCalls.push(input);
    return { row: { id: "dep-1", project_id: "p", tenant_id: "t", provider: "aws",
      runtime_target: "ecs_fargate", class: input.klass, status: "provisioning" }, reused: false };
  },
  setStatus: async () => {}, patchDeployment: async () => {},
}));

// FTS fetch mockado (não dispara nada real).
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })) as unknown as typeof fetch);

import { deployBackendCloud } from "./deployBackendCloud.js";

beforeEach(() => { createCalls.length = 0; });

describe("deployBackendCloud — delivery_mode → klass", () => {
  it("production → klass 'durable' (RDS gerenciado)", async () => {
    const r = await deployBackendCloud({ projectId: "p", tenantId: "t", projectType: "backend_api", extraTarget: null, extraMode: "production" });
    expect(r.ok).toBe(true);
    expect(createCalls[0].klass).toBe("durable");
  });

  it("demo → klass 'demo' (DB sidecar efêmero)", async () => {
    const r = await deployBackendCloud({ projectId: "p", tenantId: "t", projectType: "backend_api", extraTarget: null, extraMode: "demo" });
    expect(r.ok).toBe(true);
    expect(createCalls[0].klass).toBe("demo");
  });

  it("source_only → rejeitado (não provisiona infra)", async () => {
    const r = await deployBackendCloud({ projectId: "p", tenantId: "t", projectType: "backend_api", extraTarget: null, extraMode: "source_only" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SOURCE_ONLY_NO_PROVISION");
    expect(createCalls.length).toBe(0); // não cria row
  });

  it("sem extraMode + backend → default source_only → rejeitado (não vaza p/ produção)", async () => {
    // default backend = source_only (DM-T1); então backend sem escolha NÃO provisiona sozinho.
    const r = await deployBackendCloud({ projectId: "p", tenantId: "t", projectType: "backend_api", extraTarget: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SOURCE_ONLY_NO_PROVISION");
  });

  it("fullstack + production → durable", async () => {
    const r = await deployBackendCloud({ projectId: "p", tenantId: "t", projectType: "fullstack_saas", extraTarget: "ecs_fargate", extraMode: "production" });
    expect(r.ok).toBe(true);
    expect(createCalls[0].klass).toBe("durable");
  });
});
