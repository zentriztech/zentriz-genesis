import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { hashPassword, validateEmail, validatePassword } from "../auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type CreateUserBody = {
  email?: string;
  name?: string;
  password?: string;
  tenant_id?: string | null;
  role?: string;
};

const ROLES = new Set(["user", "tenant_admin", "zentriz_admin"]);

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Body: CreateUserBody }>("/api/users", async (request, reply) => {
    const user = getUser(request);
    const body = request.body ?? {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = body.password;
    const tenantId = body.tenant_id ?? null;
    const role = typeof body.role === "string" ? body.role : "user";

    if (!email) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail é obrigatório" });
    }
    if (!validateEmail(email)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail inválido" });
    }
    if (!name || name.length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome é obrigatório (mín. 2 caracteres)" });
    }
    if (typeof password !== "string") {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Senha é obrigatória" });
    }
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.ok) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: pwdCheck.message });
    }
    if (!ROLES.has(role)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Role inválido" });
    }

    const effectiveTenantId = tenantId === null || tenantId === "" ? null : tenantId;
    if (user.role === "tenant_admin") {
      if (effectiveTenantId !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Só pode criar usuários no seu tenant" });
      }
      if (role === "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant admin não pode criar zentriz_admin" });
      }
    } else if (user.role === "zentriz_admin") {
      // pode criar em qualquer tenant ou sem tenant (zentriz_admin)
    } else {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão para criar usuários" });
    }

    const client = await pool.connect();
    try {
      const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length > 0) {
        return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado" });
      }
      const passwordHash = await hashPassword(password);
      const insert = await client.query(
        `INSERT INTO users (email, name, password_hash, tenant_id, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id, email, name, tenant_id, role, status, created_at`,
        [email, name, passwordHash, effectiveTenantId, role]
      );
      const row = insert.rows[0];
      return reply.status(201).send({
        id: row.id,
        email: row.email,
        name: row.name,
        tenantId: row.tenant_id,
        role: row.role,
        status: row.status,
        createdAt: (row.created_at as Date)?.toISOString(),
      });
    } finally {
      client.release();
    }
  });

  app.get("/api/users", async (request, reply) => {
    const user = getUser(request);
    let result;
    if (user.role === "zentriz_admin") {
      result = await pool.query(
        `SELECT u.id, u.email, u.name, u.tenant_id, u.role, u.status, u.created_at FROM users u ORDER BY u.email`
      );
    } else if (user.tenantId) {
      result = await pool.query(
        `SELECT id, email, name, tenant_id, role, status, created_at FROM users WHERE tenant_id = $1 ORDER BY email`,
        [user.tenantId]
      );
    } else {
      result = await pool.query(
        `SELECT id, email, name, tenant_id, role, status, created_at FROM users WHERE id = $1`,
        [user.id]
      );
    }
    return reply.send(
      result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        tenantId: row.tenant_id,
        role: row.role,
        status: row.status,
        createdAt: (row.created_at as Date)?.toISOString(),
      }))
    );
  });
}
