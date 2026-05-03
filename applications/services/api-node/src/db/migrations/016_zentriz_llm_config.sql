-- Migration 016: Zentriz LLM Config global (FT-13)
-- Config LLM global da Zentriz (zentriz_admin) — sem tenant_id.
-- Regra: zentriz_admin → esta tabela; tenant_admin/user → tenant_llm_configs.

CREATE TABLE IF NOT EXISTS zentriz_llm_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(50)  NOT NULL DEFAULT 'anthropic',
  credentials   JSONB        NOT NULL DEFAULT '{}',
  model_id      VARCHAR(200) NOT NULL DEFAULT 'us.anthropic.claude-sonnet-4-6',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Só 1 registro global — enforced via unique index
CREATE UNIQUE INDEX IF NOT EXISTS zentriz_llm_config_singleton
  ON zentriz_llm_config ((TRUE));

COMMENT ON TABLE zentriz_llm_config IS 'FT-13: Configuração LLM global da Zentriz. Usada por projetos criados por zentriz_admin.';
