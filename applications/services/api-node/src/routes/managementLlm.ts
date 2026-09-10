/**
 * managementLlm.ts — CRUD dos slots de LLM da **CONTA DE GESTÃO** (`zentriz_admin`).
 *
 * ⚖️ Jean, 2026-09-10: *"é na conta de gerenciamento que deve ter uma config de LLM para os
 * agentes internos, que serão custeados pela Zentriz, não pelos tenants"*.
 *
 * O payload é DELIBERADAMENTE o mesmo de `/api/tenant/llm-config` (mesmos nomes de campo, mesmo
 * shape de `verify`, mesmo catálogo dinâmico de modelos) — é isso que permite a tela do tenant e a
 * tela da gestão usarem o MESMO componente de editor de slot. Duas telas com dois payloads
 * parecidos mas diferentes é como nascem os defeitos de "a tela diz verde e o runtime diz não".
 *
 * Diferenças de fundo em relação ao tenant, e por quê:
 *  · não há `tenantId` — a conta de gestão não é um tenant (nem existe linha em `tenants` para ela);
 *  · não há `byoc_exempt` — a Zentriz é a própria pagadora, mas ainda assim o slot só é utilizável
 *    com credencial PRÓPRIA gravada, nunca com o `.env` do container (é a LEI dos slots);
 *  · não há `max_concurrent_projects`/quota — estes slots não rodam fábrica, só trabalho interno.
 *
 * GET    /api/management/llm-config
 * PUT    /api/management/llm-config/:priority
 * POST   /api/management/llm-config/:priority/test
 * POST   /api/management/llm-config/models
 * POST   /api/management/llm-config/reorder
 * DELETE /api/management/llm-config/:priority
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { hasOwnCredentials } from "../services/tenantLlmConfig.js";
import { getPlatformSlots, platformSlotUsable, type PlatformLlmSlot } from "../services/platformLlmConfig.js";
import { probeSlot, listModels, type ProbeResult } from "../services/llmSlotProbe.js";

const ALLOWED_PROVIDERS = ["bedrock", "foundry", "google", "openai", "anthropic", "azure_openai"] as const;
type Provider = typeof ALLOWED_PROVIDERS[number];

const CREDENTIAL_FIELDS: Record<Provider, string[]> = {
  bedrock:      ["aws_access_key_id", "aws_secret_access_key", "aws_region"],
  foundry:      ["foundry_api_key", "foundry_resource", "foundry_base_url"],
  google:       ["google_api_key", "google_base_url",
                 "vertex_project_id", "vertex_location", "vertex_service_account_json"],
  openai:       ["api_key"],
  anthropic:    ["api_key"],
  azure_openai: ["api_key", "endpoint", "deployment_name", "api_version"],
};

const PRIORITY_LABELS: Record<number, string> = {
  0: "Padrão", 1: "Contingência 1", 2: "Contingência 2", 3: "Contingência 3",
};

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/**
 * Só a conta de gestão entra aqui. Não é escopo de tenant: `tenant_admin` de um cliente não pode
 * nem LER esta config — ela contém a credencial que a Zentriz paga.
 */
function requireManagement(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user?.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN", message: "Somente a conta de gestão da Zentriz." });
    return false;
  }
  return true;
}

function sanitizeCredentials(provider: Provider, raw: Record<string, string>): Record<string, string> {
  const allowed = CREDENTIAL_FIELDS[provider] ?? [];
  const out: Record<string, string> = {};
  for (const key of allowed) if (raw?.[key]) out[key] = String(raw[key]).trim();
  return out;
}

function maskCredentials(creds: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    masked[k] = typeof v === "string" && v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : "****";
  }
  return masked;
}

function formatSlot(slot: PlatformLlmSlot) {
  const usable = platformSlotUsable(slot);
  return {
    configured:         true,
    priority:           slot.priority,
    priority_label:     PRIORITY_LABELS[slot.priority] ?? `Prioridade ${slot.priority}`,
    provider:           slot.provider,
    model_id:           slot.modelId,
    model_id_fallback:  slot.modelIdFallback,
    label:              slot.label,
    credentials_masked: maskCredentials(slot.credentials),
    usable,
    // Na conta de gestão quem paga é a Zentriz — mas o slot só vale com credencial própria
    // gravada. `uses_zentriz_account` é sempre true aqui, e a tela DIZ isso ao operador.
    own_credentials:      hasOwnCredentials(slot.provider, slot.credentials),
    uses_zentriz_account: true,
    has_credentials:      usable,
    is_active:            slot.isActive,
    verified_at:          slot.verifiedAt,
    verify_status:        slot.verifyStatus,
    verify_error:         slot.verifyError,
    verify_model:         slot.verifyModel,
    verify_latency_ms:    slot.verifyLatencyMs,
  };
}

function verifyPayload(v: ProbeResult) {
  return { ok: v.ok, status: v.ok ? "ok" : (v.kind || "other"),
           message: v.message, model: v.model, latency_ms: v.latencyMs };
}

/** Grava o veredicto do último probe. Perder o registro não pode derrubar o salvamento. */
async function recordPlatformProbe(priority: number, r: ProbeResult): Promise<void> {
  if (r.kind === "unavailable") return;
  try {
    await pool.query(
      `UPDATE zentriz_llm_config
          SET verified_at = now(), verify_status = $2, verify_error = $3,
              verify_model = $4, verify_latency_ms = $5
        WHERE priority = $1`,
      [priority, r.ok ? "ok" : (r.kind || "other"), r.ok ? null : r.message.slice(0, 800),
       r.model, Math.round(r.latencyMs)],
    );
  } catch { /* migration 126 ainda não aplicada neste ambiente */ }
}

function parsePriority(raw: string): number | null {
  const p = Number(raw);
  return Number.isInteger(p) && p >= 0 && p <= 3 ? p : null;
}

export async function managementLlmRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  app.get("/api/management/llm-config", async (request, reply) => {
    if (!requireManagement(request, reply)) return;
    const slots = await getPlatformSlots();
    const porPrioridade = new Map(slots.map((s) => [s.priority, s]));
    // Os 4 lugares SEMPRE aparecem — inclusive vazios. A tela precisa mostrar onde cadastrar a
    // contingência, e não só o que já existe.
    const payload = [0, 1, 2, 3].map((p) => {
      const slot = porPrioridade.get(p);
      return slot
        ? formatSlot(slot)
        : { configured: false, priority: p, priority_label: PRIORITY_LABELS[p],
            provider: null, model_id: null, model_id_fallback: null, label: null,
            credentials_masked: {}, usable: false, own_credentials: false,
            uses_zentriz_account: true, has_credentials: false, is_active: false,
            verified_at: null, verify_status: null, verify_error: null,
            verify_model: null, verify_latency_ms: null };
    });
    return reply.send({
      slots: payload,
      has_usable_slot: payload.some((s) => s.usable),
      /** A frase que a tela exibe: aqui a fatura é NOSSA, e isso tem de estar escrito. */
      payer: "Zentriz (conta de gestão)",
    });
  });

  app.put<{ Params: { priority: string } }>(
    "/api/management/llm-config/:priority", async (request, reply) => {
      if (!requireManagement(request, reply)) return;
      const priority = parsePriority(request.params.priority);
      if (priority === null) return reply.status(400).send({ code: "BAD_REQUEST", message: "priority deve ser 0..3" });

      const body = (request.body as Record<string, unknown>) ?? {};
      const providerRaw = String(body.provider ?? "").trim();
      const modelId = String(body.model_id ?? "").trim();
      // ⚖️ LEI: sem provider e modelo DECLARADOS a escrita falha. Nada de default de plataforma —
      // nem aqui, onde a plataforma é a pagadora: um modelo que ninguém escolheu é gasto cego.
      if (!providerRaw || !modelId) {
        return reply.status(400).send({
          code: "BAD_REQUEST",
          message: "provider e model_id são obrigatórios — não há modelo padrão da plataforma.",
        });
      }
      if (!ALLOWED_PROVIDERS.includes(providerRaw as Provider)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido: ${providerRaw}` });
      }
      const provider = providerRaw as Provider;

      // Mesma proteção do tenant: a tela reenvia o formulário com a credencial MASCARADA, e um
      // upsert ingênuo apagaria a chave real ao trocar só o modelo (defeito medido em 2026-09-04).
      const incoming = sanitizeCredentials(provider, (body.credentials as Record<string, string>) ?? {});
      let credentials = incoming;
      try {
        const prev = await pool.query(
          "SELECT provider, credentials FROM zentriz_llm_config WHERE priority = $1", [priority]);
        const row = prev.rows[0] as { provider?: string; credentials?: Record<string, string> } | undefined;
        if (row && String(row.provider ?? "") === provider) {
          const merged = { ...(row.credentials ?? {}) };
          for (const [k, v] of Object.entries(incoming)) if (v && !v.includes("****")) merged[k] = v;
          credentials = sanitizeCredentials(provider, merged);
        }
      } catch { /* sem linha anterior */ }

      const fallback = body.model_id_fallback ? String(body.model_id_fallback) : null;
      const label = body.label ? String(body.label).slice(0, 120) : null;

      await pool.query(
        `INSERT INTO zentriz_llm_config
           (priority, provider, model_id, model_id_fallback, label, credentials, is_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,now())
         ON CONFLICT (priority) DO UPDATE SET
           provider=$2, model_id=$3, model_id_fallback=$4, label=$5, credentials=$6,
           is_active=true, updated_at=now()`,
        [priority, provider, modelId, fallback, label, JSON.stringify(credentials)],
      );

      // Testa DEPOIS de gravar, como no tenant: reprovar não pode impedir cadastrar (a cota pode
      // abrir amanhã). O veredicto é informação; quem recusa em runtime é a cascata.
      const verify = await probeSlot(provider, modelId, credentials, 30_000);
      await recordPlatformProbe(priority, verify);

      return reply.send({
        ok: true, priority, priority_label: PRIORITY_LABELS[priority],
        provider, model_id: modelId, model_id_fallback: fallback, label,
        own_credentials: hasOwnCredentials(provider, credentials),
        has_credentials: hasOwnCredentials(provider, credentials),
        verify: verifyPayload(verify),
      });
    });

  app.post<{ Params: { priority: string } }>(
    "/api/management/llm-config/:priority/test", async (request, reply) => {
      if (!requireManagement(request, reply)) return;
      const priority = parsePriority(request.params.priority);
      if (priority === null) return reply.status(400).send({ code: "BAD_REQUEST", message: "priority deve ser 0..3" });
      const slots = await getPlatformSlots();
      const slot = slots.find((s) => s.priority === priority);
      if (!slot) return reply.status(404).send({ code: "NOT_FOUND", message: "slot não configurado" });
      const verify = await probeSlot(slot.provider, slot.modelId, slot.credentials, 30_000);
      await recordPlatformProbe(priority, verify);
      return reply.send({ ok: verify.ok, priority, verify: verifyPayload(verify) });
    });

  /**
   * Catálogo dinâmico de modelos — a MESMA rota do tenant, com a credencial da gestão. Listar não
   * é poder usar: o que volta como `ok` passou por invocação real (`list_models_verified`).
   */
  app.post("/api/management/llm-config/models", async (request, reply) => {
    if (!requireManagement(request, reply)) return;
    const body = (request.body as { provider?: string; priority?: number;
                                    credentials?: Record<string, string>; refresh?: boolean }) ?? {};
    const providerRaw = String(body.provider ?? "").trim();
    if (!ALLOWED_PROVIDERS.includes(providerRaw as Provider)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `Provider inválido: ${providerRaw}` });
    }
    const provider = providerRaw as Provider;
    let credentials = sanitizeCredentials(provider, body.credentials ?? {});
    // A tela abre com os campos vazios por desenho — sem nada digitado, lista com a GRAVADA.
    if (Object.keys(credentials).length === 0 && typeof body.priority === "number") {
      const slots = await getPlatformSlots();
      const slot = slots.find((s) => s.priority === body.priority);
      if (slot) credentials = sanitizeCredentials(provider, slot.credentials);
    }
    const catalogo = await listModels(provider, credentials, !!body.refresh);
    if (!catalogo) return reply.send({ ok: false, unavailable: true, provider });
    return reply.send({ ok: true, ...catalogo });
  });

  app.post("/api/management/llm-config/reorder", async (request, reply) => {
    if (!requireManagement(request, reply)) return;
    const body = (request.body as { order?: number[] }) ?? {};
    const ordem = Array.isArray(body.order) ? body.order.map(Number) : [];
    if (ordem.length === 0 || ordem.some((p) => !Number.isInteger(p) || p < 0 || p > 3)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "order deve ser uma lista de prioridades 0..3" });
    }
    const atuais = await getPlatformSlots();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // ⚠️ NADA de estacionar em prioridade negativa para driblar o UNIQUE: a migration 126 tem
      // `CHECK (priority BETWEEN 0 AND 3)` e o degrau fora da faixa aborta a transação inteira —
      // calada, como já aconteceu antes com o mesmo truque nos slots de tenant. Aqui a troca é
      // apagar e reinserir dentro da transação: o UNIQUE só é avaliado no fim de cada statement,
      // e a faixa nunca é violada.
      await client.query("DELETE FROM zentriz_llm_config");
      for (let i = 0; i < ordem.length; i++) {
        const slot = atuais.find((s) => s.priority === ordem[i]);
        if (!slot) continue;
        await client.query(
          `INSERT INTO zentriz_llm_config
             (id, priority, provider, model_id, model_id_fallback, label, credentials, is_active,
              verified_at, verify_status, verify_error, verify_model, verify_latency_ms, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())`,
          [slot.id, i, slot.provider, slot.modelId, slot.modelIdFallback, slot.label,
           JSON.stringify(slot.credentials), slot.isActive, slot.verifiedAt, slot.verifyStatus,
           slot.verifyError, slot.verifyModel, slot.verifyLatencyMs],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      return reply.status(500).send({ code: "REORDER_FAILED", message: String((e as Error).message) });
    } finally {
      client.release();
    }
    return reply.send({ ok: true, order: ordem });
  });

  app.delete<{ Params: { priority: string } }>(
    "/api/management/llm-config/:priority", async (request, reply) => {
      if (!requireManagement(request, reply)) return;
      const priority = parsePriority(request.params.priority);
      if (priority === null) return reply.status(400).send({ code: "BAD_REQUEST", message: "priority deve ser 0..3" });
      await pool.query("DELETE FROM zentriz_llm_config WHERE priority = $1", [priority]);
      return reply.send({ ok: true, priority });
    });
}
