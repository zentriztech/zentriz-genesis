/**
 * llmRoles.ts — flag `LLM_ROLES_MODE` e normalização do papel de LLM (plano de evolução v2, tarefa 1.3).
 *
 * Papéis: orchestrator | advisor | staff. Ainda NÃO existe roteamento por papel (Fase 2A): aqui só se
 * REGISTRA o papel em `llm_call_ledger` / `project_agent_metrics`.
 *
 *   off    (padrão) nada muda: nenhuma coluna nova é escrita, o SQL e o payload são byte-idênticos ao anterior.
 *   shadow grava o papel DERIVADO do comportamento atual (quem chama informa; a api só valida).
 *   on     mesma gravação do shadow (o roteamento por papel é da Fase 2A, não desta tarefa).
 *
 * Espelho Python: `orchestrator/agents/llm_guard.py::roles_mode`.
 */
export type LlmRolesMode = "off" | "shadow" | "on";
export type LlmRole = "orchestrator" | "advisor" | "staff";

export const LLM_ROLES: readonly LlmRole[] = ["orchestrator", "advisor", "staff"];

/** Valor ausente ou desconhecido ⇒ `off` (fail-safe: nunca liga por engano). */
export function llmRolesMode(env: NodeJS.ProcessEnv = process.env): LlmRolesMode {
  const raw = (env.LLM_ROLES_MODE ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

/** Papel válido ou `null`. Nunca lança: papel desconhecido vira NULL, o registro não quebra. */
export function normalizeLlmRole(v: unknown): LlmRole | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (LLM_ROLES as readonly string[]).includes(s) ? (s as LlmRole) : null;
}
