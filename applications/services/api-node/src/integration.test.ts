import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty, ZENTRIZ_EMAIL, ZENTRIZ_DEFAULT_PASSWORD } from "./db/seed.js";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";

let dbAvailable = false;

describe("API integration (auth, projects, specs)", () => {
  let app: FastifyInstance | undefined;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("POST /api/auth/login returns token, user and optional tenant", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "user" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("user");
    expect(body.user.email).toBe(ZENTRIZ_EMAIL);
    expect(body.user.role).toBe("user");
    token = body.token;
  });

  it("GET /api/projects without token returns 401", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/projects with token returns list", async () => {
    if (!dbAvailable || !app || !token) return;
    const res = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /api/specs accepts multipart (.md) and returns projectId", async () => {
    if (!dbAvailable || !app || !token) return;
    const form = new FormData();
    form.append("title", "Integration Test Spec");
    form.append("files", Buffer.from("# Spec de teste\n\nConteúdo em Markdown."), {
      filename: "spec.md",
      contentType: "text/markdown",
    });
    const payload = form.getBuffer();
    const res = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("projectId");
    expect(body.status).toBeDefined();
    expect(body.message).toBeDefined();
    projectId = body.projectId;
    const getRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const project = JSON.parse(getRes.body);
    expect(project.title).toBe("Integration Test Spec");
  });

  it("GET /api/projects/:id/dialogue returns array", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/dialogue`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /api/projects/:id/dialogue creates entry", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/dialogue`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: { from_agent: "cto", to_agent: "engineer", summary_human: "E2E test step", event_type: "step", request_id: "e2e-1" },
    });
    expect(res.statusCode).toBe(201);
    const getRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/dialogue`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const list = JSON.parse(getRes.body);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((e: { fromAgent: string }) => e.fromAgent === "cto")).toBe(true);
  });

  it("GET /api/projects/:id/tasks returns array", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tasks`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /api/projects/:id/tasks seeds tasks", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/tasks`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: { tasks: [{ task_id: "TSK-E2E-001", module: "backend", owner_role: "DEV_BACKEND", status: "ASSIGNED" }] },
    });
    expect(res.statusCode).toBe(201);
    const getRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tasks`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const list = JSON.parse(getRes.body);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const task = list.find((t: { taskId: string }) => t.taskId === "TSK-E2E-001");
    expect(task).toBeDefined();
  });

  it("PATCH /api/projects/:id/tasks/:taskId updates status", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tasks/TSK-E2E-001`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: { status: "IN_PROGRESS" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/projects/:id/artifacts returns docs and roots", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/artifacts`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("docs");
    expect(Array.isArray(body.docs)).toBe(true);
  });

  it("PATCH /api/projects/:id updates status", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /api/projects/:id/accept when completed returns accepted", async () => {
    if (!dbAvailable || !app || !token || !projectId) return;
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/accept`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: {},
    });
    expect([200, 409]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.status).toBe("accepted");
    }
  });
});

describe("Users API (CRUD)", () => {
  let app: FastifyInstance | undefined;
  let adminToken: string;
  let createdUserId: string;

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("zentriz_admin can login", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "zentriz_admin" },
    });
    expect(res.statusCode).toBe(200);
    adminToken = JSON.parse(res.body).token;
  });

  it("GET /api/users returns list", async () => {
    if (!dbAvailable || !app || !adminToken) return;
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it("POST /api/users creates new user", async () => {
    if (!dbAvailable || !app || !adminToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: {
        email: "integration-test-user@zentriz.com",
        name: "Integration Test User",
        password: "Test@1234!",
        role: "user",
      },
    });
    expect([201, 409]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      createdUserId = JSON.parse(res.body).id;
    }
  });

  it("GET /api/users/:id returns user", async () => {
    if (!dbAvailable || !app || !adminToken || !createdUserId) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/users/${createdUserId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(createdUserId);
  });

  it("PATCH /api/users/:id updates name", async () => {
    if (!dbAvailable || !app || !adminToken || !createdUserId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${createdUserId}`,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: { name: "Updated Integration User" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe("Updated Integration User");
  });

  it("DELETE /api/users/:id removes user", async () => {
    if (!dbAvailable || !app || !adminToken || !createdUserId) return;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${createdUserId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([204, 409]).toContain(res.statusCode);
  });

  it("GET /api/users without token returns 401", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });
});

describe("Notifications API (CRUD)", () => {
  let app: FastifyInstance | undefined;
  let userToken: string;
  let notifId: string;

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("tenant_admin can login", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "tenant_admin" },
    });
    expect(res.statusCode).toBe(200);
    userToken = JSON.parse(res.body).token;
  });

  it("POST /api/notifications creates notification", async () => {
    if (!dbAvailable || !app || !userToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      payload: { type: "alert", title: "Test notification", body: "Integration test body" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("Test notification");
    notifId = body.id;
  });

  it("GET /api/notifications returns list", async () => {
    if (!dbAvailable || !app || !userToken) return;
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it("PATCH /api/notifications/:id/read marks as read", async () => {
    if (!dbAvailable || !app || !userToken || !notifId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${notifId}/read`,
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).read).toBe(true);
  });

  it("DELETE /api/notifications/:id removes notification", async () => {
    if (!dbAvailable || !app || !userToken || !notifId) return;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/notifications/${notifId}`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("POST /api/notifications with invalid type returns 400", async () => {
    if (!dbAvailable || !app || !userToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      payload: { type: "invalid_type", title: "Bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/notifications without token returns 401", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(res.statusCode).toBe(401);
  });
});

describe("Plans API (CRUD)", () => {
  let app: FastifyInstance | undefined;
  let adminToken: string;
  let createdPlanId: string;

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("zentriz_admin can login for plans tests", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "zentriz_admin" },
    });
    expect(res.statusCode).toBe(200);
    adminToken = JSON.parse(res.body).token;
  });

  it("GET /api/plans is public and returns list", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({ method: "GET", url: "/api/plans" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(3); // seed has prata, ouro, diamante
    expect(body[0]).toHaveProperty("maxProjects");
  });

  it("POST /api/plans creates new plan", async () => {
    if (!dbAvailable || !app || !adminToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/plans",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: {
        id: "plan_integration_test",
        name: "Integration Test Plan",
        slug: "integration-test",
        maxProjects: 99,
        maxUsersPerTenant: 50,
        monthlyPriceCents: 12345,
      },
    });
    expect([201, 409]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      const body = JSON.parse(res.body);
      expect(body.maxProjects).toBe(99);
      expect(body.monthlyPriceCents).toBe(12345); // preço persiste em centavos
      createdPlanId = body.id;
    } else {
      createdPlanId = "plan_integration_test";
    }
  });

  it("PATCH /api/plans/:id updates monthly_price_cents", async () => {
    if (!dbAvailable || !app || !adminToken || !createdPlanId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/plans/${createdPlanId}`,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: { monthlyPriceCents: 55555 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).monthlyPriceCents).toBe(55555);
  });

  it("POST /api/plans rejects negative monthlyPriceCents with 400", async () => {
    if (!dbAvailable || !app || !adminToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/plans",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: { id: "plan_bad_price", name: "Bad", slug: "bad-price", maxProjects: 1, maxUsersPerTenant: 1, monthlyPriceCents: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/plans/:id returns plan (admin)", async () => {
    if (!dbAvailable || !app || !adminToken || !createdPlanId) return;
    const res = await app.inject({
      method: "GET",
      url: `/api/plans/${createdPlanId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(createdPlanId);
  });

  it("PATCH /api/plans/:id updates maxProjects", async () => {
    if (!dbAvailable || !app || !adminToken || !createdPlanId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/plans/${createdPlanId}`,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      payload: { maxProjects: 77 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).maxProjects).toBe(77);
  });

  it("DELETE /api/plans/:id removes unused plan", async () => {
    if (!dbAvailable || !app || !adminToken || !createdPlanId) return;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/plans/${createdPlanId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([204, 409]).toContain(res.statusCode);
  });

  it("POST /api/plans without admin returns 403", async () => {
    if (!dbAvailable || !app) return;
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "tenant_admin" },
    });
    if (loginRes.statusCode !== 200) return;
    const tenantToken = JSON.parse(loginRes.body).token;
    const res = await app.inject({
      method: "POST",
      url: "/api/plans",
      headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" },
      payload: { id: "plan_x", name: "X", slug: "x", maxProjects: 1, maxUsersPerTenant: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Tenants API + status gating (multi-tenant governance)", () => {
  let app: FastifyInstance | undefined;
  let masterToken: string;
  let tenantId: string;
  const NEW_USER_EMAIL = "gated-tenant-user@example.com";
  const NEW_USER_PASSWORD = "Gated@2026!";

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("login sem role escolhe o papel de maior privilégio (zentriz_admin)", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.role).toBe("zentriz_admin");
    masterToken = body.token;
  });

  it("login com role='user' desambigua para o papel exato", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "user" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).user.role).toBe("user");
  });

  it("master cria tenant (POST /api/tenants) ativo por padrão", async () => {
    if (!dbAvailable || !app || !masterToken) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/tenants",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { name: "Gated Test Tenant", planId: "plan_prata" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("active");
    tenantId = body.id;
  });

  it("GET /api/tenants inclui contadores de uso", async () => {
    if (!dbAvailable || !app || !masterToken) return;
    const res = await app.inject({
      method: "GET",
      url: "/api/tenants",
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const t = body.find((x: { id: string }) => x.id === tenantId);
    expect(t).toBeDefined();
    expect(t).toHaveProperty("usersCount");
    expect(t).toHaveProperty("projectsCount");
  });

  it("master cria usuário no tenant e ele consegue logar enquanto ativo", async () => {
    if (!dbAvailable || !app || !masterToken || !tenantId) return;
    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { email: NEW_USER_EMAIL, name: "Gated User", password: NEW_USER_PASSWORD, role: "user", tenant_id: tenantId },
    });
    expect([201, 409]).toContain(create.statusCode);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: NEW_USER_EMAIL, password: NEW_USER_PASSWORD, role: "user" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("PATCH /api/tenants/:id desativa o tenant e bloqueia login dos seus usuários", async () => {
    if (!dbAvailable || !app || !masterToken || !tenantId) return;
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tenants/${tenantId}`,
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { status: "inactive" },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).status).toBe("inactive");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: NEW_USER_EMAIL, password: NEW_USER_PASSWORD, role: "user" },
    });
    expect(login.statusCode).toBe(403);
    expect(JSON.parse(login.body).code).toBe("TENANT_INACTIVE");
  });

  it("master (sem tenant) continua logando mesmo com tenants inativos", async () => {
    if (!dbAvailable || !app) return;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "zentriz_admin" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("reativar o tenant restaura o login dos usuários", async () => {
    if (!dbAvailable || !app || !masterToken || !tenantId) return;
    await app.inject({
      method: "PATCH",
      url: `/api/tenants/${tenantId}`,
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { status: "active" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: NEW_USER_EMAIL, password: NEW_USER_PASSWORD, role: "user" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("PATCH /api/tenants/:id com status inválido retorna 400", async () => {
    if (!dbAvailable || !app || !masterToken || !tenantId) return;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tenants/${tenantId}`,
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { status: "banido" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("tenant_admin não pode criar tenant (403)", async () => {
    if (!dbAvailable || !app) return;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "tenant_admin" },
    });
    if (login.statusCode !== 200) return;
    const token = JSON.parse(login.body).token;
    const res = await app.inject({
      method: "POST",
      url: "/api/tenants",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      payload: { name: "Should Fail", planId: "plan_prata" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// Cobre as três lacunas de segurança/RBAC apontadas na revisão adversarial:
//  (1) não-master não consegue ALARGAR o escopo passando ?tenantId= de outro tenant;
//  (2) mesmo e-mail em papeis distintos é permitido (unicidade é (email, role)) → 201;
//  (3) deletar usuário que POSSUI projeto retorna 409 (não 500 por violação de FK).
describe("RBAC + integridade (regressões da revisão adversarial)", () => {
  let app: FastifyInstance | undefined;
  let masterToken: string;
  let otherTenantId: string;
  const PROBE_EMAIL = "scope-widen-probe@example.com";
  const DUAL_EMAIL = "dual-role-probe@example.com";

  beforeAll(async () => {
    try {
      app = await buildApp({ logger: false });
      await initDb();
      await seedIfEmpty();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it("master loga e cria um segundo tenant + usuário nele", async () => {
    if (!dbAvailable || !app) return;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "zentriz_admin" },
    });
    expect(login.statusCode).toBe(200);
    masterToken = JSON.parse(login.body).token;

    const tenant = await app.inject({
      method: "POST",
      url: "/api/tenants",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { name: "Outro Tenant (RBAC probe)", planId: "plan_prata" },
    });
    expect(tenant.statusCode).toBe(201);
    otherTenantId = JSON.parse(tenant.body).id;

    const create = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { email: PROBE_EMAIL, name: "Probe do Outro Tenant", password: "Probe@2026!", role: "user", tenant_id: otherTenantId },
    });
    expect([201, 409]).toContain(create.statusCode);
  });

  it("tenant_admin NÃO alarga escopo com ?tenantId= de outro tenant (só vê o próprio)", async () => {
    if (!dbAvailable || !app || !otherTenantId) return;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "tenant_admin" },
    });
    expect(login.statusCode).toBe(200);
    const adminToken = JSON.parse(login.body).token;

    const res = await app.inject({
      method: "GET",
      url: `/api/users?tenantId=${otherTenantId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{ email: string; tenantId: string | null }>;
    // O param é ignorado para não-master: nenhum usuário do outro tenant pode vazar.
    expect(list.some((u) => u.tenantId === otherTenantId)).toBe(false);
    expect(list.some((u) => u.email === PROBE_EMAIL)).toBe(false);
  });

  it("mesmo e-mail em papeis distintos é permitido (unicidade (email, role)) → 201 + 201", async () => {
    if (!dbAvailable || !app || !masterToken) return;
    // Limpeza determinística: remove ambos os papeis-probe se sobraram de execução anterior.
    const listRes = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    const existing = (JSON.parse(listRes.body) as Array<{ id: string; email: string }>)
      .filter((u) => u.email === DUAL_EMAIL);
    for (const u of existing) {
      await app.inject({ method: "DELETE", url: `/api/users/${u.id}`, headers: { Authorization: `Bearer ${masterToken}` } });
    }

    const asUser = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { email: DUAL_EMAIL, name: "Dual (user)", password: "Dual@2026!", role: "user", tenant_id: otherTenantId },
    });
    expect(asUser.statusCode).toBe(201);

    const asTenantAdmin = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { email: DUAL_EMAIL, name: "Dual (tenant_admin)", password: "Dual@2026!", role: "tenant_admin", tenant_id: otherTenantId },
    });
    // Mesmo e-mail, papel diferente → NÃO deve colidir por e-mail.
    expect(asTenantAdmin.statusCode).toBe(201);

    // Repetir o MESMO (email, role) agora sim colide → 409.
    const dup = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}`, "Content-Type": "application/json" },
      payload: { email: DUAL_EMAIL, name: "Dual (user dup)", password: "Dual@2026!", role: "user", tenant_id: otherTenantId },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("deletar usuário que POSSUI projeto retorna 409 (FK protegida, não 500)", async () => {
    if (!dbAvailable || !app || !masterToken) return;
    // O usuário 'user' do ZFactory cria um projeto (vira created_by).
    const userLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: ZENTRIZ_EMAIL, password: ZENTRIZ_DEFAULT_PASSWORD, role: "user" },
    });
    expect(userLogin.statusCode).toBe(200);
    const userToken = JSON.parse(userLogin.body).token;

    const form = new FormData();
    form.append("title", "Projeto do usuário (guard de delete)");
    form.append("files", Buffer.from("# Spec\n\nConteúdo."), { filename: "spec.md", contentType: "text/markdown" });
    const spec = await app.inject({
      method: "POST",
      url: "/api/specs",
      headers: { ...form.getHeaders(), Authorization: `Bearer ${userToken}` },
      payload: form.getBuffer(),
    });
    expect(spec.statusCode).toBe(200);

    // Master localiza o id do papel 'user' (mesmo e-mail em vários papeis) e tenta deletar.
    const listRes = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    const target = (JSON.parse(listRes.body) as Array<{ id: string; email: string; role: string }>)
      .find((u) => u.email === ZENTRIZ_EMAIL && u.role === "user");
    expect(target).toBeDefined();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/users/${target!.id}`,
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(del.statusCode).toBe(409);
    expect(JSON.parse(del.body).code).toBe("CONFLICT");
  });
});
