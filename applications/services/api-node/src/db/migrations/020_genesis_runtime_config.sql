-- Migration 020: Genesis Runtime Config (Opção A — Tabela no banco)
-- Configuração dinâmica de timeouts e limites por agente, editável pelo portal.
-- Não requer rebuild de imagem — runner lê via API antes de iniciar pipeline.

CREATE TABLE IF NOT EXISTS genesis_runtime_config (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         VARCHAR(100) NOT NULL,
  value       TEXT         NOT NULL,
  description TEXT,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (key, tenant_id)
);

-- Índice para busca rápida por chave (global = tenant_id IS NULL)
CREATE INDEX IF NOT EXISTS idx_genesis_runtime_config_key
  ON genesis_runtime_config (key, tenant_id);

-- Valores padrão globais (tenant_id NULL = aplicado a todos os tenants sem override)
INSERT INTO genesis_runtime_config (key, value, description) VALUES
  ('AGENT_TIMEOUT_ENGINEER', '600', 'Timeout em segundos para o agente Engineer gerar proposta técnica'),
  ('AGENT_TIMEOUT_CTO',      '600', 'Timeout em segundos para o agente CTO gerar/validar charter'),
  ('AGENT_TIMEOUT_PM',       '600', 'Timeout em segundos para o agente PM gerar backlog'),
  ('AGENT_TIMEOUT_DEV',      '600', 'Timeout em segundos para o agente Dev implementar task'),
  ('AGENT_TIMEOUT_QA',       '600', 'Timeout em segundos para o agente QA validar task'),
  ('AGENT_TIMEOUT_MONITOR',  '600', 'Timeout em segundos para o agente Monitor orquestrar'),
  ('AGENT_TIMEOUT_DEVOPS',   '600', 'Timeout em segundos para o agente DevOps provisionar artefatos'),
  ('REQUEST_TIMEOUT',        '600', 'Timeout HTTP base (runner → agents) em segundos'),
  ('MAX_QA_REWORK',          '3',   'Número máximo de ciclos QA_FAIL antes de BLOCKED'),
  ('CLAUDE_MAX_TOKENS',      '16000','Teto de tokens de saída padrão por chamada LLM'),
  ('CLAUDE_MAX_TOKENS_DEV',  '32000','Teto de tokens para agente Dev (implement_task)'),
  ('CLAUDE_MAX_TOKENS_PM',   '32000','Teto de tokens para agente PM (generate_backlog)'),
  ('CLAUDE_MAX_TOKENS_ENGINEER','32000','Teto de tokens para agente Engineer (generate_engineering_docs)')
ON CONFLICT (key, tenant_id) DO NOTHING;

COMMENT ON TABLE genesis_runtime_config IS
  'Configuracao dinamica do runtime Genesis. tenant_id NULL aplica a todos os tenants sem override.';
