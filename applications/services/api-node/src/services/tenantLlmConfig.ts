/**
 * tenantLlmConfig.ts — G38: Resolve configuração de LLM por tenant com prioridade.
 *
 * Cada tenant pode ter até 4 configs LLM (priority 0-3: Padrão + 3 Contingências).
 * O runner tenta em ordem crescente de prioridade; pula configs sem credenciais válidas.
 *
 * priority 0 = Padrão       (sempre tentado primeiro)
 * priority 1 = Contingência 1
 * priority 2 = Contingência 2
 * priority 3 = Contingência 3
 */

import { pool } from "../db/client.js";

export interface TenantLlmConfig {
  provider: string;
  modelId: string;
  modelIdFallback: string | null;
  credentials: Record<string, string>;
  maxConcurrentProjects: number;
  dailyTokenQuota: number | null;
  deadpoolTokenReserve: number;
  isDefault: boolean;
  priority: number;
}

export interface ResolvedLlmConfig {
  provider:            string;
  modelId:             string;
  fallbackModelId?:    string;   // modelo para rework/QA-escalation
  apiKey:              string;
  awsRegion?:          string;
  awsAccessKeyId?:     string;
  awsSecretAccessKey?: string;
  isDefault:           boolean;
  priority:            number;
}

const SYSTEM_DEFAULT: TenantLlmConfig = {
  provider:              process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
  modelId:               process.env.CLAUDE_MODEL ?? "us.anthropic.claude-sonnet-4-6",
  modelIdFallback:       null,
  credentials:           {},
  maxConcurrentProjects: 3,
  dailyTokenQuota:       null,
  deadpoolTokenReserve:  0,
  isDefault:             true,
  priority:              -1,
};

/** Verifica se uma config tem credenciais mínimas para o seu provider. */
function hasValidCredentials(provider: string, creds: Record<string, string>): boolean {
  switch (provider) {
    case "bedrock":
      // Bedrock pode usar credenciais do env da EC2 — sempre válido
      return true;
    case "openai":
    case "anthropic":
      return !!creds.api_key;
    case "azure_openai":
      return !!(creds.api_key && creds.endpoint && creds.deployment_name);
    default:
      return false;
  }
}

/** Carrega todas as configs ativas de um tenant, ordenadas por prioridade. */
export async function getTenantLlmConfigs(tenantId: string): Promise<TenantLlmConfig[]> {
  try {
    const result = await pool.query(
      `SELECT provider, model_id, model_id_fallback, credentials, max_concurrent_projects,
              daily_token_quota, deadpool_token_reserve, priority
       FROM tenant_llm_configs
       WHERE tenant_id = $1 AND is_active = TRUE
       ORDER BY priority ASC`,
      [tenantId]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      provider:              String(row.provider ?? "bedrock"),
      modelId:               String(row.model_id ?? SYSTEM_DEFAULT.modelId),
      modelIdFallback:       row.model_id_fallback ? String(row.model_id_fallback) : null,
      credentials:           (row.credentials as Record<string, string>) ?? {},
      maxConcurrentProjects: Number(row.max_concurrent_projects ?? 3),
      dailyTokenQuota:       row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
      deadpoolTokenReserve:  Number(row.deadpool_token_reserve ?? 0),
      isDefault:             false,
      priority:              Number(row.priority ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Mantém compatibilidade com código que usa getTenantLlmConfig (singular) — retorna a Padrão. */
export async function getTenantLlmConfig(tenantId: string): Promise<TenantLlmConfig> {
  const configs = await getTenantLlmConfigs(tenantId);
  return configs[0] ?? SYSTEM_DEFAULT;
}

/**
 * FT-13: Resolve a config LLM efetiva para um projeto.
 * Tenta em ordem de prioridade; retorna a primeira com credenciais válidas.
 */
export async function resolveProjectLlmConfig(projectId: string): Promise<ResolvedLlmConfig> {
  let createdByRole = "user";
  let tenantId: string | null = null;

  try {
    const proj = await pool.query(
      `SELECT p.tenant_id, u.role AS creator_role
       FROM projects p JOIN users u ON u.id = p.created_by
       WHERE p.id = $1 LIMIT 1`,
      [projectId]
    );
    if (proj.rows.length > 0) {
      createdByRole = String(proj.rows[0].creator_role ?? "user");
      tenantId      = String(proj.rows[0].tenant_id ?? "");
    }
  } catch { /* fall through */ }

  // zentriz_admin → zentriz_llm_config global
  if (createdByRole === "zentriz_admin") {
    try {
      const res = await pool.query(
        `SELECT provider, model_id, credentials FROM zentriz_llm_config WHERE is_active = TRUE LIMIT 1`
      );
      if (res.rows.length > 0) {
        const row   = res.rows[0] as Record<string, unknown>;
        const creds = (row.credentials as Record<string, string>) ?? {};
        return {
          provider:           String(row.provider ?? "bedrock"),
          modelId:            String(row.model_id ?? SYSTEM_DEFAULT.modelId),
          apiKey:             creds.api_key ?? process.env.CLAUDE_API_KEY ?? "",
          awsRegion:          creds.aws_region,
          awsAccessKeyId:     creds.aws_access_key_id,
          awsSecretAccessKey: creds.aws_secret_access_key,
          isDefault:          false,
          priority:           0,
        };
      }
    } catch { /* fall through */ }

    return {
      provider:  process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
      modelId:   process.env.CLAUDE_MODEL ?? SYSTEM_DEFAULT.modelId,
      apiKey:    process.env.CLAUDE_API_KEY ?? "",
      awsRegion: process.env.GENESIS_AWS_REGION,
      isDefault: true,
      priority:  -1,
    };
  }

  // tenant_admin/user → tenta em ordem de prioridade
  if (tenantId) {
    const configs = await getTenantLlmConfigs(tenantId);
    for (const cfg of configs) {
      if (hasValidCredentials(cfg.provider, cfg.credentials)) {
        return {
          provider:           cfg.provider,
          modelId:            cfg.modelId,
          fallbackModelId:    cfg.modelIdFallback ?? undefined,
          apiKey:             cfg.credentials.api_key ?? "",
          awsRegion:          cfg.credentials.aws_region,
          awsAccessKeyId:     cfg.credentials.aws_access_key_id,
          awsSecretAccessKey: cfg.credentials.aws_secret_access_key,
          isDefault:          false,
          priority:           cfg.priority,
        };
      }
    }
    // Tenant sem nenhum slot com credenciais válidas → erro explícito.
    // NÃO cair no Bedrock da Zentriz — o tenant deve configurar seu próprio LLM.
    throw new Error(
      "Tenant sem configuração de LLM válida. Configure pelo menos um provider em Configurações → LLM."
    );
  }

  // Fallback absoluto — env vars (Bedrock da Zentriz). Só chega aqui para projetos sem tenantId.
  return {
    provider:  process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
    modelId:   process.env.CLAUDE_MODEL ?? SYSTEM_DEFAULT.modelId,
    apiKey:    process.env.CLAUDE_API_KEY ?? "",
    awsRegion: process.env.GENESIS_AWS_REGION,
    isDefault: true,
    priority:  -1,
  };
}

export async function hasConcurrencySlot(tenantId: string): Promise<boolean> {
  try {
    const [configResult, runningResult] = await Promise.all([
      pool.query(
        `SELECT max_concurrent_projects FROM tenant_llm_configs
         WHERE tenant_id = $1 AND is_active = TRUE ORDER BY priority ASC LIMIT 1`,
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
    return true;
  }
}

export async function enqueueOrStart(
  projectId: string,
  tenantId: string
): Promise<"started" | "queued"> {
  const hasSlot = await hasConcurrencySlot(tenantId);
  if (hasSlot) return "started";
  await pool.query(
    `UPDATE projects SET status = 'queued', queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [projectId]
  );
  return "queued";
}
