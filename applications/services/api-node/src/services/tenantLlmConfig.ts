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
 * FT-13: Resolve LLM config pelo role do created_by do projeto.
 *  - zentriz_admin  → zentriz_llm_config (global)
 *  - tenant_admin/user → tenant_llm_configs (do tenant)
 * Se config não existir para a autoridade → erro explícito (pipeline não inicia sem config).
 */
export interface ResolvedLlmConfig {
  provider:   string;
  modelId:    string;
  apiKey:     string;     // CLAUDE_API_KEY ou equivalente
  awsRegion?: string;     // para Bedrock
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  isDefault:  boolean;
}

export async function resolveProjectLlmConfig(projectId: string): Promise<ResolvedLlmConfig> {
  // 1. Buscar o projeto e o role do created_by
  let createdByRole = "user";
  let tenantId: string | null = null;
  try {
    const projResult = await pool.query(
      `SELECT p.tenant_id, u.role AS creator_role
       FROM projects p
       JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 LIMIT 1`,
      [projectId]
    );
    if (projResult.rows.length > 0) {
      createdByRole = String(projResult.rows[0].creator_role ?? "user");
      tenantId = String(projResult.rows[0].tenant_id ?? "");
    }
  } catch {
    // fall through to env fallback
  }

  // 2. zentriz_admin → zentriz_llm_config
  if (createdByRole === "zentriz_admin") {
    try {
      const res = await pool.query(
        `SELECT provider, model_id, credentials FROM zentriz_llm_config WHERE is_active = TRUE LIMIT 1`
      );
      if (res.rows.length > 0) {
        const row = res.rows[0] as Record<string, unknown>;
        const creds = (row.credentials as Record<string, string>) ?? {};
        return {
          provider:            String(row.provider ?? "anthropic"),
          modelId:             String(row.model_id ?? SYSTEM_DEFAULT.modelId),
          apiKey:              creds.api_key ?? process.env.CLAUDE_API_KEY ?? "",
          awsRegion:           creds.aws_region,
          awsAccessKeyId:      creds.aws_access_key_id,
          awsSecretAccessKey:  creds.aws_secret_access_key,
          isDefault:           false,
        };
      }
    } catch {
      // table may not exist yet — fall through to env
    }
    // zentriz_admin sem config configurada → usar env (allows bootstrap)
    return {
      provider:   process.env.GENESIS_LLM_PROVIDER ?? "anthropic",
      modelId:    process.env.CLAUDE_MODEL ?? SYSTEM_DEFAULT.modelId,
      apiKey:     process.env.CLAUDE_API_KEY ?? "",
      awsRegion:  process.env.GENESIS_AWS_REGION,
      isDefault:  true,
    };
  }

  // 3. tenant_admin/user → tenant_llm_configs
  if (tenantId) {
    const tenantCfg = await getTenantLlmConfig(tenantId);
    if (!tenantCfg.isDefault) {
      const creds = tenantCfg.credentials;
      return {
        provider:            tenantCfg.provider,
        modelId:             tenantCfg.modelId,
        apiKey:              creds.api_key ?? "",
        awsRegion:           creds.aws_region,
        awsAccessKeyId:      creds.aws_access_key_id,
        awsSecretAccessKey:  creds.aws_secret_access_key,
        isDefault:           false,
      };
    }
  }

  // 4. Fallback absoluto — env vars
  return {
    provider:   process.env.GENESIS_LLM_PROVIDER ?? "anthropic",
    modelId:    process.env.CLAUDE_MODEL ?? SYSTEM_DEFAULT.modelId,
    apiKey:     process.env.CLAUDE_API_KEY ?? "",
    awsRegion:  process.env.GENESIS_AWS_REGION,
    isDefault:  true,
  };
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
