/**
 * entitlements — licença de PRODUTO por tenant (genesis | deadpool | connect).
 *
 * Até a migration 046 o Genesis só tinha quotas numéricas em `plans` (max_projects,
 * max_users_per_tenant) — não havia como dizer "tenant X tem licença Deadpool".
 * Esta camada lê/escreve `tenant_entitlements`: uma linha por (tenant, produto).
 * Linha ausente OU enabled=false = SEM licença.
 *
 * Conceder/revogar é decisão comercial da Zentriz → só `zentriz_admin` (ver routes/deadpool.ts).
 */

import { pool } from "../db/client.js";

export type Product = "genesis" | "deadpool" | "connect";

/** true somente se existir a linha (tenant, product) com enabled=true. tenantId nulo = sem licença. */
export async function hasEntitlement(tenantId: string | null, product: Product): Promise<boolean> {
  if (!tenantId) return false;
  const res = await pool.query(
    "SELECT enabled FROM tenant_entitlements WHERE tenant_id = $1 AND product = $2",
    [tenantId, product],
  );
  return res.rows.length > 0 && res.rows[0].enabled === true;
}

/** Lista os entitlements de um tenant (produto → habilitado). */
export async function listEntitlements(
  tenantId: string,
): Promise<{ product: Product; enabled: boolean }[]> {
  const res = await pool.query(
    "SELECT product, enabled FROM tenant_entitlements WHERE tenant_id = $1 ORDER BY product",
    [tenantId],
  );
  return res.rows.map((r) => ({ product: r.product as Product, enabled: r.enabled === true }));
}

/** Upsert de um entitlement. grantedBy = id do zentriz_admin que concedeu. */
export async function setEntitlement(
  tenantId: string,
  product: Product,
  enabled: boolean,
  grantedBy?: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_entitlements (tenant_id, product, enabled, granted_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, product) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           granted_by = EXCLUDED.granted_by,
           updated_at = now()`,
    [tenantId, product, enabled, grantedBy ?? null],
  );
}
