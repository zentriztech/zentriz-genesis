/**
 * projects.delete.test.ts — DELETE /api/projects/:id (mesmo sistema de /products).
 *
 * Dois modos:
 *  • Legado (menu Ações da tela de detalhe): sem `confirmId` → apaga direto.
 *  • Guardado (botão-ícone da lista /projects): com `confirmId` → confirmação por
 *    reescrita do ID; SEM artefatos (repo git / estado terminal de sucesso) apaga de
 *    verdade; COM artefatos apenas ARQUIVA (status='archived'), exigindo acknowledge.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PROJ_ID = "33333333-3333-4333-8333-333333333333";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1",
  role: "zentriz_admin",
  tenantId: null,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        return queryHandler(sql, params);
      },
      release: () => {},
    }),
    query: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      return queryHandler(sql, params);
    },
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  const { projectRoutes } = await import("./projects.js");
  app = Fastify();
  await app.register(projectRoutes);
  await app.ready();
  captured.length = 0;
  queryHandler = () => ({ rows: [] });
  currentUser = { id: "u1", role: "zentriz_admin", tenantId: null };
});

// Roteia as queries do DELETE: SELECT do projeto, EXISTS de repo git, DELETE/UPDATE.
const deleteHandler =
  (opts: { tenant?: string | null; createdBy?: string; status?: string; hasRepo?: boolean }) =>
  (sql: string) => {
    if (sql.includes("SELECT id, tenant_id, created_by, status, title FROM projects"))
      return {
        rows: [{
          id: PROJ_ID,
          tenant_id: opts.tenant ?? TENANT,
          created_by: opts.createdBy ?? "u1",
          status: opts.status ?? "stopped",
          title: "T",
        }],
      };
    if (sql.includes("FROM project_github_repos"))
      return { rows: opts.hasRepo ? [{ one: 1 }] : [], rowCount: opts.hasRepo ? 1 : 0 };
    return { rows: [] }; // DELETE / UPDATE
  };
const touchedWrite = () =>
  captured.some((q) => /DELETE FROM projects WHERE id|SET status = 'archived'/.test(q.sql));

describe("DELETE /api/projects/:id — hard delete (sem artefatos) vs soft archive (com artefatos)", () => {
  it("id não-UUID → 400 sem tocar o banco", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/projects/abc", payload: { confirmId: "abc" } });
    expect(res.statusCode).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("modo guardado: confirmId errado → 400 CONFIRM_MISMATCH sem apagar nem arquivar", async () => {
    queryHandler = deleteHandler({ status: "stopped" });
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("CONFIRM_MISMATCH");
    expect(touchedWrite()).toBe(false);
  });

  it("sem artefatos + confirmId correto → HARD DELETE real (mode deleted)", async () => {
    queryHandler = deleteHandler({ status: "stopped", hasRepo: false });
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe("deleted");
    expect(captured.some((q) => q.sql.includes("DELETE FROM projects WHERE id"))).toBe(true);
  });

  it("com repo git SEM acknowledge → 400 ACK_REQUIRED (não arquiva nem apaga)", async () => {
    queryHandler = deleteHandler({ status: "failed", hasRepo: true });
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("ACK_REQUIRED");
    expect(touchedWrite()).toBe(false);
  });

  it("com repo git + acknowledge → SOFT archive (nunca apaga)", async () => {
    queryHandler = deleteHandler({ status: "failed", hasRepo: true });
    const res = await app.inject({
      method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID, acknowledge: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe("archived");
    expect(captured.some((q) => q.sql.includes("SET status = 'archived'"))).toBe(true);
    expect(captured.some((q) => q.sql.includes("DELETE FROM projects WHERE id"))).toBe(false);
  });

  it("estado terminal de sucesso (completed) conta como artefato → exige acknowledge", async () => {
    queryHandler = deleteHandler({ status: "completed", hasRepo: false });
    const semAck = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID } });
    expect(semAck.statusCode).toBe(400);
    expect(JSON.parse(semAck.body).code).toBe("ACK_REQUIRED");
  });

  it("projeto em execução → 409 sem apagar/arquivar", async () => {
    queryHandler = deleteHandler({ status: "running", hasRepo: true });
    const res = await app.inject({
      method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID, acknowledge: true },
    });
    expect(res.statusCode).toBe(409);
    expect(touchedWrite()).toBe(false);
  });

  it("não-master de outro tenant (e não autor) → 403", async () => {
    currentUser = { id: "u3", role: "tenant_admin", tenantId: TENANT };
    queryHandler = deleteHandler({ tenant: OTHER_TENANT, createdBy: "someoneElse", status: "stopped" });
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}`, payload: { confirmId: PROJ_ID } });
    expect(res.statusCode).toBe(403);
    expect(touchedWrite()).toBe(false);
  });

  it("modo legado (sem confirmId) → apaga direto, sem exigir confirmação", async () => {
    queryHandler = deleteHandler({ status: "failed", hasRepo: true });
    const res = await app.inject({ method: "DELETE", url: `/api/projects/${PROJ_ID}?keepFiles=true` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mode).toBe("deleted");
    expect(captured.some((q) => q.sql.includes("DELETE FROM projects WHERE id"))).toBe(true);
  });
});
