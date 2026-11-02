-- Plano de evolução v2, tarefa 1.4: segundos desperdiçados (retry + repair + rework) por fase x semana.
-- Fonte: llm_call_ledger (migrations 131 + 137), coluna duration_ms. Somente leitura.
-- Mesmas definições de bucket e dup_rede de desperdicio_pct_por_fase_semana.sql.
-- ATENÇÃO: duration_ms é o tempo da chamada ao provedor. NÃO inclui espera de backoff entre tentativas de rede,
-- fila nem validação local, então 'segundos_desperdicados' é PISO do tempo de relógio perdido.
-- Chamadas sem duration_ms (NULL) são contadas em 'sem_duracao' e não entram na soma.
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
  SELECT date_trunc('week', created_at)::date AS semana, phase AS fase,
         CASE WHEN dup_rede THEN 'retry' ELSE motivo END AS bucket, duration_ms
  FROM cls
)
SELECT semana, fase,
       ROUND(SUM(duration_ms) / 1000.0, 1)                                                      AS segundos_total,
       ROUND(SUM(duration_ms) FILTER (WHERE bucket = 'retry') / 1000.0, 1)                      AS retry_s,
       ROUND(SUM(duration_ms) FILTER (WHERE bucket = 'repair') / 1000.0, 1)                     AS repair_s,
       ROUND(SUM(duration_ms) FILTER (WHERE bucket = 'rework') / 1000.0, 1)                     AS rework_s,
       ROUND(SUM(duration_ms) FILTER (WHERE bucket IN ('retry','repair','rework')) / 1000.0, 1) AS segundos_desperdicados,
       ROUND(100.0 * SUM(duration_ms) FILTER (WHERE bucket IN ('retry','repair','rework')) / NULLIF(SUM(duration_ms), 0), 1) AS pct_segundos_desperdicados,
       COUNT(*) FILTER (WHERE duration_ms IS NULL)                                              AS sem_duracao
FROM buck
GROUP BY 1, 2
ORDER BY 1 DESC, segundos_total DESC NULLS LAST;
