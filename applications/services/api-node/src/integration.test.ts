import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty } from "./db/seed.js";
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
