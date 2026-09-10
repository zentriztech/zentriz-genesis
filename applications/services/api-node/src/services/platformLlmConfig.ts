/**
 * platformLlmConfig.ts — LLM da **CONTA DE GESTÃO** (`zentriz_admin`).
 *
 * ⚖️ Jean, 2026-09-10: *"quando eu falo na conta da Zentriz é a conta de GERENCIAMENTO, não o
 * tenant ZFactory; é na conta de gerenciamento que deve ter uma config de LLM para os agentes
 * internos, que serão custeados pela Zentriz, não pelos tenants"*.
 *
 * Como isto convive com a LEI dos slots (que proíbe LLM fora do slot do tenant): a LEI existe para
 * que **quem paga seja quem pediu o trabalho**. O que ela proíbe é o *default silencioso* — o
 * `.env` que fazia trabalho de tenant cair na fatura da Zentriz. Trabalho INTERNO da plataforma
 * (operar, diagnosticar, responder pergunta de gestão) é pedido pela Zentriz, logo é pago pela
 * Zentriz — mas ainda assim por uma linha de banco EXPLÍCITA, com credencial própria e verificada,
 * nunca por variável de ambiente.
 *
 * A regra que fecha o buraco: **estes slots nunca são fallback de tenant.** Nenhum caminho de
 * resolução de tenant chama este módulo; `resolveProjectLlmCandidates` só o alcança pelo ramo
 * `createdByRole === 'zentriz_admin'`, que é a própria conta de gestão operando.
 */
import { pool } from "../db/client.js";
import type { ResolvedLlmConfig } from "./tenantLlmConfig.js";
import { hasOwnCredentials } from "./tenantLlmConfig.js";

export class PlatformLlmNotConfiguredError extends Error {
  readonly code = "PLATFORM_LLM_NOT_CONFIGURED";
  constructor(
    message = "A conta de gestão não tem nenhum slot de LLM utilizável. Configure em Zentriz → LLM da plataforma.",
  ) {
    super(message);
    this.name = "PlatformLlmNotConfiguredError";
  }
}

export interface PlatformLlmSlot {
  id: string;
  priority: number;
  provider: string;
  modelId: string;
  modelIdFallback: string | null;
  label: string | null;
  credentials: Record<string, string>;
  isActive: boolean;
  verifiedAt: string | null;
  verifyStatus: string | null;
  verifyError: string | null;
  verifyModel: string | null;
  verifyLatencyMs: number | null;
}

/**
 * Todos os slots da conta de gestão, **na ordem da fila**.
 *
 * O `ORDER BY priority ASC` não é decoração: os dois leitores antigos desta tabela usavam
 * `LIMIT 1` sem ordenação, o que era inofensivo enquanto o índice `((TRUE))` garantia uma linha só
 * — e passaria a devolver linha **arbitrária** assim que a migration 126 permitisse a segunda.
 */
export async function getPlatformSlots(): Promise<PlatformLlmSlot[]> {
  try {
    const res = await pool.query(
      `SELECT id, priority, provider, model_id, model_id_fallback, label, credentials, is_active,
              verified_at, verify_status, verify_error, verify_model, verify_latency_ms
       FROM zentriz_llm_config
       ORDER BY priority ASC`,
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      id:              String(row.id ?? ""),
      priority:        Number(row.priority ?? 0),
      // Sem `??` de literal: um provider/modelo "por omissão" aqui seria a Zentriz escolhendo
      // modelo sozinha, que é exatamente o que a migration 126 tirou dos DEFAULTs do schema.
      provider:        String(row.provider ?? ""),
      modelId:         String(row.model_id ?? ""),
      modelIdFallback: row.model_id_fallback ? String(row.model_id_fallback) : null,
      label:           row.label ? String(row.label) : null,
      credentials:     (row.credentials as Record<string, string>) ?? {},
      isActive:        row.is_active !== false,
      verifiedAt:      row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
      verifyStatus:    row.verify_status ? String(row.verify_status) : null,
      verifyError:     row.verify_error ? String(row.verify_error) : null,
      verifyModel:     row.verify_model ? String(row.verify_model) : null,
      verifyLatencyMs: row.verify_latency_ms != null ? Number(row.verify_latency_ms) : null,
    }));
  } catch (e) {
    // Migration ainda não aplicada: tabela (42P01) ou coluna (42703) inexistente. Só ESSES viram
    // "não configurado". Banco fora do ar mandaria o operador configurar um slot que já existe —
    // erro de diagnóstico que custa a sessão inteira; melhor propagar a falha real.
    const code = (e as { code?: string }).code;
    if (code === "42P01" || code === "42703") return [];
    throw e;
  }
}

/** Um slot da gestão só serve com credencial PRÓPRIA — a conta paga, mas declaradamente. */
export function platformSlotUsable(slot: PlatformLlmSlot): boolean {
  return (
    slot.isActive && !!slot.provider && !!slot.modelId &&
    hasOwnCredentials(slot.provider, slot.credentials)
  );
}

/** Converte um slot da gestão no mesmo `ResolvedLlmConfig` que a resolução de tenant produz. */
export function toResolvedPlatform(slot: PlatformLlmSlot): ResolvedLlmConfig {
  const c = slot.credentials;
  return {
    provider:           slot.provider,
    modelId:            slot.modelId,
    fallbackModelId:    slot.modelIdFallback ?? undefined,
    apiKey:             c.api_key ?? "",
    awsRegion:          c.aws_region,
    awsAccessKeyId:     c.aws_access_key_id,
    awsSecretAccessKey: c.aws_secret_access_key,
    foundryApiKey:      c.foundry_api_key,
    foundryResource:    c.foundry_resource,
    foundryBaseUrl:     c.foundry_base_url,
    googleApiKey:       c.google_api_key,
    googleBaseUrl:      c.google_base_url,
    vertexProjectId:    c.vertex_project_id,
    vertexLocation:     c.vertex_location,
    vertexServiceAccountJson: c.vertex_service_account_json,
    azureEndpoint:      c.endpoint,
    azureDeployment:    c.deployment_name,
    azureApiVersion:    c.api_version,
    isDefault:          false,
    priority:           slot.priority,
  };
}

/**
 * A fila da conta de gestão pronta para virar envelope dos agents: o slot 0 primeiro, as
 * contingências atrás, cada uma com a credencial DELA.
 *
 * Lança quando não há nada utilizável — falhar alto é o comportamento pedido pela LEI. O caminho
 * silencioso ("cai no env") é justamente o que fazia a fatura andar sem ninguém ver.
 */
export async function resolvePlatformCandidates(): Promise<ResolvedLlmConfig[]> {
  const slots = (await getPlatformSlots()).filter(platformSlotUsable);
  if (slots.length === 0) throw new PlatformLlmNotConfiguredError();
  return slots.map(toResolvedPlatform);
}
