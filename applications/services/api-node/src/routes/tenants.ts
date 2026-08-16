import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const TENANT_STATUSES = ["active", "suspended", "inactive"] as const;
type TenantStatus = (typeof TENANT_STATUSES)[number];

type CreateTenantBody = { name?: string; planId?: string; status?: string };
type UpdateTenantBody = { name?: string; planId?: string; status?: string };

/** Garante que o chamador é o master Zentriz; caso contrário responde 403 e retorna false. */
function requireZentrizAdmin(request: FastifyRequest, reply: { status: (c: number) => { send: (b: unknown) => unknown } }): boolean {
  const user = getUser(request);
  if (user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz" });
    return false;
  }
  return true;
}

export async function tenantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Lista todos os tenants com plano e contadores de uso (só master).
  app.get("/api/tenants", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const result = await pool.query(
      `SELECT t.id, t.name, t.plan_id, t.status, t.created_at,
              p.name AS plan_name, p.slug AS plan_slug, p.max_projects, p.max_users_per_tenant,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id)     AS users_count,
              (SELECT COUNT(*) FROM projects pr WHERE pr.tenant_id = t.id) AS projects_count
         FROM tenants t JOIN plans p ON t.plan_id = p.id
        ORDER BY t.name`
    );
    return reply.send(
      result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        planId: row.plan_id,
        plan: {
          name: row.plan_name,
          slug: row.plan_slug,
          maxProjects: row.max_projects,
          maxUsersPerTenant: row.max_users_per_tenant,
        },
        status: row.status,
        usersCount: Number(row.users_count),
        projectsCount: Number(row.projects_count),
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

  // Cria tenant (só master). Nasce 'active' por padrão (provisionamento interno).
  app.post<{ Body: CreateTenantBody }>("/api/tenants", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const { name, planId, status } = request.body ?? {};
    if (!name || name.trim().length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do tenant deve ter ao menos 2 caracteres" });
    }
    if (!planId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "planId é obrigatório" });
    }
    // Status inválido é rejeitado (consistente com o PATCH) em vez de virar 'active' silenciosamente.
    if (status !== undefined && !TENANT_STATUSES.includes(status as TenantStatus)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `status deve ser um de: ${TENANT_STATUSES.join(", ")}` });
    }
    const finalStatus: TenantStatus = (status as TenantStatus | undefined) ?? "active";

    const client = await pool.connect();
    try {
      const plan = await client.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (plan.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inexistente" });
      }
      const result = await client.query(
        `INSERT INTO tenants (name, plan_id, status) VALUES ($1, $2, $3)
         RETURNING id, name, plan_id, status, created_at`,
        [name.trim(), planId, finalStatus]
      );
      const row = result.rows[0];
      return reply.status(201).send({
        id: row.id,
        name: row.name,
        planId: row.plan_id,
        status: row.status,
        createdAt: (row.created_at as Date).toISOString(),
      });
    } finally {
      client.release();
    }
  });

  // Atualiza nome / plano / status do tenant (só master). Base do gerenciamento de status.
  app.patch<{ Params: { id: string }; Body: UpdateTenantBody }>("/api/tenants/:id", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const { name, planId, status } = request.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do tenant deve ter ao menos 2 caracteres" });
      }
      sets.push(`name = $${i++}`);
      params.push(name.trim());
    }
    if (planId !== undefined) {
      const plan = await pool.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (plan.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inexistente" });
      }
      sets.push(`plan_id = $${i++}`);
      params.push(planId);
    }
    if (status !== undefined) {
      if (!TENANT_STATUSES.includes(status as TenantStatus)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `status deve ser um de: ${TENANT_STATUSES.join(", ")}` });
      }
      sets.push(`status = $${i++}`);
      params.push(status);
    }

    if (sets.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nada para atualizar" });
    }

    params.push(request.params.id);
    const result = await pool.query(
      `UPDATE tenants SET ${sets.join(", ")} WHERE id = $${i}
       RETURNING id, name, plan_id, status, created_at`,
      params
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Tenant não encontrado" });
    return reply.send({
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      status: row.status,
      createdAt: (row.created_at as Date).toISOString(),
    });
  });
}
