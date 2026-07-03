-- 030_opus_4_8_default.sql
-- Upgrade default LLM model to Claude Opus 4.8 (opus-4-7 vira fallback).
-- Motivação: Opus 4.8 disponível no Bedrock (us-east-1) desde 2026-07-03, validado
-- via InvokeModel. Testes iniciais (OrienteMe V6/V7) mostraram entregas menos aderentes
-- ao modelo Dashboard escolhido com opus-4-7; upgrade para 4-8 como default do Genesis
-- e Cyborg.

-- Zentriz singleton — novos defaults
ALTER TABLE zentriz_llm_config
  ALTER COLUMN cyborg_model_id SET DEFAULT 'us.anthropic.claude-opus-4-8',
  ALTER COLUMN cyborg_model_id_fallback SET DEFAULT 'us.anthropic.claude-opus-4-7';

-- Migrar registros existentes que ainda usam opus-4-7 como principal
UPDATE zentriz_llm_config
   SET cyborg_model_id = 'us.anthropic.claude-opus-4-8',
       cyborg_model_id_fallback = 'us.anthropic.claude-opus-4-7'
 WHERE cyborg_model_id = 'us.anthropic.claude-opus-4-7';

-- Migrar tenants — quem estava em opus-4-7 vai pra opus-4-8 (opus-4-7 vira fallback)
UPDATE tenant_llm_configs
   SET model_id = 'us.anthropic.claude-opus-4-8',
       model_id_fallback = 'us.anthropic.claude-opus-4-7'
 WHERE model_id = 'us.anthropic.claude-opus-4-7';

-- Tenants em sonnet-4-6 mantêm sonnet como principal; ajustam só o fallback
UPDATE tenant_llm_configs
   SET model_id_fallback = 'us.anthropic.claude-opus-4-8'
 WHERE model_id = 'us.anthropic.claude-sonnet-4-6'
   AND (model_id_fallback IS NULL OR model_id_fallback = 'us.anthropic.claude-opus-4-7');

-- Cyborg dedicado — sempre 4-8
UPDATE tenant_llm_configs
   SET cyborg_model_id = 'us.anthropic.claude-opus-4-8',
       cyborg_model_id_fallback = COALESCE(cyborg_model_id_fallback, 'us.anthropic.claude-opus-4-7')
 WHERE cyborg_model_id IS NULL OR cyborg_model_id = 'us.anthropic.claude-opus-4-7';
