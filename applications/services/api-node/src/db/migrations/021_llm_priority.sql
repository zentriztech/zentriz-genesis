-- Migration 021: LLM com prioridade por tenant (Padrão, Contingência 1, 2, 3)
-- Remove a constraint UNIQUE(tenant_id) e adiciona UNIQUE(tenant_id, priority).
-- Cada tenant pode ter até 4 configs LLM em ordem de prioridade.

-- 1. Remover constraint única antiga (se existir)
ALTER TABLE tenant_llm_configs
  DROP CONSTRAINT IF EXISTS tenant_llm_configs_tenant_id_key;

-- 2. Adicionar coluna priority (0=Padrão, 1=Contingência 1, 2=Contingência 2, 3=Contingência 3)
ALTER TABLE tenant_llm_configs
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0
    CHECK (priority BETWEEN 0 AND 3);

-- 3. Nova constraint: um tenant não pode ter duas configs com mesma prioridade
ALTER TABLE tenant_llm_configs
  DROP CONSTRAINT IF EXISTS tenant_llm_configs_tenant_priority_key;

ALTER TABLE tenant_llm_configs
  ADD CONSTRAINT tenant_llm_configs_tenant_priority_key
  UNIQUE (tenant_id, priority);

-- 4. Índice para busca rápida por tenant ordenada por prioridade
CREATE INDEX IF NOT EXISTS idx_tenant_llm_priority
  ON tenant_llm_configs (tenant_id, priority ASC)
  WHERE is_active = TRUE;

-- 5. Migrar registros existentes: o único registro vira priority=0 (Padrão)
UPDATE tenant_llm_configs SET priority = 0 WHERE priority IS NULL OR priority = 0;

COMMENT ON COLUMN tenant_llm_configs.priority IS
  '0=Padrão, 1=Contingência 1, 2=Contingência 2, 3=Contingência 3. '
  'O runner tenta na ordem crescente; pula configs sem credenciais válidas.';
