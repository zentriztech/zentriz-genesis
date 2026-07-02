-- FT-17: campos S3 static + campos de coerência/segurança
-- Migration idempotente + forward-only

-- Expandir enum de provider para aceitar 's3-static'
ALTER TABLE ephemeral_deployments
  DROP CONSTRAINT IF EXISTS ephemeral_deployments_provider_check;
ALTER TABLE ephemeral_deployments
  ADD CONSTRAINT ephemeral_deployments_provider_check
    CHECK (provider = ANY (ARRAY['fly'::text, 'ecs'::text, 'mock'::text, 's3-static'::text]));

-- Expandir enum de status para 'running_degraded' (health-check com console errors)
ALTER TABLE ephemeral_deployments
  DROP CONSTRAINT IF EXISTS ephemeral_deployments_status_check;
ALTER TABLE ephemeral_deployments
  ADD CONSTRAINT ephemeral_deployments_status_check
    CHECK (status = ANY (ARRAY[
      'provisioning'::text, 'running'::text, 'running_degraded'::text,
      'failed'::text, 'destroying'::text, 'destroyed'::text
    ]));

-- Novos campos
ALTER TABLE ephemeral_deployments
  ADD COLUMN IF NOT EXISTS bucket_name       text,
  ADD COLUMN IF NOT EXISTS deployment_type   text,  -- 'nextjs' | 'vite' | 'cra' | 'html'
  ADD COLUMN IF NOT EXISTS screenshot_url    text,
  ADD COLUMN IF NOT EXISTS tenant_id         uuid,  -- denormalizado para queries de quota
  ADD COLUMN IF NOT EXISTS consented_by      uuid,  -- user_id que aceitou termo LGPD
  ADD COLUMN IF NOT EXISTS consented_at      timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ttl_days          integer,  -- para s3-static (Fly usa ttl_minutes)
  ADD COLUMN IF NOT EXISTS build_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS build_log_url     text;    -- link para stdout+stderr completo

-- UNIQUE INDEX parcial: evita race no double-click (anti-race)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ephemeral_active_per_project
  ON ephemeral_deployments (project_id)
  WHERE status IN ('provisioning', 'running', 'running_degraded');

-- Índice para queries de quota por tenant (rate limit + max_active)
CREATE INDEX IF NOT EXISTS idx_ephemeral_tenant_status
  ON ephemeral_deployments (tenant_id, status, created_at DESC);

-- Backfill tenant_id em rows existentes (join com projects)
UPDATE ephemeral_deployments e
   SET tenant_id = p.tenant_id
  FROM projects p
 WHERE e.project_id = p.id
   AND e.tenant_id IS NULL;

COMMENT ON COLUMN ephemeral_deployments.bucket_name IS
  'FT-17: nome do bucket S3 (provider=s3-static). Formato: genesis-<project_short>-<random_hex>';
COMMENT ON COLUMN ephemeral_deployments.deployment_type IS
  'FT-17: tipo detectado do projeto — nextjs | vite | cra | html';
COMMENT ON COLUMN ephemeral_deployments.screenshot_url IS
  'FT-17: URL do screenshot Playwright pós-deploy (health-check visual).';
COMMENT ON COLUMN ephemeral_deployments.consented_by IS
  'FT-17: user_id que aceitou termo LGPD antes do deploy S3 público.';
