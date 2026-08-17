/**
 * tenantScope.ts — Resolução do tenant efetivo de uma requisição, honrando o
 * seletor de tenant do portal (?tenantId=) APENAS para o master (zentriz_admin).
 *
 * Regra de segurança (anti-escalonamento): para tenant_admin/user o tenant vem
 * SEMPRE do próprio JWT — qualquer ?tenantId no query/body é IGNORADO. Só o
 * zentriz_admin (tenant_id NULL) pode escopar a leitura/escrita a um tenant
 * arbitrário, e mesmo assim apenas quando o valor é um UUID válido.
 *
 * Espelha o padrão já usado em routes/projects.ts, users.ts e specs.ts, agora
 * centralizado para os endpoints de configuração (/api/tenant/*, runtime-config,
 * deployments) que antes ignoravam o seletor.
 */
import type { AuthUser } from "../middleware/auth.js";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extrai um tenantId candidato de query ou body (string), ou "" se ausente. */
function pickTenantId(source: unknown): string {
  if (!source || typeof source !== "object") return "";
  const v = (source as { tenantId?: unknown }).tenantId;
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Retorna o tenant efetivo:
 *  - zentriz_admin: o ?tenantId= (query e/ou body) se for UUID válido; senão null.
 *  - tenant_admin/user: sempre user.tenantId (ignora qualquer tenantId fornecido).
 *
 * `null` significa "sem tenant resolvível" — o handler decide (403 / lista vazia).
 */
export function resolveScopedTenantId(
  user: AuthUser,
  ...sources: unknown[]
): string | null {
  if (user.role === "zentriz_admin") {
    for (const src of sources) {
      const candidate = pickTenantId(src);
      if (UUID_RE.test(candidate)) return candidate;
    }
    return null;
  }
  return user.tenantId ?? null;
}
