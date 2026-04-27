-- Migration 010: Tenant LLM Config (G38)
-- Cada tenant configura seu próprio provider/API key e quota.
-- Genesis e Deadpool consomem via este contrato.

CREATE TABLE IF NOT EXISTS tenant_llm_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Provider: bedrock | openai | anthropic | azure_openai | custom
  provider      VARCHAR(50)  NOT NULL DEFAULT 'bedrock',

  -- Credenciais — armazenadas criptografadas (app-level encryption recomendado)
  -- Para Bedrock: aws_region + aws_access_key_id + aws_secret_access_key
  -- Para OpenAI/Anthropic: api_key
  -- Para Azure: endpoint + api_key + deployment_name
  credentials   JSONB        NOT NULL DEFAULT '{}',

  -- Modelo padrão para este tenant
  model_id      VARCHAR(200) NOT NULL DEFAULT 'us.anthropic.claude-sonnet-4-6',

  -- Quota diária em tokens (null = sem limite definido pelo tenant)
  daily_token_quota    BIGINT,
  -- Quota reservada para Deadpool (sustainment) — Genesis usa o restante
  deadpool_token_reserve BIGINT DEFAULT 0,

  -- Limites de concorrência por tenant
  max_concurrent_projects INTEGER NOT NULL DEFAULT 3,

  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_llm_configs_tenant_unique UNIQUE (tenant_id)
);

-- Índice para lookup rápido por tenant
CREATE INDEX IF NOT EXISTS idx_tenant_llm_configs_tenant_id
  ON tenant_llm_configs(tenant_id)
  WHERE is_active = TRUE;

-- G39: Fila de projetos por tenant
-- Projetos que excedem max_concurrent ficam em 'queued' até haver slot disponível.
-- O watchdog promove de queued → running quando abre slot.

-- Adiciona coluna queued_at para rastrear quando o projeto entrou na fila
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;

-- Adiciona 'queued' como status válido: drop constraint existente se houver, idempotente via ALTER
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

-- Índice para watchdog encontrar projetos em fila rapidamente
CREATE INDEX IF NOT EXISTS idx_projects_queued
  ON projects(tenant_id, queued_at)
  WHERE status = 'queued';

-- View: contagem de projetos running por tenant (usada pelo watchdog G39)
CREATE OR REPLACE VIEW tenant_running_projects AS
SELECT
  tenant_id,
  COUNT(*) AS running_count
FROM projects
WHERE status = 'running'
GROUP BY tenant_id;

COMMENT ON TABLE tenant_llm_configs IS 'G38: Configuração de LLM por tenant. Genesis e Deadpool compartilham via este contrato.';
COMMENT ON VIEW tenant_running_projects IS 'G39: Contagem de projetos running por tenant para controle de concorrência.';
