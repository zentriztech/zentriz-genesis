/**
 * deadpool.test.ts — RBAC do gateway /api/deadpool/* (regressão + contrato).
 *
 * Regressão coberta: as LEITURAS do painel (status/projects/incidents/knowledge) devem aceitar
 * tenant_admin (mesmo nível do painel #61 original). Um bug endureceu isso p/ zentriz_admin-only,
 * o que fazia o portal de um tenant_admin mostrar "Deadpool indisponível". Já a decisão COMERCIAL
 * de conceder/revogar licença (PUT entitlement) continua restrita a zentriz_admin.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

// Papel do usuário corrente, controlável por teste. authMiddleware injeta request.user com ele.
let currentRole: "user" | "tenant_admin" | "zentriz_admin" = "tenant_admin";
const TENANT = "11111111-1111-4111-8111-111111111111";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = { id: "u1", role: currentRole, tenantId: TENANT };
  },
}));

// Deadpool "vivo": /health + /ready respondem objetos ricos.
const OFF_FLAGS = {
  allow_cloudwatch_poll: { value: false, source: "env", env_default: false },
  allow_azure_poll: { value: false, source: "env", env_default: false },
  allow_gcp_poll: { value: false, source: "env", env_default: false },
};
vi.mock("../services/deadpoolClient.js", () => ({
  isDeadpoolConfigured: () => true,
  deadpoolGet: vi.fn(async (path: string) => {
    if (path === "/health") return { status: "ok", version: "1.1.0-beta" };
    if (path === "/ready") return { status: "ready" };
    if (path === "/projects") return { projects: [] };
    if (path.startsWith("/incidents")) return { incidents: [] };
    if (path === "/knowledge") return { entries: [] };
    if (path === "/monitoring/flags") return { status: "ok", monitor_enabled: false, flags: OFF_FLAGS };
    return {};
  }),
  // Echoa o override recebido como se o Deadpool tivesse persistido — o gateway só valida e repassa.
  deadpoolPost: vi.fn(async (path: string, body: unknown) => {
    if (path === "/monitoring/flags") {
      const updates = (body as { flags?: Record<string, unknown> })?.flags ?? {};
      const flags = { ...OFF_FLAGS } as Record<string, unknown>;
      for (const [k, v] of Object.entries(updates)) {
        flags[k] = v === null ? { value: false, source: "env", env_default: false } : { value: v, source: "override", env_default: false };
      }
      return { status: "ok", monitor_enabled: false, flags };
    }
    return {};
  }),
}));

// Entitlements e githubPush não são exercidos nestes testes de RBAC; stub para evitar I/O.
vi.mock("../services/entitlements.js", () => ({
  hasEntitlement: vi.fn(async () => false),
  setEntitlement: vi.fn(async () => undefined),
}));
vi.mock("../services/githubPush.js", () => ({
  registerProjectWithDeadpool: vi.fn(async () => ({})),
  deriveSystemService: vi.fn(() => ({ systemId: "s", serviceId: "svc" })),
}));
vi.mock("../db/client.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { deadpoolRoutes } from "./deadpool.js";

async function buildApp() {
  const app = Fastify();
  await app.register(deadpoolRoutes);
  return app;
}

describe("deadpool gateway RBAC", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    currentRole = "tenant_admin";
    app = await buildApp();
  });

  it("REGRESSÃO: tenant_admin lê /status (200, health normalizado como string)", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({ method: "GET", url: "/api/deadpool/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.health).toBe("ok · v1.1.0-beta"); // string, não [object Object]
    expect(body.ready).toBe(true);
  });

  it("tenant_admin lê as demais views do painel (projects/incidents/knowledge)", async () => {
    currentRole = "tenant_admin";
    for (const url of ["/api/deadpool/projects", "/api/deadpool/incidents", "/api/deadpool/knowledge"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(JSON.parse(res.body).available).toBe(true);
    }
  });

  it("role 'user' (não-admin) é barrado nas leituras do painel (403)", async () => {
    currentRole = "user";
    const res = await app.inject({ method: "GET", url: "/api/deadpool/status" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("FORBIDDEN");
  });

  it("conceder licença (PUT entitlement) exige zentriz_admin — tenant_admin é 403", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "PUT",
      url: `/api/deadpool/entitlement/${TENANT}`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("conceder licença como zentriz_admin passa a validação de RBAC (200)", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({
      method: "PUT",
      url: `/api/deadpool/entitlement/${TENANT}`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  // ── activate: validação multi-cloud (parseMonitoringConfig, 400 antes de qualquer I/O) ──
  const PID = "22222222-2222-4222-8222-222222222222";

  it("activate rejeita nuvem desconhecida (400 UNKNOWN_MONITOR_PROVIDER)", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "POST",
      url: `/api/deadpool/projects/${PID}/activate`,
      payload: { monitorProvider: "oraculo" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("UNKNOWN_MONITOR_PROVIDER");
  });

  it("activate Azure sem tabela é rejeitado (400 AZURE_TABLE_REQUIRED)", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "POST",
      url: `/api/deadpool/projects/${PID}/activate`,
      payload: { monitorProvider: "azure", azureWorkspaceId: "ws-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("AZURE_TABLE_REQUIRED");
  });

  it("activate GCP sem filtro de logs é rejeitado (400 GCP_LOG_FILTER_REQUIRED)", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "POST",
      url: `/api/deadpool/projects/${PID}/activate`,
      payload: { monitorProvider: "gcp", gcpProjectId: "proj-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("GCP_LOG_FILTER_REQUIRED");
  });

  it("activate CloudWatch (default) não é barrado pela validação de config", async () => {
    // Sem monitorProvider → cloudwatch; a config valida e o fluxo segue para o DB (não é 400).
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "POST",
      url: `/api/deadpool/projects/${PID}/activate`,
      payload: {},
    });
    expect(res.statusCode).not.toBe(400);
  });

  // ── monitoring/flags: toggle das flags de poll por nuvem (zentriz_admin-only) ──
  it("GET flags exige zentriz_admin — tenant_admin é 403", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({ method: "GET", url: "/api/deadpool/monitoring/flags" });
    expect(res.statusCode).toBe(403);
  });

  it("zentriz_admin lê o estado efetivo das flags (todas OFF por env)", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({ method: "GET", url: "/api/deadpool/monitoring/flags" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.monitorEnabled).toBe(false);
    expect(body.flags.allow_cloudwatch_poll).toEqual({ value: false, source: "env", env_default: false });
  });

  it("POST flags exige zentriz_admin — tenant_admin é 403", async () => {
    currentRole = "tenant_admin";
    const res = await app.inject({
      method: "POST",
      url: "/api/deadpool/monitoring/flags",
      payload: { flags: { allow_gcp_poll: true } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("zentriz_admin liga uma nuvem → 200, flag vira override=true", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({
      method: "POST",
      url: "/api/deadpool/monitoring/flags",
      payload: { flags: { allow_gcp_poll: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.available).toBe(true);
    expect(body.flags.allow_gcp_poll).toEqual({ value: true, source: "override", env_default: false });
  });

  it("POST rejeita flag não gerenciável no gateway (400 UNMANAGED_FLAG, sem I/O)", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({
      method: "POST",
      url: "/api/deadpool/monitoring/flags",
      payload: { flags: { monitor_enabled: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("UNMANAGED_FLAG");
  });

  it("POST rejeita valor não-bool/null (400 BAD_VALUE)", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({
      method: "POST",
      url: "/api/deadpool/monitoring/flags",
      payload: { flags: { allow_azure_poll: "on" } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("BAD_VALUE");
  });

  it("POST rejeita corpo sem objeto 'flags' (400 BAD_REQUEST)", async () => {
    currentRole = "zentriz_admin";
    const res = await app.inject({
      method: "POST",
      url: "/api/deadpool/monitoring/flags",
      payload: { nope: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("BAD_REQUEST");
  });
});
