-- 032_ephemeral_quota_evict.sql
-- Suporte à eviction "mais antigo primeiro" na quota de deploys S3 estáticos.
--
-- Contexto: a quota (S3_STATIC_MAX_ACTIVE_PER_TENANT) rejeitava novos deploys quando o
-- tenant tinha N deploys 'running' — mas deploys vivem 7 dias (TTL) mesmo após o projeto
-- ser entregue, então poucas rodadas esgotavam a quota. Agora, ao atingir a quota, o mais
-- antigo é destruído automaticamente. Este índice parcial ordena por created_at ASC para
-- a query de seleção do(s) mais antigo(s) ativo(s) por tenant.
--
-- (O default da quota vive em código/env — S3_STATIC_MAX_ACTIVE_PER_TENANT=20 — não em DB.)

CREATE INDEX IF NOT EXISTS idx_ephemeral_evict_oldest
  ON ephemeral_deployments (tenant_id, created_at ASC)
  WHERE status IN ('provisioning','running','running_degraded');
