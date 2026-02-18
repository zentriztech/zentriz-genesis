import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function projectRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get("/api/projects", async (request, reply) => {
    const user = getUser(request);
    const client = await pool.connect();
    try {
      let result;
      if (user.role === "zentriz_admin") {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           ORDER BY p.updated_at DESC`
        );
      } else if (user.tenantId) {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           WHERE p.tenant_id = $1 ORDER BY p.updated_at DESC`,
          [user.tenantId]
        );
      } else {
        result = await client.query(
          `SELECT p.*, u.email as created_by_email FROM projects p
           JOIN users u ON p.created_by = u.id
           WHERE p.created_by = $1 ORDER BY p.updated_at DESC`,
          [user.id]
        );
      }
      const projects = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        title: row.title,
        specRef: row.spec_ref,
        status: row.status,
        charterSummary: row.charter_summary,
        backlogSummary: row.backlog_summary ?? undefined,
        createdAt: (row.created_at as Date)?.toISOString(),
        updatedAt: (row.updated_at as Date)?.toISOString(),
        startedAt: (row.started_at as Date)?.toISOString() ?? undefined,
        completedAt: (row.completed_at as Date)?.toISOString() ?? undefined,
      }));
      return reply.send(projects);
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM projects WHERE id = $1",
        [id]
      );
      const row = result.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId && row.created_by !== user.id) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      return reply.send({
        id: row.id,
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        title: row.title,
        specRef: row.spec_ref,
        status: row.status,
        charterSummary: row.charter_summary,
        backlogSummary: (row as Record<string, unknown>).backlog_summary as string | undefined,
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
        startedAt: (row.started_at as Date)?.toISOString() ?? undefined,
        completedAt: (row.completed_at as Date)?.toISOString() ?? undefined,
      });
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; started_at?: string; completed_at?: string; charter_summary?: string; backlog_summary?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { status, started_at, completed_at, charter_summary, backlog_summary } = request.body ?? {};
      const client = await pool.connect();
      try {
        const check = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [id]);
        const project = check.rows[0];
        if (!project) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && project.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        if (status !== undefined) {
          updates.push(`status = $${i++}`);
          values.push(status);
        }
        if (started_at !== undefined) {
          updates.push(`started_at = $${i++}`);
          values.push(started_at);
        }
        if (completed_at !== undefined) {
          updates.push(`completed_at = $${i++}`);
          values.push(completed_at);
        }
        if (charter_summary !== undefined) {
          updates.push(`charter_summary = $${i++}`);
          values.push(charter_summary);
        }
        if (backlog_summary !== undefined) {
          updates.push(`backlog_summary = $${i++}`);
          values.push(backlog_summary);
        }
        if (updates.length === 0) return reply.send({ ok: true });

        updates.push(`updated_at = now()`);
        values.push(id);
        await client.query(
          `UPDATE projects SET ${updates.join(", ")} WHERE id = $${i}`,
          values
        );
        return reply.send({ ok: true });
      } finally {
        client.release();
      }
    }
  );
}
