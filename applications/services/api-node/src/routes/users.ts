import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { hashPassword, validateEmail, validatePassword } from "../auth.js";
import type { FastifyRequest } from "fastify";

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

type UpdateUserBody = {
  email?: string;
  name?: string;
  password?: string;
  role?: string;
};

const ROLES = new Set(["user", "tenant_admin", "zentriz_admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // A unicidade é (email, role): o mesmo e-mail pode existir em papeis distintos
      // (contas internas Zentriz — migration 049). Checar por e-mail E papel.
      const existing = await client.query("SELECT id FROM users WHERE email = $1 AND role = $2", [email, role]);
      if (existing.rows.length > 0) {
        return reply.status(409).send({ code: "CONFLICT", message: "E-mail já cadastrado para este papel" });
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

  app.get<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const caller = getUser(request);
    const { id } = request.params;
    const result = await pool.query(
      `SELECT id, email, name, tenant_id, role, status, created_at FROM users WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Usuário não encontrado" });
    }
    const row = result.rows[0];
    if (
      caller.role !== "zentriz_admin" &&
      caller.tenantId !== row.tenant_id &&
      caller.id !== id
    ) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }
    return reply.send({
      id: row.id,
      email: row.email,
      name: row.name,
      tenantId: row.tenant_id,
      role: row.role,
      status: row.status,
      createdAt: (row.created_at as Date)?.toISOString(),
    });
  });

  app.patch<{ Params: { id: string }; Body: UpdateUserBody }>("/api/users/:id", async (request, reply) => {
    const caller = getUser(request);
    const { id } = request.params;
    const body = request.body ?? {};

    const existing = await pool.query(
      `SELECT id, tenant_id, role FROM users WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Usuário não encontrado" });
    }
    const target = existing.rows[0];

    const canEdit =
      caller.role === "zentriz_admin" ||
      (caller.role === "tenant_admin" && caller.tenantId === target.tenant_id) ||
      caller.id === id;
    if (!canEdit) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão para editar este usuário" });
    }
    if (caller.role === "tenant_admin" && body.role === "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant admin não pode promover a zentriz_admin" });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (typeof body.name === "string" && body.name.trim().length >= 2) {
      updates.push(`name = $${idx++}`);
      values.push(body.name.trim());
    }
    if (typeof body.email === "string") {
      const email = body.email.trim().toLowerCase();
      if (!validateEmail(email)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "E-mail inválido" });
      }
      updates.push(`email = $${idx++}`);
      values.push(email);
    }
    if (typeof body.password === "string") {
      const pwdCheck = validatePassword(body.password);
      if (!pwdCheck.ok) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: pwdCheck.message });
      }
      updates.push(`password_hash = $${idx++}`);
      values.push(await hashPassword(body.password));
    }
    if (typeof body.role === "string" && ROLES.has(body.role)) {
      updates.push(`role = $${idx++}`);
      values.push(body.role);
    }

    if (updates.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum campo válido para atualizar" });
    }

    values.push(id);
    let result;
    try {
      result = await pool.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx}
         RETURNING id, email, name, tenant_id, role, status, created_at`,
        values
      );
    } catch (err) {
      // Colisão com a unicidade (email, role) → 409 em vez de 500.
      if ((err as { code?: string }).code === "23505") {
        return reply.status(409).send({ code: "CONFLICT", message: "Já existe um usuário com este e-mail e papel" });
      }
      throw err;
    }
    const row = result.rows[0];
    return reply.send({
      id: row.id,
      email: row.email,
      name: row.name,
      tenantId: row.tenant_id,
      role: row.role,
      status: row.status,
      createdAt: (row.created_at as Date)?.toISOString(),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const caller = getUser(request);
    const { id } = request.params;

    if (caller.id === id) {
      return reply.status(409).send({ code: "CONFLICT", message: "Não é possível deletar seu próprio usuário" });
    }

    const existing = await pool.query(
      `SELECT id, tenant_id FROM users WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Usuário não encontrado" });
    }
    const target = existing.rows[0];

    const canDelete =
      caller.role === "zentriz_admin" ||
      (caller.role === "tenant_admin" && caller.tenantId === target.tenant_id);
    if (!canDelete) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão para remover este usuário" });
    }

    // projects.created_by referencia users(id) sem ON DELETE — QUALQUER projeto vinculado
    // (mesmo já aceito/parado) bloquearia o DELETE com violação de FK → 409 explícito.
    const ownedProjects = await pool.query(
      `SELECT id FROM projects WHERE created_by = $1 LIMIT 1`,
      [id]
    );
    if (ownedProjects.rows.length > 0) {
      return reply.status(409).send({ code: "CONFLICT", message: "Usuário possui projetos vinculados; transfira ou remova-os antes de excluir o usuário" });
    }

    try {
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    } catch (err) {
      // Rede de segurança: qualquer outra FK remanescente vira 409 em vez de 500.
      if ((err as { code?: string }).code === "23503") {
        return reply.status(409).send({ code: "CONFLICT", message: "Usuário possui registros vinculados; remova-os antes de excluir" });
      }
      throw err;
    }
    return reply.status(204).send();
  });

  app.get("/api/users", async (request, reply) => {
    const user = getUser(request);
    // O master pode escopar a listagem a um tenant via ?tenantId= (seletor de tenant do portal).
    const q = (request.query ?? {}) as { tenantId?: string };
    // tenantId inválido (não-UUID) é ignorado → evita erro de cast uuid (500).
    const scopeTenantId =
      user.role === "zentriz_admin" && q.tenantId && UUID_RE.test(q.tenantId) ? q.tenantId : null;
    let result;
    if (user.role === "zentriz_admin") {
      result = await pool.query(
        `SELECT u.id, u.email, u.name, u.tenant_id, u.role, u.status, u.created_at FROM users u
          WHERE ($1::uuid IS NULL OR u.tenant_id = $1) ORDER BY u.email`,
        [scopeTenantId]
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
