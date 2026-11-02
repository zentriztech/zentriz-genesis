-- Plano de evolução v2, tarefa 1.3: custo por papel x agente x semana (base do gate G0.5/G1).
-- Fonte: llm_call_ledger (migration 131 + 135). Só somente-leitura.
-- Linhas anteriores à 135 e chamadas sem papel (LLM_ROLES_MODE=off, ou ponto de chamada não coberto)
-- aparecem como 'nao_medido' — nunca como orchestrator.
-- Agente = prefixo de purpose (ex.: 'DEV:implement_task' vira 'DEV', 'runner:module' vira 'runner').
SELECT
  date_trunc('week', created_at)::date                    AS semana,
  COALESCE(effective_role, llm_role, 'nao_medido')        AS papel,
  split_part(purpose, ':', 1)                             AS agente,
  COUNT(*)                                                AS chamadas,
  COUNT(*) FILTER (WHERE escalated_from IS NOT NULL)      AS escaladas,
  SUM(input_tokens)                                       AS tokens_entrada,
  SUM(output_tokens)                                      AS tokens_saida,
  ROUND(SUM(cost_usd), 4)                                 AS custo_usd,
  ROUND(100 * SUM(cost_usd) / NULLIF(SUM(SUM(cost_usd)) OVER (PARTITION BY date_trunc('week', created_at)), 0), 1) AS pct_da_semana
FROM llm_call_ledger
WHERE created_at >= now() - interval '12 weeks'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, custo_usd DESC;
