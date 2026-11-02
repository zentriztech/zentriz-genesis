-- 139_llm_roles_backfill.sql
--
-- Plano de evolucao v2, tarefa 2A.3 — backfill dos papeis a partir das colunas legadas.
-- Idempotente: cada UPDATE so toca linhas em que o destino ainda esta NULL.
-- Nao toca nenhuma tabela de backup (*_bak_*), nenhuma coluna legada e nenhum credentials.
--
-- Regras (D1, D1b, D3 do plano, docs-evo/2A0-semanticas-fallback.md):
--   model_orchestrator := model_id
--   model_advisor      := model_id_fallback, somente se nao nulo, nao vazio e DIFERENTE de model_id
--                         (fallback igual ao principal fica NULL = sem escalada, D1b)
--   model_advisor      := cyborg_model_id, somente se o fallback do slot e NULL ou vazio, o advisor
--                         ainda e NULL e o valor e diferente de model_id (D3). Nao se aplica quando o
--                         fallback e igual ao principal, porque ai o tenant declarou "sem escalada".
--                         A migration 030 carimbou cyborg_model_id em todos os tenants, entao este
--                         passo so existe para nao perder intencao e e listado na simulacao.
--   model_staff        := fica NULL (D1: Staff vazio usa o Orchestrator, declarado)
--
-- A conta de gestao (zentriz_llm_config) NAO recebe o passo cyborg: seus cyborg_model_id*
-- sao DEFAULTs de coluna das migrations 029/030, nao escolha de ninguem.

UPDATE tenant_llm_configs
   SET model_orchestrator = btrim(model_id)
 WHERE model_orchestrator IS NULL AND model_id IS NOT NULL AND btrim(model_id) <> '';

UPDATE tenant_llm_configs
   SET model_advisor = btrim(model_id_fallback)
 WHERE model_advisor IS NULL
   AND model_id_fallback IS NOT NULL
   AND btrim(model_id_fallback) <> ''
   AND btrim(model_id_fallback) <> btrim(model_id);

UPDATE tenant_llm_configs
   SET model_advisor = btrim(cyborg_model_id)
 WHERE model_advisor IS NULL
   AND (model_id_fallback IS NULL OR btrim(model_id_fallback) = '')
   AND cyborg_model_id IS NOT NULL
   AND btrim(cyborg_model_id) <> ''
   AND btrim(cyborg_model_id) <> btrim(model_id);

UPDATE zentriz_llm_config
   SET model_orchestrator = btrim(model_id)
 WHERE model_orchestrator IS NULL AND model_id IS NOT NULL AND btrim(model_id) <> '';

UPDATE zentriz_llm_config
   SET model_advisor = btrim(model_id_fallback)
 WHERE model_advisor IS NULL
   AND model_id_fallback IS NOT NULL
   AND btrim(model_id_fallback) <> ''
   AND btrim(model_id_fallback) <> btrim(model_id);
