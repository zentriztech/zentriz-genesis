-- 084_cloud_slots_partial_unique.sql
-- Cloud Deploy: unicidade de slot_index vale SÓ para linhas ATIVAS.
--
-- Bug latente (registrado em 2026-09-03, follow-up do fix de UPSERT): o DELETE é soft
-- (status='revoked') e a linha revogada MANTÉM o slot_index, mas a UNIQUE total
-- (tenant_id, slot_index) da migration 023 ignora status. Ao deletar um slot NÃO-último
-- com múltiplos slots (ativos 0,1 → revoga 0 → recompact põe o ex-1 em 0), o UPDATE do
-- recompact colide com a linha revogada em 0 (duplicate key) e a rota devolve 500.
--
-- Fix: mesmo desenho já usado em tenant_uiux_connections (migration 058) — índice único
-- PARCIAL sobre status='active'. Linhas revogadas ficam como histórico sem participar
-- da unicidade. O INSERT do POST deixa de precisar do UPSERT de reativação.
--
-- ORDEM IMPORTA (achado ao vivo no stack dev): renumerar ANTES de derrubar a constraint
-- total colide com a linha revogada que ainda ocupa o slot 0 (exatamente o estado que o
-- bug deixa no banco) → migration falha → api em crash-loop. Por isso: (1) derruba a
-- constraint total, (2) renumera os ativos, (3) cria o índice parcial.

-- 1. Remove a constraint total (nome dado na 023) e o nome auto-gerado, se existir.
ALTER TABLE tenant_cloud_connections
  DROP CONSTRAINT IF EXISTS tenant_cloud_connections_tenant_slot_key;

ALTER TABLE tenant_cloud_connections
  DROP CONSTRAINT IF EXISTS tenant_cloud_connections_tenant_id_slot_index_key;

-- 2. Saneamento: garante que as linhas ATIVAS estão numeradas 0..N por tenant (um recompact
--    que falhou no meio pode ter deixado buracos). Sem a constraint total, não há colisão
--    com linhas revogadas; entre ativos a ordenação por slot_index preserva a unicidade.
UPDATE tenant_cloud_connections t
SET slot_index = sub.rn - 1
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY slot_index ASC, created_at ASC) AS rn
  FROM tenant_cloud_connections
  WHERE status = 'active'
) sub
WHERE t.id = sub.id AND t.slot_index <> sub.rn - 1;

-- 3. Unicidade parcial (só ativos).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_connections_tenant_slot_active
  ON tenant_cloud_connections (tenant_id, slot_index)
  WHERE status = 'active';
