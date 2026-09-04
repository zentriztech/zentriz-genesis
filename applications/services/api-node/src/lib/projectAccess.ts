import type { AuthUser } from "../middleware/auth.js";

/**
 * Regra ÚNICA de acesso a projeto (auditoria 2026-09-02, fix 1.4).
 *
 * Antes, a branch `created_by === user.id` concedia acesso IGNORANDO o tenant do projeto —
 * quebrava o invariante multi-tenant em cenários operacionais (usuário movido de tenant via
 * banco, ex-admin demovido, bypass do gate H3 para tenant suspenso). A regra agora:
 *
 *   1. `zentriz_admin` acessa tudo;
 *   2. mesmo tenant (não-nulo) acessa;
 *   3. `created_by` só vale para projeto SEM tenant (legado/seed) — nunca cross-tenant.
 *
 * Estava replicada em 26 pontos (3 helpers + 23 inline em projects.ts); qualquer nova checagem
 * DEVE usar este helper (há grep-guard em teste contra o padrão antigo).
 */
export interface ProjectAccessRow {
  tenant_id?: unknown;
  created_by?: unknown;
}

/** Dono do projeto (autor). Regra ÚNICA — nunca comparar `created_by` inline nas rotas (grep-guard). */
export function isProjectOwner(user: AuthUser, row: { created_by: string | null }): boolean {
  return !!row.created_by && String(row.created_by) === String(user.id);
}

export function canAccessProjectRow(user: AuthUser, row: ProjectAccessRow): boolean {
  if (user.role === "zentriz_admin") return true;
  const rowTenant = (row.tenant_id ?? null) as string | null;
  const userTenant = (user.tenantId ?? null) as string | null;
  if (rowTenant !== null && rowTenant === userTenant) return true;
  if (rowTenant === null && row.created_by === user.id) return true;
  return false;
}
