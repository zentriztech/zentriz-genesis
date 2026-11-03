/**
 * costSource.ts — flags da C8' (fonte única de custo e cota diária de tokens).
 *
 * `COST_SOURCE_LEDGER` (off|shadow|on, padrão off): de onde sai o gasto do TENANT no mês
 * (cap mensal, dashboard `costPerDeliveryUsd`, value events).
 *   off    gasto por `project_agent_metrics` (comportamento anterior, byte-idêntico).
 *   shadow calcula as DUAS fontes, devolve a de `project_agent_metrics` e registra a divergência.
 *   on     ledger do Guard (`llm_call_ledger`) onde houver cobertura; antes dela, `project_agent_metrics`.
 *
 * `DAILY_TOKEN_QUOTA` (off|shadow|on, padrão off): cota diária de tokens do tenant
 * (`tenant_llm_configs.daily_token_quota`) aplicada no `preflight` do Guard.
 *   off    nada muda (nenhuma consulta nova).
 *   shadow só registra o que bloquearia (evento `daily_token_quota_shadow`).
 *   on     nega pelo caminho do Guard (evento `daily_token_quota_denied`).
 *
 * Valor ausente ou desconhecido ⇒ `off` (fail-safe: nunca liga por engano).
 */
export type TriMode = "off" | "shadow" | "on";

function parse(raw: string | undefined): TriMode {
  const v = (raw ?? "off").trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

export function costSourceLedgerMode(env: NodeJS.ProcessEnv = process.env): TriMode {
  return parse(env.COST_SOURCE_LEDGER);
}

export function dailyTokenQuotaMode(env: NodeJS.ProcessEnv = process.env): TriMode {
  return parse(env.DAILY_TOKEN_QUOTA);
}
