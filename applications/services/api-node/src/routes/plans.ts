import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function requireAdmin(user: AuthUser): boolean {
  return user.role === "zentriz_admin";
}

type CreatePlanBody = {
  id?: string;
  name?: string;
  slug?: string;
  maxProjects?: number;
  maxUsersPerTenant?: number;
  monthlyPriceCents?: number;
};

type UpdatePlanBody = {
  name?: string;
  maxProjects?: number;
  maxUsersPerTenant?: number;
  monthlyPriceCents?: number;
};

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    maxProjects: row.max_projects,
    maxUsersPerTenant: row.max_users_per_tenant,
    monthlyPriceCents: row.monthly_price_cents,
  };
}

/** Valida um valor monetário em centavos: inteiro >= 0. */
function isValidPriceCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function planRoutes(app: FastifyInstance) {
  /**
   * GET /api/plans — público (sem auth). Usado pela tela pública /tenant/signup para
   * exibir os planos/preços. Fica FORA do contexto encapsulado autenticado abaixo:
   * um `addHook("preHandler", authMiddleware)` no MESMO escopo do Fastify se aplica a
   * TODAS as rotas do escopo (inclusive as declaradas antes do hook) — por isso as
   * rotas autenticadas vivem num child plugin próprio, sem contaminar esta rota pública.
   */
  app.get("/api/plans", async (_request, reply) => {
    const result = await pool.query(
      `SELECT id, name, slug, max_projects, max_users_per_tenant, monthly_price_cents FROM plans ORDER BY max_projects`
    );
    return reply.send(result.rows.map(mapRow));
  });

  // Rotas autenticadas (admin) em contexto encapsulado — o hook fica restrito a elas.
  await app.register(async (authed) => {
    authed.addHook("preHandler", authMiddleware);
    registerAdminPlanRoutes(authed);
  });
}

function registerAdminPlanRoutes(app: FastifyInstance) {
  /** GET /api/plans/:id — admin only */
  app.get<{ Params: { id: string } }>("/api/plans/:id", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz Admin" });
    }
    const result = await pool.query(
      `SELECT id, name, slug, max_projects, max_users_per_tenant, monthly_price_cents FROM plans WHERE id = $1`,
      [request.params.id]
    );
    if (result.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Plano não encontrado" });
    }
    return reply.send(mapRow(result.rows[0]));
  });

  /** POST /api/plans — zentriz_admin only */
  app.post<{ Body: CreatePlanBody }>("/api/plans", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz Admin" });
    }
    const body = request.body ?? {};
    if (!body.id || typeof body.id !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "id é obrigatório" });
    }
    if (!body.name || typeof body.name !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "name é obrigatório" });
    }
    if (!body.slug || typeof body.slug !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "slug é obrigatório" });
    }
    if (typeof body.maxProjects !== "number" || body.maxProjects < 1) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "maxProjects deve ser inteiro positivo" });
    }
    if (typeof body.maxUsersPerTenant !== "number" || body.maxUsersPerTenant < 1) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "maxUsersPerTenant deve ser inteiro positivo" });
    }
    // Preço é opcional na criação; ausente = 0 (gratuito/a definir). Se enviado, valida.
    const monthlyPriceCents = body.monthlyPriceCents ?? 0;
    if (!isValidPriceCents(monthlyPriceCents)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "monthlyPriceCents deve ser inteiro >= 0 (centavos)" });
    }

    const existing = await pool.query(`SELECT id FROM plans WHERE id = $1 OR slug = $2`, [body.id, body.slug]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({ code: "CONFLICT", message: "Plano com este id ou slug já existe" });
    }

    const result = await pool.query(
      `INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant, monthly_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, slug, max_projects, max_users_per_tenant, monthly_price_cents`,
      [body.id, body.name, body.slug, body.maxProjects, body.maxUsersPerTenant, monthlyPriceCents]
    );
    return reply.status(201).send(mapRow(result.rows[0]));
  });

  /** PATCH /api/plans/:id — zentriz_admin only */
  app.patch<{ Params: { id: string }; Body: UpdatePlanBody }>("/api/plans/:id", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz Admin" });
    }
    const { id } = request.params;
    const body = request.body ?? {};

    const existing = await pool.query(`SELECT id FROM plans WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Plano não encontrado" });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (typeof body.name === "string" && body.name.trim()) {
      updates.push(`name = $${idx++}`);
      values.push(body.name.trim());
    }
    if (typeof body.maxProjects === "number" && body.maxProjects >= 1) {
      updates.push(`max_projects = $${idx++}`);
      values.push(body.maxProjects);
    }
    if (typeof body.maxUsersPerTenant === "number" && body.maxUsersPerTenant >= 1) {
      updates.push(`max_users_per_tenant = $${idx++}`);
      values.push(body.maxUsersPerTenant);
    }
    if (body.monthlyPriceCents !== undefined) {
      if (!isValidPriceCents(body.monthlyPriceCents)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "monthlyPriceCents deve ser inteiro >= 0 (centavos)" });
      }
      updates.push(`monthly_price_cents = $${idx++}`);
      values.push(body.monthlyPriceCents);
    }

    if (updates.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum campo válido para atualizar" });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE plans SET ${updates.join(", ")} WHERE id = $${idx}
       RETURNING id, name, slug, max_projects, max_users_per_tenant, monthly_price_cents`,
      values
    );
    return reply.send(mapRow(result.rows[0]));
  });

  /** DELETE /api/plans/:id — zentriz_admin only, blocks if tenants use the plan */
  app.delete<{ Params: { id: string } }>("/api/plans/:id", async (request, reply) => {
    const user = getUser(request);
    if (!requireAdmin(user)) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz Admin" });
    }
    const { id } = request.params;

    const existing = await pool.query(`SELECT id FROM plans WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Plano não encontrado" });
    }

    const inUse = await pool.query(`SELECT id FROM tenants WHERE plan_id = $1 LIMIT 1`, [id]);
    if (inUse.rows.length > 0) {
      return reply.status(409).send({
        code: "CONFLICT",
        message: "Plano em uso por um ou mais tenants; migre-os antes de remover",
      });
    }

    await pool.query(`DELETE FROM plans WHERE id = $1`, [id]);
    return reply.status(204).send();
  });
}
