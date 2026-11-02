-- Plano de evolução v2, tarefa 1.4: % do gasto em retry + repair + rework, por fase x semana.
-- Fonte: llm_call_ledger (migrations 131 + 137). Somente leitura. Requer WASTE_TELEMETRY=shadow|on no api E no orquestrador.
--
-- Definições (tudo explícito, nada escondido):
--   bucket   = call_reason; NULL vira 'nao_medido' (linhas anteriores à 137, flag off, ponto de chamada não coberto).
--   dup_rede = linha com a MESMA call_idem_key de uma linha anterior em até :janela_s segundos. É retry de rede ou
--              reenvio da mesma chamada de negócio: o gasto é real (entra em 'retry'), mas NÃO é outra chamada de negócio.
--   desperdício = retry + repair + rework (+ dup_rede). 'escalation' é reportada à parte (escolha de modelo, não erro).
--   % = USD do bucket / USD total da fase na semana. 'pct_nao_medido' mostra a cobertura: se for alto, o % de
--   desperdício é piso, não estimativa.
-- Parâmetro: janela de deduplicação em segundos (padrão 300).
WITH params AS (SELECT 300::int AS janela_s),
base AS (
  SELECT l.*,
         LAG(l.created_at) OVER (PARTITION BY COALESCE(l.call_idem_key, l.id::text) ORDER BY l.created_at, l.id) AS ts_anterior
  FROM llm_call_ledger l
  WHERE l.created_at >= now() - interval '12 weeks'
),
cls AS (
  SELECT b.*,
         (b.call_idem_key IS NOT NULL AND b.ts_anterior IS NOT NULL
          AND b.created_at - b.ts_anterior <= make_interval(secs => (SELECT janela_s FROM params))) AS dup_rede,
         COALESCE(b.call_reason, 'nao_medido') AS motivo
  FROM base b
),
buck AS (
  SELECT date_trunc('week', created_at)::date AS semana,
         phase AS fase,
         CASE WHEN dup_rede THEN 'retry' ELSE motivo END AS bucket,
         dup_rede,
         cost_usd
  FROM cls
)
SELECT semana, fase,
       ROUND(SUM(cost_usd), 4)                                                    AS gasto_total_usd,
       ROUND(SUM(cost_usd) FILTER (WHERE bucket = 'retry'), 4)                    AS retry_usd,
       ROUND(SUM(cost_usd) FILTER (WHERE bucket = 'repair'), 4)                   AS repair_usd,
       ROUND(SUM(cost_usd) FILTER (WHERE bucket = 'rework'), 4)                   AS rework_usd,
       ROUND(SUM(cost_usd) FILTER (WHERE bucket IN ('retry','repair','rework')), 4) AS desperdicio_usd,
       ROUND(100 * SUM(cost_usd) FILTER (WHERE bucket IN ('retry','repair','rework')) / NULLIF(SUM(cost_usd), 0), 1) AS pct_desperdicio,
       ROUND(100 * SUM(cost_usd) FILTER (WHERE bucket = 'escalation') / NULLIF(SUM(cost_usd), 0), 1) AS pct_escalation,
       ROUND(100 * SUM(cost_usd) FILTER (WHERE bucket = 'nao_medido') / NULLIF(SUM(cost_usd), 0), 1) AS pct_nao_medido,
       COUNT(*)                                                                   AS linhas_pagas,
       COUNT(*) FILTER (WHERE NOT dup_rede)                                       AS chamadas_de_negocio,
       COUNT(*) FILTER (WHERE dup_rede)                                           AS duplicatas_de_rede
FROM buck
GROUP BY 1, 2
ORDER BY 1 DESC, gasto_total_usd DESC;
