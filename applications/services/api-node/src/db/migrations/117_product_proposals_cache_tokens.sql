-- 🔴 GAP-148 — o instrumento de cache existia em UM caminho de medicao, de tres.
--
-- O GAP-142 deu colunas de cache a project_agent_metrics, e o GAP-147 mostrou o preco de nao
-- ter: no instante em que o cache passou a funcionar no spec_validator, input_tokens caiu para 2
-- e o medidor (fonte unica) subestimou a validacao em ~99%. Sobraram DOIS caminhos com o mesmo
-- risco, ainda sem cache marcado -- e e exatamente por isso que se instrumenta ANTES de marcar:
--   1. CTO da Bancada (api -> agents /invoke/cto/async e /invoke/raw) -> project_agent_metrics,
--      colunas ja existem desde a 116; faltava o envelope carregar os tokens (feito no codigo).
--   2. SPLITTER / decomposicao de produto -> product_proposals, que nao tinha onde registrar.
--      Este arquivo fecha o 2.
--
-- NULL != 0, igual a 116: NULL = o provedor nao reportou cache nesta operacao; 0 = reportou e nao
-- houve cache. Sem essa distincao, um relatorio de economia afirmaria medicao onde nao houve.
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;

-- Mesmo racional da 070/116 (denial-of-wallet): negativo distorceria qualquer relatorio.
ALTER TABLE product_proposals DROP CONSTRAINT IF EXISTS product_proposals_cache_nonnegative;
ALTER TABLE product_proposals ADD CONSTRAINT product_proposals_cache_nonnegative
  CHECK (
    (cache_read_tokens  IS NULL OR cache_read_tokens  >= 0) AND
    (cache_write_tokens IS NULL OR cache_write_tokens >= 0)
  );

COMMENT ON COLUMN product_proposals.cache_read_tokens  IS
  'GAP-148: tokens lidos do cache de prompt na decomposicao (0,1x do preco de entrada). NULL = nao reportado.';
COMMENT ON COLUMN product_proposals.cache_write_tokens IS
  'GAP-148: tokens gravados no cache de prompt na decomposicao (1,25x da entrada). NULL = nao reportado.';
