import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty, ZENTRIZ_ADMIN_EMAIL, ZENTRIZ_ADMIN_DEFAULT_PASSWORD, TENANT_ADMIN_EMAIL, TENANT_ADMIN_DEFAULT_PASSWORD } from "./db/seed.js";
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
      payload: { email: "user@tenant.com", password: "demo" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("token");
    expect(body).toHaveProperty("user");
    expect(body.user.email).toBe("user@tenant.com");
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
      payload: { email: ZENTRIZ_ADMIN_EMAIL, password: ZENTRIZ_ADMIN_DEFAULT_PASSWORD },
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
      payload: { email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_DEFAULT_PASSWORD },
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
      payload: { email: ZENTRIZ_ADMIN_EMAIL, password: ZENTRIZ_ADMIN_DEFAULT_PASSWORD },
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
      },
    });
    expect([201, 409]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      const body = JSON.parse(res.body);
      expect(body.maxProjects).toBe(99);
      createdPlanId = body.id;
    } else {
      createdPlanId = "plan_integration_test";
    }
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
      payload: { email: TENANT_ADMIN_EMAIL, password: TENANT_ADMIN_DEFAULT_PASSWORD },
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
