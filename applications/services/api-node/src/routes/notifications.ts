import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { notifyTelegramTenant } from "./telegram.js";
import type { FastifyRequest } from "fastify";

const TELEGRAM_NOTIFY_TYPES = new Set(["project_finished", "blocked", "alert"]);

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const VALID_TYPES = new Set([
  "project_finished",
  "provisioning_done",
  "blocked",
  "alert",
]);

type CreateNotificationBody = {
  tenant_id?: string | null;
  user_id?: string | null;
  project_id?: string | null;
  type?: string;
  title?: string;
  body?: string;
};

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read: row.read,
    createdAt: (row.created_at as Date)?.toISOString(),
  };
}

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  /** GET /api/notifications — lista para o usuário autenticado, mais recentes primeiro */
  app.get("/api/notifications", async (request, reply) => {
    const caller = getUser(request);
    const result = await pool.query(
      `SELECT id, tenant_id, user_id, project_id, type, title, body, read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [caller.id]
    );
    return reply.send(result.rows.map(mapRow));
  });

  /** POST /api/notifications — cria notificação (runner ou evento interno) */
  app.post<{ Body: CreateNotificationBody }>("/api/notifications", async (request, reply) => {
    const caller = getUser(request);
    const body = request.body ?? {};

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "title é obrigatório" });
    }
    if (!body.type || !VALID_TYPES.has(body.type)) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: `type inválido; aceitos: ${[...VALID_TYPES].join(", ")}`,
      });
    }

    const tenantId = body.tenant_id ?? caller.tenantId ?? null;
    const userId = body.user_id ?? caller.id;
    const projectId = body.project_id ?? null;

    const result = await pool.query(
      `INSERT INTO notifications (tenant_id, user_id, project_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, user_id, project_id, type, title, body, read, created_at`,
      [tenantId, userId, projectId, body.type, body.title.trim(), body.body ?? ""]
    );

    // Push Telegram para tipos críticos — fire-and-forget
    if (tenantId && TELEGRAM_NOTIFY_TYPES.has(body.type)) {
      const emoji: Record<string, string> = {
        project_finished: "✅",
        blocked: "⚠️",
        alert: "🚨",
      };
      const icon = emoji[body.type] ?? "📢";
      notifyTelegramTenant(tenantId, `${icon} *${body.title.trim()}*\n${body.body ?? ""}`).catch(() => {});
    }

    return reply.status(201).send(mapRow(result.rows[0]));
  });

  /** PATCH /api/notifications/:id/read — marca como lida */
  app.patch<{ Params: { id: string } }>("/api/notifications/:id/read", async (request, reply) => {
    const caller = getUser(request);
    const { id } = request.params;

    const existing = await pool.query(
      `SELECT id, user_id FROM notifications WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Notificação não encontrada" });
    }
    if (existing.rows[0].user_id !== caller.id && caller.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }

    const result = await pool.query(
      `UPDATE notifications SET read = true WHERE id = $1
       RETURNING id, tenant_id, user_id, project_id, type, title, body, read, created_at`,
      [id]
    );
    return reply.send(mapRow(result.rows[0]));
  });

  /** DELETE /api/notifications/:id — remove notificação própria */
  app.delete<{ Params: { id: string } }>("/api/notifications/:id", async (request, reply) => {
    const caller = getUser(request);
    const { id } = request.params;

    const existing = await pool.query(
      `SELECT id, user_id FROM notifications WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Notificação não encontrada" });
    }
    if (existing.rows[0].user_id !== caller.id && caller.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }

    await pool.query(`DELETE FROM notifications WHERE id = $1`, [id]);
    return reply.status(204).send();
  });
}
