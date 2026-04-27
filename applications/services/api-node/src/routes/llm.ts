/**
 * llm.ts — G38: CRUD da configuração de LLM por tenant.
 *
 * GET  /api/tenant/llm-config          — ler config atual
 * PUT  /api/tenant/llm-config          — salvar/atualizar config
 * DELETE /api/tenant/llm-config        — remover (volta ao default do sistema)
 * GET  /api/tenant/llm-config/test     — testar conectividade com o provider
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const ALLOWED_PROVIDERS = ["bedrock", "openai", "anthropic", "azure_openai"] as const;
type Provider = typeof ALLOWED_PROVIDERS[number];

const DEFAULT_MODELS: Record<Provider, string> = {
  bedrock:      "us.anthropic.claude-sonnet-4-6",
  openai:       "gpt-4o",
  anthropic:    "claude-sonnet-4-6",
  azure_openai: "gpt-4o",
};

// Campos de credenciais permitidos por provider (allowlist de segurança)
const CREDENTIAL_FIELDS: Record<Provider, string[]> = {
  bedrock:      ["aws_access_key_id", "aws_secret_access_key", "aws_region"],
  openai:       ["api_key"],
  anthropic:    ["api_key"],
  azure_openai: ["api_key", "endpoint", "deployment_name", "api_version"],
};

function sanitizeCredentials(provider: Provider, raw: Record<string, string>): Record<string, string> {
  const allowed = CREDENTIAL_FIELDS[provider] ?? [];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    if (raw[key]) result[key] = String(raw[key]).trim();
  }
  return result;
}

function maskCredentials(creds: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (typeof v === "string" && v.length > 8) {
      masked[k] = v.slice(0, 4) + "****" + v.slice(-4);
    } else {
      masked[k] = "****";
    }
  }
  return masked;
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // GET /api/tenant/llm-config
  app.get("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas tenants podem configurar LLM" });

    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT provider, model_id, credentials, max_concurrent_projects,
                daily_token_quota, deadpool_token_reserve, is_active
         FROM tenant_llm_configs WHERE tenant_id = $1`,
        [user.tenantId]
      );
      if (res.rows.length === 0) {
        return reply.send({
          configured: false,
          default: {
            provider: process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
            model_id: process.env.CLAUDE_MODEL ?? "us.anthropic.claude-sonnet-4-6",
          },
        });
      }
      const row = res.rows[0] as Record<string, unknown>;
      return reply.send({
        configured: true,
        provider:              row.provider,
        model_id:              row.model_id,
        credentials_masked:    maskCredentials((row.credentials as Record<string, string>) ?? {}),
        max_concurrent_projects: row.max_concurrent_projects,
        daily_token_quota:     row.daily_token_quota,
        deadpool_token_reserve: row.deadpool_token_reserve,
        is_active:             row.is_active,
      });
    } finally { client.release(); }
  });

  // PUT /api/tenant/llm-config
  app.put("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas tenants podem configurar LLM" });
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas admins do tenant podem configurar LLM" });
    }

    const body = request.body as Record<string, unknown>;
    const provider = String(body.provider ?? "bedrock") as Provider;
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido. Permitidos: ${ALLOWED_PROVIDERS.join(", ")}` });
    }

    const credentials = sanitizeCredentials(provider, (body.credentials as Record<string, string>) ?? {});
    const model_id    = String(body.model_id ?? DEFAULT_MODELS[provider]);
    const max_concurrent = Math.min(Math.max(Number(body.max_concurrent_projects ?? 3), 1), 20);
    const daily_quota    = body.daily_token_quota ? Number(body.daily_token_quota) : null;
    const dp_reserve     = Number(body.deadpool_token_reserve ?? 0);

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO tenant_llm_configs
           (tenant_id, provider, model_id, credentials, max_concurrent_projects,
            daily_token_quota, deadpool_token_reserve, is_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           provider=$2, model_id=$3, credentials=$4,
           max_concurrent_projects=$5, daily_token_quota=$6,
           deadpool_token_reserve=$7, is_active=true, updated_at=now()`,
        [user.tenantId, provider, model_id, JSON.stringify(credentials),
         max_concurrent, daily_quota, dp_reserve]
      );
      return reply.send({ ok: true, provider, model_id, max_concurrent_projects: max_concurrent });
    } finally { client.release(); }
  });

  // DELETE /api/tenant/llm-config — remove config, volta ao default do sistema
  app.delete("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Apenas tenants" });
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN" });
    }
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM tenant_llm_configs WHERE tenant_id = $1", [user.tenantId]);
      return reply.send({ ok: true, message: "Config removida. Usando provider padrão do sistema." });
    } finally { client.release(); }
  });
}
