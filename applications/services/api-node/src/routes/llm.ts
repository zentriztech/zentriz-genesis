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
import { resolveScopedTenantId } from "../lib/tenantScope.js";
import { slotUsability, hasOwnCredentials } from "../services/tenantLlmConfig.js";
import { modelFamilyOf } from "../services/reviewerModel.js";
import { probeSlot, recordProbe, listModels, type ProbeResult } from "../services/llmSlotProbe.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

// `foundry` = Claude servido pelo Azure AI Foundry (SDK anthropic nativo apontando para
// <resource>.cognitiveservices.azure.com/anthropic). NÃO é `azure_openai`, que só serve GPT.
// `google` = Gemini, consumido pelo endpoint OpenAI-compatível do Google. É o único slot de
// família NÃO-Claude — é o que torna possível um revisor cross-family (a pesquisa mede ZERO
// ganho em auto-revisão da mesma família). Não confundir com `azure_openai`, que só serve GPT.
const ALLOWED_PROVIDERS = ["bedrock", "foundry", "google", "openai", "anthropic", "azure_openai"] as const;
type Provider = typeof ALLOWED_PROVIDERS[number];

/**
 * ⚖️ LEI 2026-09-10 — aqui havia `DEFAULT_MODELS` (um modelo por provider, escolhido por nós).
 * Salvar um slot sem `model_id` gravava `us.anthropic.claude-sonnet-4-6` / `claude-opus-5` /
 * `gemini-2.5-pro` — e daí em diante o run rodava num modelo que o tenant NUNCA escolheu, na
 * fatura dele. O eixo aqui não é a credencial (essa é do slot), é o CUSTO: entre haiku-class e
 * opus-class há uma ordem de grandeza. Sem modelo declarado a escrita FALHA — não adivinha.
 * Mesma razão para `provider`: o `?? "bedrock"` decidia a nuvem do cliente por omissão.
 */
function requireProviderAndModel(body: Record<string, unknown>):
  { ok: true; provider: Provider; model_id: string } | { ok: false; message: string } {
  const provider = String(body.provider ?? "").trim();
  const model_id = String(body.model_id ?? "").trim();
  if (!provider || !model_id) {
    return { ok: false, message: "provider e model_id são obrigatórios — o slot define o modelo do tenant, não há padrão da plataforma." };
  }
  if (!ALLOWED_PROVIDERS.includes(provider as Provider)) {
    return { ok: false, message: `Provider inválido: ${provider}` };
  }
  return { ok: true, provider: provider as Provider, model_id };
}

const CREDENTIAL_FIELDS: Record<Provider, string[]> = {
  bedrock:      ["aws_access_key_id", "aws_secret_access_key", "aws_region"],
  // `foundry_base_url` sobrepõe `foundry_resource` (mesma precedência de `_build_foundry_client`).
  foundry:      ["foundry_api_key", "foundry_resource", "foundry_base_url"],
  // `google_base_url` permite apontar para o endpoint OpenAI-compatível do Vertex em vez do
  // da Gemini API (mesma precedência: se vier, sobrepõe a base padrão).
  // Dois modos: chave da Gemini API (simples, sem GCP) OU service account do Vertex — este
  // cobre as famílias que o crédito do Google subsidia no Model Garden (Claude/Llama/Mistral).
  google:       ["google_api_key", "google_base_url",
                 "vertex_project_id", "vertex_location", "vertex_service_account_json"],
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

/**
 * ⚖️ LEI 2026-09-10 — a tela usa a MESMA regra da resolução (`slotUsability`), e não uma cópia.
 * A cópia anterior é que produzia o defeito: aqui `bedrock` devolvia `true` incondicional e
 * `foundry`/`google` contavam a chave do CONTAINER, então o portal certificava "✅ Credenciais
 * configuradas" sobre slots sem credencial nenhuma — enquanto a conta debitada era a da Zentriz.
 *
 * Três campos, porque são três perguntas diferentes:
 *  · `usable`              — o slot roda? (é isso que decide se ele aparece na cascata)
 *  · `own_credentials`     — a fatura é do TENANT?
 *  · `uses_zentriz_account`— está rodando na nossa conta? (só possível com `byoc_exempt`)
 */
function formatSlot(row: Record<string, unknown>, byocExempt: boolean) {
  const creds    = (row.credentials as Record<string, string>) ?? {};
  const provider = String(row.provider ?? "");
  const priority = Number(row.priority ?? 0);
  const u        = slotUsability(provider, creds, byocExempt);
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
    usable:                  u.usable,
    own_credentials:         u.ownCredentials,
    uses_zentriz_account:    u.usesZentrizAccount,
    /** Compat de payload: "este slot tem credencial que serve", NÃO "é do tenant". */
    has_credentials:         u.usable,
    max_concurrent_projects: row.max_concurrent_projects,
    daily_token_quota:       row.daily_token_quota,
    deadpool_token_reserve:  row.deadpool_token_reserve,
    is_active:               row.is_active,
    /**
     * ⚖️ Jean, 2026-09-10: *"o ideal é testar no momento que é adicionado"* (migration 125).
     * `usable` responde "os campos estão lá"; `verify_status` responde "a chamada foi aceita" —
     * são perguntas diferentes e a tela precisa das duas. `null` = nunca testado (slot antigo),
     * que é diferente de reprovado.
     */
    verified_at:             row.verified_at ?? null,
    verify_status:           row.verify_status ?? null,
    verify_error:            row.verify_error ?? null,
    verify_model:            row.verify_model ?? null,
    verify_latency_ms:       row.verify_latency_ms ?? null,
  };
}

/** Forma única do veredicto na resposta HTTP (mesma no salvar e no re-testar). */
function verifyPayload(v: ProbeResult) {
  return { ok: v.ok, status: v.ok ? "ok" : (v.kind || "other"),
           message: v.message, model: v.model, latency_ms: v.latencyMs };
}

/** `tenants.byoc_exempt` — escrito só por zentriz_admin; um tenant não se auto-isenta. */
async function isByocExempt(tenantId: string): Promise<boolean> {
  const res = await pool.query("SELECT byoc_exempt FROM tenants WHERE id = $1", [tenantId]);
  return !!res.rows[0]?.byoc_exempt;
}

async function upsertConfig(
  tenantId: string,
  priority: number,
  body: Record<string, unknown>,
  /** Já validados pela rota (`requireProviderAndModel`) — nunca inferidos aqui. */
  provider: Provider,
  model_id: string,
) {
  const incoming         = sanitizeCredentials(provider, (body.credentials as Record<string, string>) ?? {});
  // BUG (achado 2026-09-04 19:47Z em prod): o portal reenvia o formulário SEM as credenciais (só
  // mostra a versão mascarada) → o UPSERT gravava `credentials={}` e APAGAVA as chaves AWS do tenant
  // ao trocar só o modelo. Agora: chave ausente ou mascarada ("****") PRESERVA o valor já gravado;
  // valor novo substitui; troca de provider zera (credenciais de outro provider não fazem sentido).
  let credentials: Record<string, string> = incoming;
  try {
    const prev = await pool.query(
      "SELECT provider, credentials FROM tenant_llm_configs WHERE tenant_id = $1 AND priority = $2",
      [tenantId, priority],
    );
    const row = prev.rows[0] as { provider?: string; credentials?: Record<string, string> } | undefined;
    if (row && String(row.provider ?? "bedrock") === provider) {
      const merged: Record<string, string> = { ...(row.credentials ?? {}) };
      for (const [k, v] of Object.entries(incoming)) {
        if (v && !v.includes("****")) merged[k] = v;
      }
      credentials = sanitizeCredentials(provider, merged);
    }
  } catch { /* sem linha anterior → usa o que veio */ }
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

  // ⚖️ Jean, 2026-09-10: *"o ideal é testar no momento que é adicionado"*.
  // O teste vem DEPOIS da escrita, de propósito: reprovar não pode impedir o tenant de salvar
  // (ele pode estar cadastrando um slot cuja cota só abre amanhã, ou com os agents reiniciando).
  // O veredicto é informação — a cascata em runtime é quem decide não usar um slot que falha.
  const verify = await probeSlot(provider, model_id, credentials, 30_000);
  await recordProbe(tenantId, priority, verify);

  const own = hasOwnCredentials(provider, credentials);
  return { ok: true, priority, priority_label: PRIORITY_LABELS[priority], provider, model_id,
           model_id_fallback, cyborg_model_id, cyborg_model_id_fallback,
           own_credentials: own, has_credentials: own,
           verify: verifyPayload(verify) };
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/tenant/llm-config — retorna os 4 slots (preenchidos ou vazios) ──
  app.get("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    // O master (zentriz_admin) escopa via ?tenantId= (seletor do portal); demais usam o próprio JWT.
    const scopedTenantId = resolveScopedTenantId(user, request.query);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT provider, model_id, model_id_fallback,
                cyborg_model_id, cyborg_model_id_fallback,
                credentials, max_concurrent_projects,
                daily_token_quota, deadpool_token_reserve, is_active, priority,
                verified_at, verify_status, verify_error, verify_model, verify_latency_ms
         FROM tenant_llm_configs WHERE tenant_id = $1 ORDER BY priority ASC`,
        [scopedTenantId]
      );

      const byocExempt = await isByocExempt(scopedTenantId);
      const byPriority = new Map(
        res.rows.map((row) => [
          Number((row as Record<string,unknown>).priority ?? 0),
          formatSlot(row as Record<string,unknown>, byocExempt),
        ])
      );

      const slots = [0, 1, 2, 3].map((p) => byPriority.get(p) ?? {
        configured: false, priority: p, priority_label: PRIORITY_LABELS[p],
        provider: null, model_id: null, credentials_masked: {},
        usable: false, own_credentials: false, uses_zentriz_account: false, has_credentials: false,
        max_concurrent_projects: 3, daily_token_quota: null, deadpool_token_reserve: 0, is_active: false,
        verified_at: null, verify_status: null, verify_error: null,
        verify_model: null, verify_latency_ms: null,
      });

      // Quantas FAMÍLIAS distintas os slots utilizáveis cobrem. É o número que sustenta a
      // recomendação do Jean ("pelo menos 2 slots de famílias diferentes"): com uma só família não
      // existe revisor cross-family, e auto-revisão mede ZERO ganho (arXiv:2609.04270).
      const familias = [...new Set(
        slots.filter((s) => s.usable && s.model_id).map((s) => modelFamilyOf(String(s.model_id)))
      )];

      // Cyborg defaults do singleton Zentriz (para exibir "herdado" quando slot não configura)
      let zentrizDefaults: { cyborg_model_id: string | null; cyborg_model_id_fallback: string | null } = {
        cyborg_model_id: null, cyborg_model_id_fallback: null,
      };
      try {
        // ⚠️ 2026-09-10: `LIMIT 1` sem `ORDER BY` devolvia linha ARBITRÁRIA a partir do momento em
        // que a migration 126 permitiu a 2ª linha (fila 0..3 da conta de gestão). O default herdado
        // é o do slot PRINCIPAL, sempre.
        const zdef = await client.query(
          `SELECT cyborg_model_id, cyborg_model_id_fallback FROM zentriz_llm_config
           ORDER BY priority ASC LIMIT 1`
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
        // ⚖️ LEI 2026-09-10: `system_default` NÃO expõe mais `GENESIS_LLM_PROVIDER`/`CLAUDE_MODEL`.
        // A tela exibia o env como "padrão do sistema", ensinando o operador que existia um LLM de
        // reserva — e existia mesmo, na conta da Zentriz. Sem slot utilizável não há padrão nenhum.
        system_default: {
          provider: null,
          model_id: null,
          cyborg_model_id: zentrizDefaults.cyborg_model_id,
          cyborg_model_id_fallback: zentrizDefaults.cyborg_model_id_fallback,
        },
        byoc_exempt: byocExempt,
        families: familias,
        /** Sem nenhum slot utilizável o tenant não roda NADA — a tela precisa dizer isso. */
        has_usable_slot: slots.some((s) => s.usable),
        cross_family_available: familias.length >= 2,
      });
    } finally { client.release(); }
  });

  // ── PUT /api/tenant/llm-config/:priority ─────────────────────────────────────
  app.put<{ Params: { priority: string } }>(
    "/api/tenant/llm-config/:priority",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
        return reply.status(403).send({ code: "FORBIDDEN" });
      const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
      if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

      const priority = Number(request.params.priority);
      if (![0, 1, 2, 3].includes(priority))
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Priority deve ser 0, 1, 2 ou 3" });

      const body = request.body as Record<string,unknown>;
      const decl = requireProviderAndModel(body);
      if (!decl.ok) return reply.status(400).send({ code: "BAD_REQUEST", message: decl.message });

      const result = await upsertConfig(scopedTenantId, priority, body, decl.provider, decl.model_id);
      return reply.send(result);
    }
  );

  // ── PUT /api/tenant/llm-config (compat — sem priority → priority=0) ──────────
  app.put("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });
    const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    const body = request.body as Record<string,unknown>;
    const decl = requireProviderAndModel(body);
    if (!decl.ok) return reply.status(400).send({ code: "BAD_REQUEST", message: decl.message });

    const result = await upsertConfig(scopedTenantId, 0, body, decl.provider, decl.model_id);
    return reply.send(result);
  });

  // ── POST /api/tenant/llm-config/reorder — permutar prioridades preservando a linha ───────────
  //
  // 🔴 DEFEITO FECHADO AQUI (2026-09-10): reordenar e remover slot no portal era "DELETE tudo +
  // re-PUT de cada um com `credentials: {}`". Como o DELETE vem ANTES, a preservação de credencial
  // do upsert (que lê a linha anterior) não achava nada — e o reorder APAGAVA as chaves de todos os
  // slots, deixando o tenant com slots que não rodam. É uma explicação direta para slots
  // encontrados em prod com `credentials` vazio.
  //
  // Aqui a permutação acontece em UMA transação, movendo a linha INTEIRA (credencial, limites e o
  // veredicto do último teste). Reordenar é mudar a ordem de preferência — não é reconfigurar.
  app.post("/api/tenant/llm-config/reorder", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });
    const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    // `order[i]` = prioridade ATUAL do slot que passa a ocupar a posição `i`.
    const order = (request.body as { order?: unknown })?.order;
    if (!Array.isArray(order) || order.length === 0 || order.length > 4)
      return reply.status(400).send({ code: "BAD_REQUEST", message: "order deve ser uma lista de 1 a 4 prioridades." });
    const atuais = order.map(Number);
    if (atuais.some((p) => !Number.isInteger(p) || p < 0 || p > 3) || new Set(atuais).size !== atuais.length)
      return reply.status(400).send({ code: "BAD_REQUEST", message: "order deve conter prioridades 0-3 distintas." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        "SELECT * FROM tenant_llm_configs WHERE tenant_id = $1 FOR UPDATE", [scopedTenantId]);
      const porPrioridade = new Map<number, Record<string, unknown>>(
        res.rows.map((r) => [Number((r as Record<string, unknown>).priority), r as Record<string, unknown>]));
      if (atuais.some((p) => !porPrioridade.has(p))) {
        await client.query("ROLLBACK");
        return reply.status(400).send({ code: "BAD_REQUEST", message: "order cita uma prioridade que não existe." });
      }
      // Apagar e reinserir dentro da MESMA transação: nenhum instante em que o tenant fica sem
      // slot (a resolução de LLM que rodar concorrente enxerga o estado antigo ou o novo, nunca o vazio).
      await client.query("DELETE FROM tenant_llm_configs WHERE tenant_id = $1", [scopedTenantId]);
      for (let i = 0; i < atuais.length; i++) {
        const r = porPrioridade.get(atuais[i])!;
        await client.query(
          `INSERT INTO tenant_llm_configs
             (tenant_id, priority, provider, model_id, model_id_fallback, credentials,
              max_concurrent_projects, daily_token_quota, deadpool_token_reserve,
              cyborg_model_id, cyborg_model_id_fallback, is_active, updated_at,
              verified_at, verify_status, verify_error, verify_model, verify_latency_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16,$17)`,
          [scopedTenantId, i, r.provider, r.model_id, r.model_id_fallback,
           JSON.stringify(r.credentials ?? {}), r.max_concurrent_projects, r.daily_token_quota,
           r.deadpool_token_reserve, r.cyborg_model_id, r.cyborg_model_id_fallback, r.is_active,
           r.verified_at ?? null, r.verify_status ?? null, r.verify_error ?? null,
           r.verify_model ?? null, r.verify_latency_ms ?? null],
        );
      }
      await client.query("COMMIT");
      return reply.send({ ok: true, order: atuais });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      request.log.error({ err }, "[llm-config] falha ao reordenar slots");
      return reply.status(500).send({ code: "INTERNAL", message: "Não foi possível reordenar os slots." });
    } finally { client.release(); }
  });

  // ── POST /api/tenant/llm-config/:priority/test — re-testar um slot já salvo ───
  // Um slot aprovado ontem pode estar reprovado hoje (chave rotacionada, cota estourada,
  // entitlement revogado). Sem este botão a única forma de descobrir seria queimar um run.
  app.post<{ Params: { priority: string } }>(
    "/api/tenant/llm-config/:priority/test",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
        return reply.status(403).send({ code: "FORBIDDEN" });
      const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
      if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

      const priority = Number(request.params.priority);
      if (![0, 1, 2, 3].includes(priority))
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Priority deve ser 0, 1, 2 ou 3" });

      const res = await pool.query(
        "SELECT provider, model_id, credentials FROM tenant_llm_configs WHERE tenant_id = $1 AND priority = $2",
        [scopedTenantId, priority],
      );
      const row = res.rows[0] as
        { provider?: string; model_id?: string; credentials?: Record<string, string> } | undefined;
      if (!row || !row.provider || !row.model_id)
        return reply.status(404).send({ code: "NOT_FOUND", message: "Slot não configurado." });

      // O teste usa a credencial GRAVADA, nunca a mascarada da tela: mascarada testaria uma chave
      // que não existe e reprovaria um slot bom.
      const verify = await probeSlot(row.provider, row.model_id, row.credentials ?? {}, 45_000);
      await recordProbe(scopedTenantId, priority, verify);
      return reply.send({ ok: true, priority, priority_label: PRIORITY_LABELS[priority],
                          provider: row.provider, model_id: row.model_id,
                          verify: verifyPayload(verify) });
    }
  );

  // ── POST /api/tenant/llm-config/models ────────────────────────────────────────
  // ⚖️ Jean, 2026-09-10: a lista dos selects vem do PROVIDER, com as credenciais informadas —
  // não de uma constante no front. A lista estática oferecia `us.anthropic.claude-opus-5` no
  // Bedrock, id que a conta responde com 403; o slot nascia morto e ninguém via até a run falhar.
  app.post("/api/tenant/llm-config/models", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });
    const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    const body = (request.body ?? {}) as {
      provider?: string; credentials?: Record<string, string>;
      priority?: number; refresh?: boolean;
    };
    const providerRaw = String(body.provider ?? "").trim();
    if (!ALLOWED_PROVIDERS.includes(providerRaw as Provider))
      return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido: ${providerRaw}` });
    const provider = providerRaw as Provider;

    // Credencial: a digitada agora tem precedência (o operador pode estar TROCANDO a chave e
    // quer ver a lista dela). Sem ela, cai na gravada — a tela abre com os campos vazios por
    // desenho (`setCreds({})`), e exigir redigitar a chave só para listar seria hostil.
    let credentials = sanitizeCredentials(provider, body.credentials ?? {});
    if (Object.keys(credentials).length === 0 && [0, 1, 2, 3].includes(Number(body.priority))) {
      const res = await pool.query(
        "SELECT credentials FROM tenant_llm_configs WHERE tenant_id = $1 AND priority = $2 AND provider = $3",
        [scopedTenantId, Number(body.priority), provider],
      );
      credentials = (res.rows[0]?.credentials as Record<string, string>) ?? {};
    }

    const catalog = await listModels(provider, credentials, Boolean(body.refresh));
    if (!catalog) {
      // Agents fora do ar não pode virar tela quebrada: o front mantém a lista que já tinha.
      return reply.send({ ok: false, unavailable: true, provider,
                          message: "não foi possível consultar os modelos agora" });
    }
    return reply.send({ ok: true, ...catalog });
  });

  // ── DELETE /api/tenant/llm-config/:priority ───────────────────────────────────
  app.delete<{ Params: { priority: string } }>(
    "/api/tenant/llm-config/:priority",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
        return reply.status(403).send({ code: "FORBIDDEN" });
      const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
      if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

      const priority = Number(request.params.priority);
      await pool.query(
        "DELETE FROM tenant_llm_configs WHERE tenant_id = $1 AND priority = $2",
        [scopedTenantId, priority]
      );
      return reply.send({ ok: true, message: `${PRIORITY_LABELS[priority] ?? `Prioridade ${priority}`} removida.` });
    }
  );

  // ── DELETE /api/tenant/llm-config — remove todas ─────────────────────────────
  app.delete("/api/tenant/llm-config", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin")
      return reply.status(403).send({ code: "FORBIDDEN" });
    const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN" });

    await pool.query("DELETE FROM tenant_llm_configs WHERE tenant_id = $1", [scopedTenantId]);
    return reply.send({ ok: true, message: "Todas as configs removidas. Usando provider padrão." });
  });
}
