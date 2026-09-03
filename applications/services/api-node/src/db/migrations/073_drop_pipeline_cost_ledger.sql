-- 073 — RFC-0004 Onda 2 (D4): DROP da pipeline_cost_ledger (migration 027).
-- Dead table: NUNCA recebeu INSERT (zero escritores no repo; zero linhas em dev E prod,
-- pre-verificado 2026-09-03). Era lida como fonte dual em tenantCostCap (MAX com a
-- estimativa por project_agent_metrics) — a fonte UNICA de custo passa a ser
-- project_agent_metrics + tabela de precos em lib/modelPricing.ts.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
DROP TABLE IF EXISTS pipeline_cost_ledger;
