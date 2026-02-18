import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { hashPassword, validateEmail, validatePassword } from "../auth.js";

type SignupBody = {
  name?: string;
  planId?: string;
  adminEmail?: string;
  adminName?: string;
  password?: string;
};

/** Rotas públicas: listar planos e cadastrar tenant (status=inactive até confirmação de pagamento). */
export async function signupRoutes(app: FastifyInstance) {
  app.get("/api/plans", async (_request, reply) => {
    const result = await pool.query(
      `SELECT id, name, slug, max_projects, max_users_per_tenant FROM plans ORDER BY max_projects ASC`
    );
    return reply.send(
      result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        maxProjects: row.max_projects,
        maxUsersPerTenant: row.max_users_per_tenant,
      }))
    );
  });

  app.post<{ Body: SignupBody }>("/api/tenant/signup", async (request, reply) => {
    const body = request.body ?? {};
    const tenantName = typeof body.name === "string" ? body.name.trim() : "";
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    const adminEmail = typeof body.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
    const adminName = typeof body.adminName === "string" ? body.adminName.trim() : "";
    const password = body.password;

    if (!tenantName || tenantName.length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome da empresa é obrigatório (mín. 2 caracteres)" });
    }
    if (!planId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Selecione um plano" });
    }
    if (!adminEmail) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail do administrador é obrigatório" });
    }
    if (!validateEmail(adminEmail)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail do administrador inválido" });
    }
    if (!adminName || adminName.length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do administrador é obrigatório (mín. 2 caracteres)" });
    }
    if (typeof password !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Senha é obrigatória" });
    }
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.ok) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: pwdCheck.message });
    }

    const client = await pool.connect();
    try {
      const planRow = await client.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (planRow.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inválido" });
      }

      const existingUser = await client.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
      if (existingUser.rows.length > 0) {
        return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado no sistema" });
      }

      await client.query("BEGIN");
      const tenantInsert = await client.query(
        `INSERT INTO tenants (name, plan_id, status) VALUES ($1, $2, 'inactive') RETURNING id, name, plan_id, status, created_at`,
        [tenantName, planId]
      );
      const tenant = tenantInsert.rows[0];
      const tenantId = tenant.id;

      const passwordHash = await hashPassword(password);
      await client.query(
        `INSERT INTO users (email, name, password_hash, tenant_id, role, status)
         VALUES ($1, $2, $3, $4, 'tenant_admin', 'active')
         RETURNING id, email, name, tenant_id, role, status, created_at`,
        [adminEmail, adminName, passwordHash, tenantId]
      );
      await client.query("COMMIT");

      return reply.status(201).send({
        message: "Cadastro realizado. Seu tenant será ativado após a confirmação do pagamento.",
        tenant: {
          id: tenantId,
          name: tenant.name,
          planId: tenant.plan_id,
          status: tenant.status,
          createdAt: (tenant.created_at as Date)?.toISOString?.(),
        },
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}
