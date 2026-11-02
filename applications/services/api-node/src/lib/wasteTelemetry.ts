/**
 * wasteTelemetry.ts — flag `WASTE_TELEMETRY` e normalização do motivo da chamada de LLM
 * (plano de evolução v2, tarefa 1.4: telemetria de desperdício).
 *
 * Motivos: primary | retry | repair | rework | escalation | support. SÓ MEDE: nenhum comportamento muda.
 *
 *   off    (padrão) nada muda: nenhuma coluna nova é escrita, o SQL e o payload são byte-idênticos ao anterior.
 *   shadow grava `call_reason` e `call_idem_key` em `llm_call_ledger` (quem chama informa; a api só valida).
 *   on     mesma gravação do shadow (não há ação automática sobre o desperdício nesta tarefa).
 *
 * Espelho Python: `orchestrator/agents/llm_guard.py::waste_mode`.
 */
export type WasteTelemetryMode = "off" | "shadow" | "on";
export type CallReason = "primary" | "retry" | "repair" | "rework" | "escalation" | "support";

export const CALL_REASONS: readonly CallReason[] = ["primary", "retry", "repair", "rework", "escalation", "support"];

/** Valor ausente ou desconhecido ⇒ `off` (fail-safe: nunca liga por engano). */
export function wasteTelemetryMode(env: NodeJS.ProcessEnv = process.env): WasteTelemetryMode {
  const raw = (env.WASTE_TELEMETRY ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

/** Motivo válido ou `null`. Nunca lança: motivo desconhecido vira NULL, o registro não quebra. */
export function normalizeCallReason(v: unknown): CallReason | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CALL_REASONS as readonly string[]).includes(s) ? (s as CallReason) : null;
}

/** Chave de idempotência por chamada de negócio (`projeto|task|etapa|tentativa`). Vazia/inválida ⇒ `null`. */
export function normalizeIdemKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 400);
  return s.length >= 3 && s.includes("|") ? s : null;
}
