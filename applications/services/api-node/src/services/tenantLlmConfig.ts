/**
 * tenantLlmConfig.ts — G38: Resolve configuração de LLM por tenant.
 *
 * Prioridade:
 *  1. Config do tenant em tenant_llm_configs (se is_active=true)
 *  2. Fallback para variáveis de ambiente do sistema (Bedrock da Zentriz)
 *
 * Usado pelo runner ao chamar agentes — garante que cada tenant
 * consome LLM da própria conta quando configurado.
 */

import { pool } from "../db/client.js";

export interface TenantLlmConfig {
  provider: string;
  modelId: string;
  credentials: Record<string, string>;
  maxConcurrentProjects: number;
  dailyTokenQuota: number | null;
  deadpoolTokenReserve: number;
  isDefault: boolean; // true = usando config do sistema, não do tenant
}

const SYSTEM_DEFAULT: TenantLlmConfig = {
  provider:              process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
  modelId:               process.env.CLAUDE_MODEL ?? "us.anthropic.claude-sonnet-4-6",
  credentials:           {},
  maxConcurrentProjects: 3,
  dailyTokenQuota:       null,
  deadpoolTokenReserve:  0,
  isDefault:             true,
};

export async function getTenantLlmConfig(tenantId: string): Promise<TenantLlmConfig> {
  try {
    const result = await pool.query(
      `SELECT provider, model_id, credentials, max_concurrent_projects,
              daily_token_quota, deadpool_token_reserve
       FROM tenant_llm_configs
       WHERE tenant_id = $1 AND is_active = TRUE
       LIMIT 1`,
      [tenantId]
    );
    if (result.rows.length === 0) return SYSTEM_DEFAULT;

    const row = result.rows[0] as Record<string, unknown>;
    return {
      provider:              String(row.provider ?? "bedrock"),
      modelId:               String(row.model_id ?? SYSTEM_DEFAULT.modelId),
      credentials:           (row.credentials as Record<string, string>) ?? {},
      maxConcurrentProjects: Number(row.max_concurrent_projects ?? 3),
      dailyTokenQuota:       row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
      deadpoolTokenReserve:  Number(row.deadpool_token_reserve ?? 0),
      isDefault:             false,
    };
  } catch {
    // Table may not exist yet (migration pending) — fall back to system default
    return SYSTEM_DEFAULT;
  }
}

/**
 * G39: Verifica se o tenant tem slot disponível para iniciar um novo projeto.
 * Retorna true se running_count < max_concurrent_projects.
 */
export async function hasConcurrencySlot(tenantId: string): Promise<boolean> {
  try {
    const [configResult, runningResult] = await Promise.all([
      pool.query(
        `SELECT max_concurrent_projects FROM tenant_llm_configs
         WHERE tenant_id = $1 AND is_active = TRUE LIMIT 1`,
        [tenantId]
      ),
      pool.query(
        `SELECT COUNT(*) AS running_count FROM projects
         WHERE tenant_id = $1 AND status = 'running'`,
        [tenantId]
      ),
    ]);

    const maxConcurrent = configResult.rows[0]
      ? Number(configResult.rows[0].max_concurrent_projects)
      : SYSTEM_DEFAULT.maxConcurrentProjects;

    const runningCount = Number(runningResult.rows[0]?.running_count ?? 0);
    return runningCount < maxConcurrent;
  } catch {
    return true; // fail-open: se não conseguir verificar, permite iniciar
  }
}

/**
 * G39: Coloca projeto na fila se não houver slot disponível.
 * Retorna "started" ou "queued".
 */
export async function enqueueOrStart(
  projectId: string,
  tenantId: string
): Promise<"started" | "queued"> {
  const hasSlot = await hasConcurrencySlot(tenantId);
  if (hasSlot) return "started";

  await pool.query(
    `UPDATE projects SET status = 'queued', queued_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [projectId]
  );
  return "queued";
}
