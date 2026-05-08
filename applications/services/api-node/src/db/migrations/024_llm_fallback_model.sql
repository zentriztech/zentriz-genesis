-- Migration 024: model_id_fallback por slot LLM
-- Permite ex: Sonnet como principal e Opus como fallback no mesmo slot.
-- rework_attempt >= 1 (QA_FAIL) e chamadas de QA após Dev-com-Opus usam o fallback.

ALTER TABLE tenant_llm_configs
  ADD COLUMN IF NOT EXISTS model_id_fallback TEXT;

COMMENT ON COLUMN tenant_llm_configs.model_id_fallback IS
  'Modelo usado em rework (QA_FAIL >= 1) ou quando QA precisa igualar/superar o modelo do Dev. NULL = sem fallback (usa model_id em todos os casos).';
