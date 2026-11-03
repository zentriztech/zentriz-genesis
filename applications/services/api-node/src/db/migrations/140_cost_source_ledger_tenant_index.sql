-- 140 - C8' fonte unica de custo (desenho 27 v2): o gasto do TENANT no mes e a cota diaria de tokens
-- passam a ser somados no llm_call_ledger por (tenant_id, created_at). Indice aditivo e idempotente.
-- Sem ponto-e-virgula em literais e sem blocos DO.
CREATE INDEX IF NOT EXISTS idx_llm_ledger_tenant_created ON llm_call_ledger (tenant_id, created_at);

-- plans.monthly_llm_budget_usd: NENHUMA migration popula este campo e NAO ha fonte de valores
-- derivaveis dos planos (monthly_price_cents e receita, nao orcamento de LLM). Decisao C8': fica NULL
-- e NULL significa sem teto de plano (o teto do tenant e o env TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT seguem valendo).
COMMENT ON COLUMN plans.monthly_llm_budget_usd IS
  'Teto mensal de LLM do plano em USD. NULL = sem teto de plano. Hoje nenhum plano e populado de proposito. Lido so por services/tenantCostCap.ts.';
