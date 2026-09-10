/**
 * llmSlotProbe.ts — ⚖️ Jean, 2026-09-10:
 * *"sempre testando se funciona e em caso de nao funcionar testa o proximo,
 *   o ideal é testar no momento que é adicionado"*.
 *
 * Testar no momento em que o slot é cadastrado é o único ponto em que o erro é BARATO: o operador
 * ainda está na tela, com a credencial na mão. Descoberto no meio de um run, o mesmo erro custa o
 * run inteiro — e antes disto a tela dizia "✅ Credenciais configuradas" olhando só se os CAMPOS
 * estavam preenchidos, nunca se a chave era aceita.
 *
 * O teste é uma chamada REAL, mínima, feita pelos AGENTS — que é onde vivem os clientes
 * de todos os providers. Testar por outro caminho (listar modelos, validar formato da chave) daria
 * um verde que não prova nada: foi exatamente esse o GOTCHA do entitlement no Bedrock, onde o
 * catálogo lista modelos que o `invoke` recusa.
 */
import { pool } from "../db/client.js";

export interface DiscoveredModel {
  id: string;
  /** Passou na invocação real. Só `true` entra nos selects como opção utilizável. */
  ok: boolean;
  kind: string;
  message: string;
  latencyMs: number;
}

export interface ModelCatalog {
  provider: string;
  /** `provider` = veio de uma chamada de listagem real; `catalog` = lista local (não confirmada). */
  source: "provider" | "catalog";
  /** Por que caiu no catálogo local, quando caiu. Vai para a tela. */
  warning: string;
  models: DiscoveredModel[];
  usable: number;
  total: number;
  cached: boolean;
}

export interface ProbeResult {
  ok: boolean;
  /** "" quando ok; senão auth | model | quota | network | config | other | unavailable. */
  kind: string;
  /** Mensagem já SEM credencial (o probe higieniza no lado Python) e curta o bastante para a tela. */
  message: string;
  latencyMs: number;
  model: string;
}

/** Nomes que o Python procura no envelope (`runtime.py`); o DB guarda alguns com outro nome. */
export function credentialsToEnvelope(
  provider: string,
  modelId: string,
  creds: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { provider, model: modelId };
  const copiar = (from: string, to = from) => { if (creds[from]) env[to] = creds[from]; };
  copiar("aws_access_key_id"); copiar("aws_secret_access_key"); copiar("aws_region");
  copiar("foundry_api_key"); copiar("foundry_resource"); copiar("foundry_base_url");
  copiar("google_api_key"); copiar("google_base_url");
  copiar("vertex_project_id"); copiar("vertex_location"); copiar("vertex_service_account_json");
  copiar("api_key");
  // Azure guarda com nome curto no slot e nome prefixado no envelope.
  copiar("endpoint", "azure_endpoint");
  copiar("deployment_name", "azure_deployment");
  copiar("api_version", "azure_api_version");
  return env;
}

/**
 * Faz o probe. NUNCA lança: um agents fora do ar não pode impedir o tenant de salvar o slot — isso
 * transformaria uma indisponibilidade nossa em bloqueio de configuração dele. Nesse caso o
 * resultado é `unavailable`, que a tela mostra como "não testado", diferente de "reprovado".
 */
export async function probeSlot(
  provider: string,
  modelId: string,
  credentials: Record<string, string>,
  timeoutMs = 45_000,
): Promise<ProbeResult> {
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) {
    return { ok: false, kind: "unavailable", message: "API_AGENTS_URL ausente — slot não testado",
             latencyMs: 0, model: modelId };
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/llm/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_id: modelId,
        llm_config: credentialsToEnvelope(provider, modelId, credentials),
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, kind: "unavailable", model: modelId, latencyMs: Date.now() - t0,
               message: `agents respondeu HTTP ${resp.status} ao testar o slot` };
    }
    const j = (await resp.json()) as Record<string, unknown>;
    return {
      ok: !!j.ok,
      kind: String(j.kind ?? (j.ok ? "" : "other")),
      message: String(j.message ?? ""),
      latencyMs: Number(j.latency_ms ?? (Date.now() - t0)),
      model: String(j.model ?? modelId),
    };
  } catch (err) {
    return { ok: false, kind: "unavailable", model: modelId, latencyMs: Date.now() - t0,
             message: `não foi possível testar agora: ${String(err).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚖️ Jean, 2026-09-10: *"a lista de modelos disponíveis deve ser obtida de forma dinâmica baseado
 * no provider e credenciais informadas, daí carrega a lista de modelos disponíveis nos selects"*.
 *
 * Devolve a lista JÁ VERIFICADA por invocação real. O timeout é largo de propósito: no Bedrock são
 * ~87 ids para testar (rodam em paralelo nos agents, ~3,5 s medidos). Nunca lança — sem catálogo a
 * tela cai no que já tinha, e não numa página quebrada.
 */
export async function listModels(
  provider: string,
  credentials: Record<string, string>,
  refresh = false,
  timeoutMs = 120_000,
): Promise<ModelCatalog | null> {
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/llm/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llm_config: credentialsToEnvelope(provider, "", credentials),
        refresh,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as Record<string, unknown>;
    const models = Array.isArray(j.models) ? j.models : [];
    return {
      provider: String(j.provider ?? provider),
      source: j.source === "provider" ? "provider" : "catalog",
      warning: String(j.warning ?? ""),
      usable: Number(j.usable ?? 0),
      total: Number(j.total ?? models.length),
      cached: Boolean(j.cached),
      models: models.map((m) => {
        const o = m as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          ok: Boolean(o.ok),
          kind: String(o.kind ?? ""),
          message: String(o.message ?? ""),
          latencyMs: Number(o.latency_ms ?? 0),
        };
      }).filter((m) => m.id),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Grava o veredicto na linha do slot (migration 125). `unavailable` NÃO apaga um resultado
 * anterior: "não consegui testar" não é prova de que o slot piorou, e sobrescrever um `ok` real
 * por causa de um agents reiniciando faria a tela mentir.
 */
export async function recordProbe(
  tenantId: string, priority: number, r: ProbeResult,
): Promise<void> {
  if (r.kind === "unavailable") return;
  try {
    await pool.query(
      `UPDATE tenant_llm_configs
          SET verified_at = now(), verify_status = $3, verify_error = $4,
              verify_model = $5, verify_latency_ms = $6
        WHERE tenant_id = $1 AND priority = $2`,
      [tenantId, priority, r.ok ? "ok" : (r.kind || "other"), r.ok ? null : r.message.slice(0, 800),
       r.model, Math.round(r.latencyMs)],
    );
  } catch {
    // A migration pode ainda não ter rodado neste ambiente — o veredicto volta na resposta HTTP
    // de qualquer jeito. Perder o registro não pode derrubar o salvamento do slot.
  }
}
