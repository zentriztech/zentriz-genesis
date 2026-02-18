import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

async function checkProjectAccess(
  client: { query: (q: string, p?: string[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
  user: AuthUser
): Promise<boolean> {
  const result = await client.query("SELECT tenant_id, created_by FROM projects WHERE id = $1", [projectId]);
  const row = result.rows[0];
  if (!row) return false;
  if (user.role === "zentriz_admin") return true;
  if (user.tenantId && row.tenant_id === user.tenantId) return true;
  if (row.created_by === user.id) return true;
  return false;
}

export async function dialogueRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { id: string } }>("/api/projects/:id/dialogue", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      const result = await client.query(
        `SELECT id, from_agent, to_agent, event_type, summary_human, request_id, created_at
         FROM project_dialogue WHERE project_id = $1 ORDER BY created_at ASC`,
        [projectId]
      );
      const items = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        eventType: row.event_type,
        summaryHuman: row.summary_human,
        requestId: row.request_id,
        createdAt: (row.created_at as Date)?.toISOString(),
      }));
      return reply.send(items);
    } finally {
      client.release();
    }
  });

  app.post<{
    Params: { id: string };
    Body: { from_agent: string; to_agent: string; event_type?: string; summary_human: string; request_id?: string };
  }>("/api/projects/:id/dialogue", async (request, reply) => {
    const user = getUser(request);
    const { id: projectId } = request.params;
    const { from_agent, to_agent, event_type, summary_human, request_id } = request.body ?? {};
    if (!from_agent || !to_agent || !summary_human) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "from_agent, to_agent e summary_human são obrigatórios" });
    }
    const client = await pool.connect();
    try {
      const allowed = await checkProjectAccess(client, projectId, user);
      if (!allowed) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

      await client.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human, request_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, from_agent, to_agent, event_type ?? null, summary_human, request_id ?? null]
      );
      return reply.status(201).send({ ok: true });
    } finally {
      client.release();
    }
  });
}
