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

/**
 * Override de LLM para chamadas da BANCADA aos agents (spec-chat/Resolver GAPs, validador, splitter,
 * planner de evolução) — "a Bancada usa a mesma configuração da fábrica" (Jean, 2026-09-04).
 *
 * A fábrica resolve a config do tenant em `runner_server.py` (GET /api/internal/project-llm-config)
 * e injeta no env do run: CLAUDE_MODEL=model_id, CLAUDE_MODEL_REWORK=model_id_fallback, AWS_*=credenciais
 * do tenant (se houver; senão herda a identidade do container). Antes deste helper, TODA a Bancada
 * ignorava isso e usava o `CLAUDE_MODEL` do env dos agents com a identidade do host — em prod a conta
 * 820 não tem opus-4-8/fable → 403 → fallback silencioso para sonnet-4-6 (achado 2026-09-04).
 *
 * Contrato com os agents (server.py aceita em /invoke/raw, /invoke/cto/async, /invoke/product_architect/async,
 * /invoke/spec_validator/async): `model_id` (principal), `model_id_rework` (informativo) e `llm_config`
 * {provider, model, aws_access_key_id?, aws_secret_access_key?, aws_region?, api_key?} — mesmo shape
 * que o runner já manda no envelope (`runner.py` `_llm_config`). Credenciais viajam só container→container.
 */
export interface AgentsLlmOverride {
  model_id?: string;
  model_id_rework?: string;
  llm_config: Record<string, string>;
  /** true quando nada foi resolvido (env default) — os agents usam o próprio env. */
  isDefault: boolean;
}

function toAgentsOverride(cfg: ResolvedLlmConfig): AgentsLlmOverride {
  if (cfg.isDefault) return { llm_config: {}, isDefault: true };
  const llm: Record<string, string> = { provider: cfg.provider, model: cfg.modelId };
  if (cfg.awsAccessKeyId && cfg.awsSecretAccessKey) {
    llm.aws_access_key_id = cfg.awsAccessKeyId;
    llm.aws_secret_access_key = cfg.awsSecretAccessKey;
    if (cfg.awsRegion) llm.aws_region = cfg.awsRegion;
  }
  if (cfg.apiKey && cfg.provider !== "bedrock") llm.api_key = cfg.apiKey;
  return {
    model_id: cfg.modelId,
    ...(cfg.fallbackModelId ? { model_id_rework: cfg.fallbackModelId } : {}),
    llm_config: llm,
    isDefault: false,
  };
}

/**
 * Resolve o override para a Bancada. Prefere o PROJETO (mesma autoridade da fábrica: zentriz_admin →
 * config global; tenant → slot por prioridade); sem projeto, usa a config Padrão do tenant. NUNCA lança
 * (falha → default do env, igual ao comportamento anterior) e NUNCA loga credenciais.
 */
export async function resolveWorkbenchLlm(opts: { projectId?: string | null; tenantId?: string | null }): Promise<AgentsLlmOverride> {
  try {
    if (opts.projectId) return toAgentsOverride(await resolveProjectLlmConfig(opts.projectId));
  } catch {
    /* projeto sem config válida → tenta pelo tenant abaixo */
  }
  try {
    if (opts.tenantId) {
      const cfg = await getTenantLlmConfig(opts.tenantId);
      if (!cfg.isDefault && typeof cfg.modelId === "string" && cfg.modelId) {
        return toAgentsOverride({
          provider: cfg.provider,
          modelId: cfg.modelId,
          fallbackModelId: cfg.modelIdFallback ?? undefined,
          apiKey: cfg.credentials.api_key ?? "",
          awsRegion: cfg.credentials.aws_region,
          awsAccessKeyId: cfg.credentials.aws_access_key_id,
          awsSecretAccessKey: cfg.credentials.aws_secret_access_key,
          isDefault: false,
          priority: cfg.priority,
        });
      }
    }
  } catch {
    /* default abaixo */
  }
  return { llm_config: {}, isDefault: true };
}

/** Campos a espalhar no corpo enviado aos agents (omite tudo quando é o default do env). */
export function agentsLlmFields(o: AgentsLlmOverride): Record<string, unknown> {
  if (o.isDefault) return {};
  return {
    ...(o.model_id ? { model_id: o.model_id } : {}),
    ...(o.model_id_rework ? { model_id_rework: o.model_id_rework } : {}),
    llm_config: o.llm_config,
  };
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
      createdByRole  = String(proj.rows[0].creator_role ?? "user");
      tenantId       = String(proj.rows[0].tenant_id ?? "");
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

export interface SlotClaim {
  outcome: "started" | "queued";
  /** Status do projeto ANTES do claim — usado por revertSlotClaim se o dispatch falhar. */
  previousStatus: string | null;
}

/**
 * Claim ATÔMICO de slot de concorrência (RFC-0003, fix C2 — elimina o TOCTOU do
 * `enqueueOrStart`, onde N chamadas concorrentes liam a mesma contagem de 'running' e
 * todas decidiam "started", furando o teto).
 *
 * Serializa por tenant via `pg_advisory_xact_lock` e, DENTRO da mesma transação, conta os
 * projetos 'running' e RESERVA o slot marcando o projeto como 'running' (o próprio marcador
 * que a contagem observa) — ou o enfileira ('queued'). Como a reserva acontece sob o lock,
 * dois claimers do mesmo tenant nunca veem a mesma contagem estável duas vezes.
 *
 * Retorna também o status anterior, para reverter (revertSlotClaim) se o dispatch falhar.
 */
export async function claimSlotOrQueue(
  projectId: string,
  tenantId: string
): Promise<SlotClaim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // hashtext(uuid::text) → int4, promovido ao overload bigint de pg_advisory_xact_lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);

    const cur = await client.query("SELECT status FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
    const previousStatus = (cur.rows[0]?.status as string | undefined) ?? null;

    const cfg = await client.query(
      `SELECT max_concurrent_projects FROM tenant_llm_configs
       WHERE tenant_id = $1 AND is_active = TRUE ORDER BY priority ASC LIMIT 1`,
      [tenantId]
    );
    const maxConcurrent = cfg.rows[0]
      ? Number(cfg.rows[0].max_concurrent_projects)
      : SYSTEM_DEFAULT.maxConcurrentProjects;

    const cnt = await client.query(
      `SELECT COUNT(*) AS running_count FROM projects WHERE tenant_id = $1 AND status = 'running'`,
      [tenantId]
    );
    const runningCount = Number(cnt.rows[0]?.running_count ?? 0);

    if (runningCount < maxConcurrent) {
      await client.query(
        `UPDATE projects SET status = 'running', started_at = now(), updated_at = now(), stopped_by = NULL WHERE id = $1`,
        [projectId]
      );
      await client.query("COMMIT");
      return { outcome: "started", previousStatus };
    }

    await client.query(
      `UPDATE projects SET status = 'queued', queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [projectId]
    );
    await client.query("COMMIT");
    return { outcome: "queued", previousStatus };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverte um claim de slot (status 'running' reservado) de volta ao status anterior quando o
 * dispatch subsequente falha — liberando o slot. Só age se o projeto ainda estiver 'running'
 * (não sobrescreve um estado já avançado pelo runner via callback).
 */
export async function revertSlotClaim(projectId: string, previousStatus: string | null): Promise<void> {
  if (!previousStatus) return;
  await pool.query(
    `UPDATE projects SET status = $1, started_at = NULL, updated_at = now()
     WHERE id = $2 AND status = 'running'`,
    [previousStatus, projectId]
  );
}
