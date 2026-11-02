/**
 * llmRoleProbe.ts — plano de evolução v2, tarefa 2A.9: verificação POR PAPEL (orchestrator · advisor · staff).
 *
 * Contrato (com `LLM_ROLES_MODE != off`; com `off` NADA daqui é chamado e o probe é o de sempre):
 *  · cada papel PREENCHIDO é verificado por invocação real (via `probeSlot` → agents `/llm/probe`, que
 *    passa pelo LLM Guard: `probe_slot` → `call_bedrock_direct` faz `_llm_guard.check` e `record`);
 *  · papel vazio NÃO é testado e fica com status NULL;
 *  · ids repetidos são testados UMA vez (o orchestrator costuma ser igual a `model_id`, já testado pelo
 *    probe legado — reaproveitamos esse veredicto, o custo ×3 vira ×(ids distintos − 1));
 *  · concorrência limitada (`ROLE_PROBE_CONCURRENCY`) e timeout por chamada;
 *  · status gravado em `verify_<papel>_status`: `ok` | `denied` | `error` | `timeout`.
 *      denied  = a conta/credencial NÃO pode usar o modelo (AccessDenied, 401/403, ValidationException de
 *                modelo/entitlement: o catálogo lista, o invoke recusa). Corrigir o cadastro resolve.
 *      error   = falha que não prova negação (rede, cota, resposta vazia, outro).
 *      timeout = estourou o prazo do probe.
 *    `unavailable` (agents fora do ar) não é veredicto do papel: na rota de re-teste preserva o anterior;
 *    no salvar zera para NULL (o modelo pode ter mudado, e `ok` antigo não vale para o id novo).
 *  · papel não verificado é INELEGÍVEL: ver `isRoleEligible`.
 *  · nenhum segredo vai para `verify_<papel>_error`: valores de credencial e padrões de chave são
 *    mascarados e a mensagem é truncada em 500 caracteres.
 */
import { pool } from "../db/client.js";
import { LLM_ROLES, type LlmRole } from "../lib/llmRoles.js";
import { probeSlot, type ProbeResult } from "./llmSlotProbe.js";

export type RoleVerifyStatus = "ok" | "denied" | "error" | "timeout";
export interface RoleVerdict { status: RoleVerifyStatus | null; error: string | null; model: string; latencyMs: number }

export const ROLE_PROBE_CONCURRENCY = 2;
export const ROLE_PROBE_TIMEOUT_MS = 30_000;
const ERROR_MAX = 500;

/** Remove valores de credencial e padrões comuns de chave; trunca. */
export function sanitizeRoleError(msg: string, credentials: Record<string, string> = {}): string {
  let s = String(msg ?? "");
  for (const v of Object.values(credentials)) {
    const t = String(v ?? "").trim();
    if (t.length >= 8) s = s.split(t).join("***");
  }
  s = s
    .replace(/AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}/g, "***")
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/([?&](?:key|api[-_]?key|token)=)[^&\s]+/gi, "$1***");
  return s.slice(0, ERROR_MAX);
}

/** Haiku no Bedrock: exige versão e, neste ambiente, prefixo `global.` (`us.` falha só para Haiku). */
export function haikuPrefixHint(modelId: string): string {
  const id = String(modelId ?? "");
  if (!/haiku/i.test(id)) return "";
  const parts: string[] = [];
  if (/^us\./i.test(id)) {
    parts.push("sugestão: use o prefixo global. (o prefixo us. falha só para Haiku no Bedrock), "
      + `ex.: ${id.replace(/^us\./i, "global.")}`);
  }
  if (!/haiku-\d/i.test(id)) parts.push("ids Haiku exigem a versão (ex.: claude-haiku-4-5-20251001-v1:0)");
  return parts.length ? ` [${parts.join("; ")}; o id NÃO foi alterado]` : "";
}

/** Converte o resultado bruto do probe no veredicto do papel; `null` = não é veredicto (unavailable). */
export function classifyRoleProbe(
  r: ProbeResult & { timedOut?: boolean }, modelId: string, credentials: Record<string, string> = {},
): RoleVerdict | null {
  const base = { model: modelId, latencyMs: r.latencyMs };
  if (r.ok) return { ...base, status: "ok", error: null };
  if (r.kind === "unavailable" && !r.timedOut) return null;
  let status: RoleVerifyStatus;
  if (r.timedOut) status = "timeout";
  else if (r.kind === "auth" || r.kind === "model") status = "denied";
  else status = "error";
  const hint = status === "denied" || status === "error" ? haikuPrefixHint(modelId) : "";
  return { ...base, status, error: sanitizeRoleError(sanitizeRoleError(r.message, credentials) + hint, credentials) };
}

/**
 * Contrato para a resolução (g-2b): papel só é elegível se tem modelo E `verify_<papel>_status = 'ok'`.
 * Função pura. Para o orchestrator, `model_id` legado vale quando `model_orchestrator` está vazio.
 */
export function isRoleEligible(slot: Record<string, unknown>, role: LlmRole): boolean {
  const own = String(slot[`model_${role}`] ?? "").trim();
  const model = own || (role === "orchestrator" ? String(slot.model_id ?? "").trim() : "");
  return !!model && slot[`verify_${role}_status`] === "ok";
}

export interface RoleModelsIn { orchestrator?: string | null; advisor?: string | null; staff?: string | null }

/**
 * Verifica os papéis preenchidos. `known` injeta veredictos já obtidos (ex.: o probe legado de `model_id`).
 * Nunca lança. `probe` é injetável para teste.
 */
export async function verifyRoles(
  provider: string,
  models: RoleModelsIn,
  credentials: Record<string, string>,
  opts: {
    known?: Map<string, ProbeResult & { timedOut?: boolean }>;
    concurrency?: number; timeoutMs?: number;
    probe?: typeof probeSlot;
  } = {},
): Promise<Partial<Record<LlmRole, RoleVerdict | null>>> {
  const probe = opts.probe ?? probeSlot;
  const conc = Math.max(1, opts.concurrency ?? ROLE_PROBE_CONCURRENCY);
  const timeout = opts.timeoutMs ?? ROLE_PROBE_TIMEOUT_MS;
  const results = new Map<string, ProbeResult & { timedOut?: boolean }>(opts.known ?? []);
  const ids: string[] = [];
  for (const role of LLM_ROLES) {
    const id = String(models[role] ?? "").trim();
    if (id && !results.has(id) && !ids.includes(id)) ids.push(id);
  }
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { results.set(id, await probe(provider, id, credentials, timeout)); }
      catch (e) {
        results.set(id, { ok: false, kind: "unavailable", message: String(e).slice(0, 200), latencyMs: 0, model: id });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, worker));
  const out: Partial<Record<LlmRole, RoleVerdict | null>> = {};
  for (const role of LLM_ROLES) {
    const id = String(models[role] ?? "").trim();
    if (!id) continue; // vazio: não testa, não aparece
    const r = results.get(id);
    out[role] = r ? classifyRoleProbe(r, id, credentials) : null;
  }
  return out;
}

/**
 * Grava `verify_<papel>_status/_at/_error`. Papel vazio (ausente em `verdicts`, com `models` vazio)
 * → NULL. Veredicto `null` (unavailable) → preserva se `preserveOnUnavailable`, senão NULL.
 * Colunas vêm de whitelist fixa (`LLM_ROLES`), nunca de entrada externa. Nunca lança.
 */
export async function recordRoleVerdicts(
  tenantId: string, priority: number,
  models: RoleModelsIn,
  verdicts: Partial<Record<LlmRole, RoleVerdict | null>>,
  opts: { preserveOnUnavailable: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId, priority];
  for (const role of LLM_ROLES) {
    const empty = !String(models[role] ?? "").trim();
    const v = verdicts[role];
    const c = `verify_${role}`;
    if (!empty && v == null) {
      if (opts.preserveOnUnavailable) continue;
    }
    if (empty || v == null) {
      sets.push(`${c}_status = NULL`, `${c}_at = NULL`, `${c}_error = NULL`);
    } else {
      params.push(v.status, v.error);
      sets.push(`${c}_status = $${params.length - 1}`, `${c}_at = now()`, `${c}_error = $${params.length}`);
    }
  }
  if (!sets.length) return;
  try {
    await pool.query(
      `UPDATE tenant_llm_configs SET ${sets.join(", ")} WHERE tenant_id = $1 AND priority = $2`, params);
  } catch { /* migration 138 pode não ter rodado: o veredicto volta na resposta HTTP */ }
}

/** Forma do veredicto por papel na resposta HTTP. */
export function roleVerdictsPayload(
  models: RoleModelsIn, verdicts: Partial<Record<LlmRole, RoleVerdict | null>>,
) {
  const o: Record<string, unknown> = {};
  for (const role of LLM_ROLES) {
    if (!String(models[role] ?? "").trim()) { o[role] = { status: null, tested: false }; continue; }
    const v = verdicts[role];
    o[role] = v ? { status: v.status, ok: v.status === "ok", error: v.error, model: v.model, latency_ms: v.latencyMs, tested: true }
                : { status: null, tested: false, note: "não testado agora (agents indisponível)" };
  }
  return o;
}

/** `verify` por papel a partir da linha do banco (GET do slot). */
export function roleVerifyFromRow(row: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  for (const role of LLM_ROLES) {
    o[role] = {
      status: (row[`verify_${role}_status`] as string | null | undefined) ?? null,
      at: row[`verify_${role}_at`] ?? null,
      error: (row[`verify_${role}_error`] as string | null | undefined) ?? null,
    };
  }
  return o;
}
