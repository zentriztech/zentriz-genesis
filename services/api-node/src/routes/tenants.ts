import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

export async function tenantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get("/api/tenants", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz" });
    }
    const result = await pool.query(
      `SELECT t.id, t.name, t.plan_id, t.status, t.created_at, p.name as plan_name, p.slug as plan_slug
       FROM tenants t JOIN plans p ON t.plan_id = p.id ORDER BY t.name`
    );
    return reply.send(
      result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        planId: row.plan_id,
        plan: { name: row.plan_name, slug: row.plan_slug },
        status: row.status,
        createdAt: (row.created_at as Date)?.toISOString(),
      }))
    );
  });

  app.get<{ Params: { id: string } }>("/api/tenants/:id", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin" && user.tenantId !== request.params.id) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }
    const result = await pool.query(
      `SELECT t.id, t.name, t.plan_id, t.status, t.created_at, p.id as plan_pk, p.name as plan_name, p.slug as plan_slug, p.max_projects, p.max_users_per_tenant
       FROM tenants t JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`,
      [request.params.id]
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Tenant não encontrado" });
    return reply.send({
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      plan: {
        id: row.plan_pk,
        name: row.plan_name,
        slug: row.plan_slug,
        maxProjects: row.max_projects,
        maxUsersPerTenant: row.max_users_per_tenant,
      },
      status: row.status,
      createdAt: (row.created_at as Date).toISOString(),
    });
  });
}
