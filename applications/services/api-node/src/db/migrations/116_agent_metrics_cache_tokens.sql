-- 🔴 GAP-142 etapa 1 — o medidor de custo nao tinha onde registrar CACHE de prompt.
--
-- Medido em prod (3 dias, project_agent_metrics): 168.376.931 tokens de ENTRADA contra ~8,5 M de
-- saida (razao 20:1) e 71% dessa entrada chegando dentro da janela de 5 min do TTL de cache do
-- Bedrock, no mesmo projeto e mesmo agente. Mas nao havia UMA ocorrencia de cache_control /
-- cachePoint no cerebro -- e, sem coluna, nem daria para provar ganho depois de marcar.
--
-- NULL != 0 de proposito (mesma lei do truncated[]): NULL = o provedor NAO reportou cache nesta
-- chamada; 0 = reportou e nao houve cache. Colapsar os dois em 0 seria afirmar medicao onde nao
-- houve. Por isso as colunas sao nullable e SEM default.
ALTER TABLE project_agent_metrics ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER;
ALTER TABLE project_agent_metrics ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;

-- Mesmo racional da migration 070 (denial-of-wallet via token de projeto do executor nao
-- confiavel): valor negativo aqui distorceria qualquer relatorio de economia. NULL segue valido.
ALTER TABLE project_agent_metrics DROP CONSTRAINT IF EXISTS project_agent_metrics_cache_nonnegative;
ALTER TABLE project_agent_metrics ADD CONSTRAINT project_agent_metrics_cache_nonnegative
  CHECK (
    (cache_read_tokens  IS NULL OR cache_read_tokens  >= 0) AND
    (cache_write_tokens IS NULL OR cache_write_tokens >= 0)
  );

COMMENT ON COLUMN project_agent_metrics.cache_read_tokens  IS
  'GAP-142: tokens lidos do cache de prompt (0,1x do preco de entrada). NULL = provedor nao reportou.';
COMMENT ON COLUMN project_agent_metrics.cache_write_tokens IS
  'GAP-142: tokens gravados no cache de prompt (1,25x do preco de entrada). NULL = provedor nao reportou.';
