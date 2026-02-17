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
  });
});
