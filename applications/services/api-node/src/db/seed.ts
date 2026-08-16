import type { PoolClient } from "pg";
import { pool } from "./client.js";
import { hashPassword } from "../auth.js";

/**
 * Contas Zentriz (uso interno — Jean). As tres compartilham o MESMO e-mail
 * jean@zentriz.com.br e a MESMA senha; o papel é escolhido pela tela de login
 * (unicidade no banco é (email, role) — ver migration 049).
 *   - zentriz_admin: conta master, sem tenant, controla tudo e gerencia tenants (login/genesis)
 *   - tenant_admin : admin do tenant modelo ZFactory (login/tenant)
 *   - user         : usuário do tenant modelo ZFactory (login)
 * Documentado em README e SECRETS_AND_ENV. **Em produção, altere as senhas.**
 */
export const ZENTRIZ_EMAIL = "jean@zentriz.com.br";
export const ZENTRIZ_DEFAULT_PASSWORD = "#Jean@2026!";

/** Tenant modelo da Zentriz (antes "Tenant Demo"). */
export const MODEL_TENANT_NAME = "ZFactory";

// Aliases retrocompatíveis (mantêm imports existentes válidos).
export const ZENTRIZ_ADMIN_EMAIL = ZENTRIZ_EMAIL;
export const ZENTRIZ_ADMIN_DEFAULT_PASSWORD = ZENTRIZ_DEFAULT_PASSWORD;
export const TENANT_ADMIN_EMAIL = ZENTRIZ_EMAIL;
export const TENANT_ADMIN_DEFAULT_PASSWORD = ZENTRIZ_DEFAULT_PASSWORD;
export const USER_TENANT_EMAIL = ZENTRIZ_EMAIL;
export const USER_TENANT_DEFAULT_PASSWORD = ZENTRIZ_DEFAULT_PASSWORD;

export async function seedIfEmpty(): Promise<void> {
  const client = await pool.connect();
  try {
    const userCount = await client.query("SELECT COUNT(*) FROM users");
    if (Number(userCount.rows[0].count) > 0) {
      await ensureZentrizAdmin(client);
      await ensureModelTenantUsers(client);
      return;
    }

    await client.query("INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
      ["plan_ouro", "Ouro", "ouro", 10, 20]);

    const tenantResult = await client.query(
      "INSERT INTO tenants (name, plan_id, status) VALUES ($1, $2, $3) RETURNING id",
      [MODEL_TENANT_NAME, "plan_ouro", "active"]
    );
    const tenantId = tenantResult.rows[0].id;

    const sharedHash = await hashPassword(ZENTRIZ_DEFAULT_PASSWORD);
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ZENTRIZ_EMAIL, "ZFactory User", sharedHash, tenantId, "user", "active"]
    );
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ZENTRIZ_EMAIL, "ZFactory Admin", sharedHash, tenantId, "tenant_admin", "active"]
    );
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, NULL, $4, $5)`,
      [ZENTRIZ_EMAIL, "Zentriz Admin", sharedHash, "zentriz_admin", "active"]
    );
  } finally {
    client.release();
  }
}

/** Reconciliação dos usuários do tenant modelo ZFactory (senha/nome/tenant), por papel. */
async function ensureModelTenantUsers(client: PoolClient): Promise<void> {
  const hash = await hashPassword(ZENTRIZ_DEFAULT_PASSWORD);
  await client.query(
    `UPDATE users SET password_hash = $1, name = $2 WHERE email = $3 AND role = 'tenant_admin'`,
    [hash, "ZFactory Admin", ZENTRIZ_EMAIL]
  );
  const tid = await client.query(
    `SELECT tenant_id FROM users WHERE email = $1 AND role = 'tenant_admin' LIMIT 1`,
    [ZENTRIZ_EMAIL]
  );
  const tenantId = tid.rows[0]?.tenant_id;
  if (tenantId) {
    await client.query(
      `UPDATE users SET tenant_id = $1, password_hash = $2, name = $3 WHERE email = $4 AND role = 'user'`,
      [tenantId, hash, "ZFactory User", ZENTRIZ_EMAIL]
    );
  }
}

/** Garante o usuário master Zentriz (cria ou atualiza), casando com a unicidade (email, role). */
async function ensureZentrizAdmin(client: PoolClient): Promise<void> {
  const hash = await hashPassword(ZENTRIZ_DEFAULT_PASSWORD);
  await client.query(
    `INSERT INTO users (email, name, password_hash, tenant_id, role, status)
     VALUES ($1, $2, $3, NULL, $4, $5)
     ON CONFLICT (email, role) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name`,
    [ZENTRIZ_EMAIL, "Zentriz Admin", hash, "zentriz_admin", "active"]
  );
}
