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

// Listas globais do registry do Deadpool + posse local do tenant — controláveis por teste,
// para exercer o isolamento multi-tenant das leituras de lista (/projects, /incidents).
let mockProjects: unknown[] = [];
let mockIncidents: unknown[] = [];
let mockMonitoringRows: { system_id: string | null; service_id: string | null }[] = [];
let mockInstallationRows: { installation_id: string | number }[] = [];

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
    if (path === "/projects") return { projects: mockProjects };
    if (path.startsWith("/incidents")) return { incidents: mockIncidents };
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
vi.mock("../db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("project_deadpool_monitoring")) return { rows: mockMonitoringRows };
      if (typeof sql === "string" && sql.includes("tenant_github_installations")) return { rows: mockInstallationRows };
      return { rows: [] };
    }),
  },
}));

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
    mockProjects = [];
    mockIncidents = [];
    mockMonitoringRows = [];
    mockInstallationRows = [];
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

  // ── Isolamento multi-tenant das leituras de lista (regressão do vazamento cross-tenant) ──
  // O registry do Deadpool é GLOBAL; um tenant_admin não pode ver itens de outros tenants.
  describe("isolamento multi-tenant (projects/incidents)", () => {
    const OWN = { system_id: "acme-app", service_id: "acme-api" };
    const OTHER = { system_id: "globex-app", service_id: "globex-api" };

    beforeEach(() => {
      // O registry global expõe projetos/incidentes de DOIS tenants.
      mockProjects = [
        { system_id: OWN.system_id, service_id: OWN.service_id, installation_id: 100, repo_url: "https://x/own" },
        { system_id: OTHER.system_id, service_id: OTHER.service_id, installation_id: 200, repo_url: "https://x/other" },
      ];
      mockIncidents = [
        { incident_id: "inc-own", service_name: OWN.service_id, severity: "high" },
        { incident_id: "inc-other", service_name: OTHER.service_id, severity: "high" },
      ];
      // Posse local do tenant chamador: só o projeto "acme" (par de slug + installation 100).
      mockMonitoringRows = [{ system_id: OWN.system_id, service_id: OWN.service_id }];
      mockInstallationRows = [{ installation_id: 100 }];
    });

    it("tenant_admin só vê os projetos do próprio tenant (fail-closed)", async () => {
      currentRole = "tenant_admin";
      const res = await app.inject({ method: "GET", url: "/api/deadpool/projects" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].system_id).toBe(OWN.system_id);
    });

    it("tenant_admin só vê os incidentes de serviços do próprio tenant", async () => {
      currentRole = "tenant_admin";
      const res = await app.inject({ method: "GET", url: "/api/deadpool/incidents" });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).incidents.map((i: { incident_id: string }) => i.incident_id);
      expect(ids).toEqual(["inc-own"]);
    });

    it("tenant_admin NÃO abre o detalhe de um incidente de outro tenant (404)", async () => {
      currentRole = "tenant_admin";
      const res = await app.inject({ method: "GET", url: "/api/deadpool/incidents/inc-other" });
      expect(res.statusCode).toBe(404);
    });

    it("tenant_admin abre o detalhe de um incidente do próprio tenant (200)", async () => {
      currentRole = "tenant_admin";
      const res = await app.inject({ method: "GET", url: "/api/deadpool/incidents/inc-own" });
      expect(res.statusCode).toBe(200);
    });

    it("mesmo slug em outro tenant mas installation DIFERENTE não vaza (chave = installation_id)", async () => {
      currentRole = "tenant_admin";
      // O outro tenant tem o MESMO par de slug do chamador, porém installation diferente.
      mockProjects = [{ system_id: OWN.system_id, service_id: OWN.service_id, installation_id: 999 }];
      const res = await app.inject({ method: "GET", url: "/api/deadpool/projects" });
      expect(JSON.parse(res.body).projects).toHaveLength(0);
    });

    it("mostra projeto PRÓPRIO registrado no aceite (installation casa) mesmo SEM linha de monitoramento", async () => {
      // Completude: o registry global inclui registros de aceite (#60) que ainda não têm linha em
      // project_deadpool_monitoring. Filtrar por par de slug esconderia projetos legítimos do tenant;
      // a chave é a installation_id (presente em TODO registro). Sem monitoring rows, o projeto do
      // tenant (installation 100) DEVE aparecer.
      currentRole = "tenant_admin";
      mockMonitoringRows = [];
      mockProjects = [
        { system_id: "novo-app", service_id: null, installation_id: 100, repo_url: "https://x/novo" },
        { system_id: OTHER.system_id, service_id: OTHER.service_id, installation_id: 200 },
      ];
      const res = await app.inject({ method: "GET", url: "/api/deadpool/projects" });
      const projects = JSON.parse(res.body).projects;
      expect(projects).toHaveLength(1);
      expect(projects[0].system_id).toBe("novo-app");
    });

    it("zentriz_admin vê a visão GLOBAL (todos os tenants) — sem filtro", async () => {
      currentRole = "zentriz_admin";
      const res = await app.inject({ method: "GET", url: "/api/deadpool/projects" });
      expect(JSON.parse(res.body).projects).toHaveLength(2);
      const inc = await app.inject({ method: "GET", url: "/api/deadpool/incidents" });
      expect(JSON.parse(inc.body).incidents).toHaveLength(2);
    });
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
