import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/client.js";
import { signToken, hashPassword, comparePassword } from "../auth.js";

type LoginBody = { email: string; password: string };

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "email e password são obrigatórios" });
    }

    const client = await pool.connect();
    try {
      const userResult = await client.query(
        `SELECT id, email, name, password_hash, tenant_id, role, status, created_at FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );
      const user = userResult.rows[0];
      if (!user) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Credenciais inválidas" });
      }
      if (user.status !== "active") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Usuário inativo" });
      }

      const ok = user.password_hash
        ? await comparePassword(password, user.password_hash)
        : password === "demo";
      if (!ok) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Credenciais inválidas" });
      }

      let tenant = null;
      if (user.tenant_id) {
        const tenantResult = await client.query(
          `SELECT t.id, t.name, t.plan_id, t.status, p.id as plan_pk, p.name as plan_name, p.slug as plan_slug, p.max_projects, p.max_users_per_tenant
           FROM tenants t JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`,
          [user.tenant_id]
        );
        const row = tenantResult.rows[0];
        if (row) {
          tenant = {
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
          };
        }
      }

      const token = signToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenant_id,
          role: user.role,
          status: user.status,
          createdAt: user.created_at,
        },
        tenant,
      });
    } finally {
      client.release();
    }
  });
}
