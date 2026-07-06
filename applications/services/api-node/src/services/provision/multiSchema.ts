/**
 * multiSchema.ts — G1-T26 (Fase E). RDS multi-schema + MIGRATING por serviço.
 *
 * Multi-serviço compartilha UMA instância RDS (custo), mas cada serviço API tem seu
 * PRÓPRIO database/schema + credencial (secret distinto) — isolamento sem N instâncias.
 * A migração roda POR serviço (owner = o serviço dono do schema), com advisory lock
 * distinto por serviço para não cruzar donos numa RunTask concorrente.
 *
 * Alinha com G1-T16 (que assumia migração única): no multi-serviço, cada serviço API
 * dispara sua própria RunTask de migrate contra seu DATABASE_URL/schema.
 *
 * Este módulo entrega o PLANO por serviço (nome de db/schema, secret, advisory-lock key,
 * DATABASE_URL). A execução reusa rds (instância compartilhada) + migrating (por serviço).
 */

import type { ServicePlan } from "./tenantProvisioner.js";

export interface ServiceSchemaPlan {
  serviceName: string;
  /** Database dedicado do serviço na instância compartilhada (ex.: app_api). */
  databaseName: string;
  /** Secret distinto por serviço: genesis/<id>/svc/<name>. */
  secretName: string;
  /** Chave do pg_advisory_lock (determinística por serviço) — evita corrida entre donos. */
  advisoryLockKey: number;
  /** DATABASE_URL do serviço (aponta ao seu database na instância compartilhada). */
  databaseUrl: string;
}

/** Só serviços que falam com o banco (api) recebem schema; web/worker não. */
export function servicesNeedingSchema(services: ServicePlan[]): ServicePlan[] {
  return services.filter((s) => s.role === "api");
}

/** Nome de database válido para PG a partir do nome do serviço. */
function dbName(serviceName: string): string {
  const clean = serviceName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return `app_${clean}`.slice(0, 63);
}

/** Advisory-lock key determinística (hash estável 32-bit) por serviço. */
function advisoryKey(serviceName: string): number {
  let h = 2166136261;
  for (let i = 0; i < serviceName.length; i++) {
    h ^= serviceName.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // mantém positivo dentro de int4 (pg_advisory_lock aceita bigint, mas int estável basta)
  return Math.abs(h | 0);
}

export interface RdsConnInfo {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Plano de schema por serviço. Single-service (1 api) → 1 plano com o database default.
 * @param deploymentId  p/ nomear os secrets.
 * @param services      topologia (T24).
 * @param conn          conexão da instância RDS compartilhada (host/port/user/password).
 * @param defaultDb     database default da instância (usado pelo single-service).
 */
export function planServiceSchemas(
  deploymentId: string,
  services: ServicePlan[],
  conn: RdsConnInfo,
  defaultDb = "appdb",
): ServiceSchemaPlan[] {
  const apiServices = servicesNeedingSchema(services);
  const single = apiServices.length <= 1;
  return apiServices.map((svc) => {
    const database = single ? defaultDb : dbName(svc.name);
    const url = `postgresql://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${database}`;
    return {
      serviceName: svc.name,
      databaseName: database,
      secretName: single ? `genesis/${deploymentId}/app` : `genesis/${deploymentId}/svc/${svc.name}`,
      advisoryLockKey: advisoryKey(svc.name),
      databaseUrl: url,
    };
  });
}

/**
 * SQL idempotente para criar os databases dos serviços (roda uma vez na instância
 * compartilhada, antes das migrações por serviço). CREATE DATABASE não aceita IF NOT
 * EXISTS em PG — o caller deve ignorar o erro "already exists" (idempotente).
 */
export function createDatabaseStatements(plans: ServiceSchemaPlan[], defaultDb = "appdb"): string[] {
  return plans
    .filter((p) => p.databaseName !== defaultDb)
    .map((p) => `CREATE DATABASE ${p.databaseName}`);
}
