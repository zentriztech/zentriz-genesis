-- 029_cyborg_llm_config.sql
-- FT-18 (Cyborg V2): modelo dedicado para o Cyborg (etapa de lapidação + entrega).
-- Cyborg usa modelo mais capaz disponível — configurável por tenant.

ALTER TABLE tenant_llm_configs
  ADD COLUMN IF NOT EXISTS cyborg_model_id text,
  ADD COLUMN IF NOT EXISTS cyborg_model_id_fallback text;

ALTER TABLE zentriz_llm_config
  ADD COLUMN IF NOT EXISTS cyborg_model_id text DEFAULT 'us.anthropic.claude-opus-4-7',
  ADD COLUMN IF NOT EXISTS cyborg_model_id_fallback text DEFAULT 'us.anthropic.claude-sonnet-4-6';

-- Backfill Zentriz singleton se ainda estiver null
UPDATE zentriz_llm_config
   SET cyborg_model_id = COALESCE(cyborg_model_id, 'us.anthropic.claude-opus-4-7'),
       cyborg_model_id_fallback = COALESCE(cyborg_model_id_fallback, 'us.anthropic.claude-sonnet-4-6')
 WHERE cyborg_model_id IS NULL OR cyborg_model_id_fallback IS NULL;

COMMENT ON COLUMN tenant_llm_configs.cyborg_model_id IS
  'Modelo usado pelo Cyborg V2 (lapidação e entrega final). Fallback do tenant se null: zentriz_llm_config.cyborg_model_id.';
COMMENT ON COLUMN tenant_llm_configs.cyborg_model_id_fallback IS
  'Fallback do modelo do Cyborg quando o principal falha.';
