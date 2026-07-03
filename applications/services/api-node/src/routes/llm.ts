/**
 * llm.ts — G38: CRUD da configuração de LLM por tenant com suporte a prioridades.
 *
 * GET  /api/tenant/llm-config                — listar todas as configs (slots 0-3)
 * PUT  /api/tenant/llm-config/:priority      — salvar config por prioridade (0=Padrão, 1-3=Contingência)
 * PUT  /api/tenant/llm-config                — compat: salva em priority=0
 * DELETE /api/tenant/llm-config/:priority    — remover prioridade específica
 * DELETE /api/tenant/llm-config              — remover todas
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

const CREDENTIAL_FIELDS: Record<Provider, string[]> = {
  bedrock:      ["aws_access_key_id", "aws_secret_access_key", "aws_region"],
  openai:       ["api_key"],
  anthropic:    ["api_key"],
  azure_openai: ["api_key", "endpoint", "deployment_name", "api_version"],
};

const PRIORITY_LABELS: Record<number, string> = {
  0: "Padrão",
  1: "Contingência 1",
  2: "Contingência 2",
  3: "Contingência 3",
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

function hasCredentials(provider: string, creds: Record<string, string>): boolean {
  if (provider === "bedrock")    return true;
  if (provider === "openai" || provider === "anthropic") return !!creds.api_key;
  if (provider === "azure_openai") return !!(creds.api_key && creds.endpoint);
  return false;
}

function formatSlot(row: Record<string, unknown>) {
  const creds    = (row.credentials as Record<string, string>) ?? {};
  const provider = String(row.provider ?? "bedrock");
  const priority = Number(row.priority ?? 0);
  return {
    configured:              true,
    priority,
    priority_label:          PRIORITY_LABELS[priority] ?? `Prioridade ${priority}`,
    provider,
    model_id:                row.model_id,
    model_id_fallback:       row.model_id_fallback ?? null,
    cyborg_model_id:         row.cyborg_model_id ?? null,
    cyborg_model_id_fallback: row.cyborg_model_id_fallback ?? null,
    credentials_masked:      maskCredentials(creds),
    has_credentials:         hasCredentials(provider, creds),
    max_concurrent_projects: row.max_concurrent_projects,
    daily_token_quota:       row.daily_token_quota,
    deadpool_token_reserve:  row.deadpool_token_reserve,
    is_active:               row.is_active,
  };
}

async function upsertConfig(
  tenantId: string,
  priority: number,
  body: Record<string, unknown>
) {
  const provider         = String(body.provider ?? "bedrock") as Provider;
  const credentials      = sanitizeCredentials(provider, (body.credentials as Record<string, string>) ?? {});
  const model_id         = String(body.model_id ?? DEFAULT_MODELS[provider]);
  const model_id_fallback = body.model_id_fallback ? String(body.model_id_fallback) : null;
  const cyborg_model_id   = body.cyborg_model_id ? String(body.cyborg_model_id) : null;
  const cyborg_model_id_fallback = body.cyborg_model_id_fallback ? String(body.cyborg_model_id_fallback) : null;
  const max_concurrent   = Math.min(Math.max(Number(body.max_concurrent_projects ?? 3), 1), 20);
  const daily_quota      = body.daily_token_quota ? Number(body.daily_token_quota) : null;
  const dp_reserve       = Number(body.deadpool_token_reserve ?? 0);

  await pool.query(
    `INSERT INTO tenant_llm_configs
       (tenant_id, priority, provider, model_id, model_id_fallback, credentials,
        max_concurrent_projects, daily_token_quota, deadpool_token_reserve,
        cyborg_model_id, cyborg_model_id_fallback,
        is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())
     ON CONFLICT (tenant_id, priority) DO UPDATE SET
       provider=$3, model_id=$4, model_id_fallback=$5, credentials=$6,
       max_concurrent_projects=$7, daily_token_quota=$8,
       deadpool_token_reserve=$9,
       cyborg_model_id=$10, cyborg_model_id_fallback=$11,
       is_active=true, updated_at=now()`,
    [tenantId, priority, provider, model_id, model_id_fallback, JSON.stringify(credentials),
     max_concurrent, daily_quota, dp_reserve,
     cyborg_model_id, cyborg_model_id_fallback]
  );

  return { ok: true, priority, priority_label: PRIORITY_LABELS[priority], provider, model_id,
           model_id_fallback, cyborg_model_id, cyborg_model_id_fallback,
           has_credentials: hasCredentials(provider, credentials) };
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/tenant/llm-config — retorna os 4 slots (preenchidos ou vazios) ──
  app.get("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT provider, model_id, model_id_fallback,
                cyborg_model_id, cyborg_model_id_fallback,
                credentials, max_concurrent_projects,
                daily_token_quota, deadpool_token_reserve, is_active, priority
         FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority ASC`,
        [user.tenantId]
      );

      const byPriority = new Map(
        res.rows.map((row) => [Number((row as Record<string,unknown>).priority ?? 0), formatSlot(row as Record<string,unknown>)])
      );

      const slots = [0, 1, 2, 3].map((p) => byPriority.get(p) ?? {
        configured: false, priority: p, priority_label: PRIORITY_LABELS[p],
        provider: null, model_id: null, credentials_masked: {}, has_credentials: false,
        max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, is_active: false,
      });

      // Cyborg defaults do singleton Zentriz (para exibir "herdado" quando slot não configura)
      let zentrizDefaults: { cyborg_model_id: string | null; cyborg_model_id_fallback: string | null } = {
        cyborg_model_id: null, cyborg_model_id_fallback: null,
      };
      try {
        const zdef = await client.query(
          `SELECT cyborg_model_id, cyborg_model_id_fallback FROM zentriz_llm_config LIMIT 1`
        );
        if (zdef.rows.length > 0) {
          zentrizDefaults = {
            cyborg_model_id: (zdef.rows[0].cyborg_model_id as string | null) ?? null,
            cyborg_model_id_fallback: (zdef.rows[0].cyborg_model_id_fallback as string | null) ?? null,
          };
        }
      } catch { /* migration ainda não aplicada — fallback null */ }

      return reply.send({
        slots,
        system_default: {
          provider: process.env.GENESIS_LLM_PROVIDER ?? "bedrock",
          model_id: process.env.CLAUDE_MODEL ?? "us.anthropic.claude-sonnet-4-6",
          cyborg_model_id: zentrizDefaults.cyborg_model_id ?? "us.anthropic.claude-opus-4-7",
          cyborg_model_id_fallback: zentrizDefaults.cyborg_model_id_fallback ?? "us.anthropic.claude-sonnet-4-6",
        },
      });
    } finally { client.release(); }
  });

  // ── PUT /api/tenant/llm-config/:priority ─────────────────────────────────────
  app.put<{ Params: { priority: string } }>(
    "/api/tenant/llm-config/:priority",
    async (request, reply) => {
      const user = getUser(request);
      if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
        return reply.status(403).send({ code: "FORBIDDEN" });

      const priority = Number(request.params.priority);
      if (![0, 1, 2, 3].includes(priority))
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Priority deve ser 0, 1, 2 ou 3" });

      const provider = String((request.body as Record<string,unknown>).provider ?? "bedrock");
      if (!ALLOWED_PROVIDERS.includes(provider as Provider))
        return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido: ${provider}` });

      const result = await upsertConfig(user.tenantId, priority, request.body as Record<string,unknown>);
      return reply.send(result);
    }
  );

  // ── PUT /api/tenant/llm-config (compat — sem priority → priority=0) ──────────
  app.put("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });

    const provider = String((request.body as Record<string,unknown>).provider ?? "bedrock");
    if (!ALLOWED_PROVIDERS.includes(provider as Provider))
      return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido: ${provider}` });

    const result = await upsertConfig(user.tenantId, 0, request.body as Record<string,unknown>);
    return reply.send(result);
  });

  // ── DELETE /api/tenant/llm-config/:priority ───────────────────────────────────
  app.delete<{ Params: { priority: string } }>(
    "/api/tenant/llm-config/:priority",
    async (request, reply) => {
      const user = getUser(request);
      if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
        return reply.status(403).send({ code: "FORBIDDEN" });

      const priority = Number(request.params.priority);
      await pool.query(
        "DELETE FROM tenant_llm_configs WHERE tenant_id = $1 AND priority = $2",
        [user.tenantId, priority]
      );
      return reply.send({ ok: true, message: `${PRIORITY_LABELS[priority] ?? `Prioridade ${priority}`} removida.` });
    }
  );

  // ── DELETE /api/tenant/llm-config — remove todas ─────────────────────────────
  app.delete("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });

    await pool.query("DELETE FROM tenant_llm_configs WHERE tenant_id = $1", [user.tenantId]);
    return reply.send({ ok: true, message: "Todas as configs removidas. Usando provider padrão." });
  });
}
