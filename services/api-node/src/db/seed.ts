import type { PoolClient } from "pg";
import { pool } from "./client.js";
import { hashPassword } from "../auth.js";

/** E-mail e senha padrão do usuário Zentriz Admin (login/genesis). Documentado em README e SECRETS_AND_ENV. */
export const ZENTRIZ_ADMIN_EMAIL = "admin@zentriz.com";
export const ZENTRIZ_ADMIN_DEFAULT_PASSWORD = "#Jean@2026!";

/** Senhas padrão do tenant demo (login e login/tenant). Documentado em README. */
export const TENANT_ADMIN_EMAIL = "admin@tenant.com";
export const TENANT_ADMIN_DEFAULT_PASSWORD = "#Tenant@2026!";
export const USER_TENANT_EMAIL = "user@tenant.com";
export const USER_TENANT_DEFAULT_PASSWORD = "#User@2026!";

export async function seedIfEmpty(): Promise<void> {
  const client = await pool.connect();
  try {
    const userCount = await client.query("SELECT COUNT(*) FROM users");
    if (Number(userCount.rows[0].count) > 0) {
      await ensureZentrizAdmin(client);
      await ensureTenantDemoUsers(client);
      return;
    }

    await client.query("INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
      ["plan_ouro", "Ouro", "ouro", 10, 20]);

    const tenantResult = await client.query(
      "INSERT INTO tenants (name, plan_id, status) VALUES ($1, $2, $3) RETURNING id",
      ["Tenant Demo", "plan_ouro", "active"]
    );
    const tenantId = tenantResult.rows[0].id;

    const userHash = await hashPassword(USER_TENANT_DEFAULT_PASSWORD);
    const tenantAdminHash = await hashPassword(TENANT_ADMIN_DEFAULT_PASSWORD);
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [USER_TENANT_EMAIL, "User Demo", userHash, tenantId, "user", "active"]
    );
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [TENANT_ADMIN_EMAIL, "Admin Tenant", tenantAdminHash, tenantId, "tenant_admin", "active"]
    );

    const adminHash = await hashPassword(ZENTRIZ_ADMIN_DEFAULT_PASSWORD);
    await client.query(
      `INSERT INTO users (email, name, password_hash, tenant_id, role, status) VALUES ($1, $2, $3, NULL, $4, $5)`,
      [ZENTRIZ_ADMIN_EMAIL, "Zentriz Admin", adminHash, "zentriz_admin", "active"]
    );
  } finally {
    client.release();
  }
}

/** Garante que os usuários do tenant demo têm senhas hasheadas e user@tenant.com no mesmo tenant que admin@tenant.com. */
async function ensureTenantDemoUsers(client: PoolClient): Promise<void> {
  const tenantAdminHash = await hashPassword(TENANT_ADMIN_DEFAULT_PASSWORD);
  const userHash = await hashPassword(USER_TENANT_DEFAULT_PASSWORD);
  await client.query(
    `UPDATE users SET password_hash = $1, name = $2 WHERE email = $3`,
    [tenantAdminHash, "Admin Tenant", TENANT_ADMIN_EMAIL]
  );
  const tid = await client.query(`SELECT tenant_id FROM users WHERE email = $1 LIMIT 1`, [TENANT_ADMIN_EMAIL]);
  const tenantId = tid.rows[0]?.tenant_id;
  if (tenantId) {
    await client.query(
      `UPDATE users SET tenant_id = $1, password_hash = $2, name = $3 WHERE email = $4`,
      [tenantId, userHash, "User Demo", USER_TENANT_EMAIL]
    );
  }
}

/** Garante que o usuário Zentriz Admin existe com senha hasheada (cria ou atualiza). Roda após seed. */
async function ensureZentrizAdmin(client: PoolClient): Promise<void> {
  const hash = await hashPassword(ZENTRIZ_ADMIN_DEFAULT_PASSWORD);
  await client.query(
    `INSERT INTO users (email, name, password_hash, tenant_id, role, status)
     VALUES ($1, $2, $3, NULL, $4, $5)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name`,
    [ZENTRIZ_ADMIN_EMAIL, "Zentriz Admin", hash, "zentriz_admin", "active"]
  );
}
