-- 070 — RFC-0004 Onda 0 (S5): tokens de metrica NUNCA negativos.
-- Sem este CHECK, um POST /agent-metrics com tokens negativos (token de projeto do
-- executor nao-confiavel alcanca a rota legitimamente) zerava o SUM mensal do tenant
-- em tenantCostCap e anulava o cost-cap da migration 068 (denial-of-wallet).
-- O handler agora tambem faz clamp; o CHECK e a defesa em profundidade no dado.
-- Pre-verificado em dev e prod (2026-09-03): zero linhas negativas -> CHECK aplica limpo.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$ (split ingenuo por ';').
ALTER TABLE project_agent_metrics DROP CONSTRAINT IF EXISTS project_agent_metrics_tokens_nonnegative;
ALTER TABLE project_agent_metrics ADD CONSTRAINT project_agent_metrics_tokens_nonnegative
  CHECK (input_tokens >= 0 AND output_tokens >= 0);
