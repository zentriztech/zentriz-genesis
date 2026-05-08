-- Migration 023: múltiplos slots de cloud por tenant
-- Substitui UNIQUE(tenant_id, provider) por UNIQUE(tenant_id, slot_index),
-- permitindo ex: 2x AWS (prod + staging) ou qualquer combinação de providers.

-- 1. Adicionar colunas novas
ALTER TABLE tenant_cloud_connections
  ADD COLUMN IF NOT EXISTS slot_index SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS label      TEXT;

-- 2. Migrar registros existentes: garantir slot_index único por tenant
--    (caso haja mais de um provider por tenant, numerar em ordem de created_at)
UPDATE tenant_cloud_connections t
SET slot_index = sub.rn - 1
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at ASC) AS rn
  FROM tenant_cloud_connections
) sub
WHERE t.id = sub.id;

-- 3. Remover constraint antiga e criar nova
ALTER TABLE tenant_cloud_connections
  DROP CONSTRAINT IF EXISTS tenant_cloud_connections_tenant_id_provider_key;

ALTER TABLE tenant_cloud_connections
  ADD CONSTRAINT tenant_cloud_connections_tenant_slot_key
  UNIQUE (tenant_id, slot_index);

-- 4. Índice para listagem ordenada
CREATE INDEX IF NOT EXISTS idx_cloud_connections_tenant_slot
  ON tenant_cloud_connections (tenant_id, slot_index ASC)
  WHERE status = 'active';

COMMENT ON COLUMN tenant_cloud_connections.slot_index IS
  'Posicao na lista (0=primeiro/padrao). Define prioridade no sync de secrets.';

COMMENT ON COLUMN tenant_cloud_connections.label IS
  'Nome livre dado pelo usuario (ex: AWS Producao, GCP Staging). Opcional.';
