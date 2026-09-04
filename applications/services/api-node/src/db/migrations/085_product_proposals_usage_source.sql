-- 085 — Onda 4: custo/telemetria e origem da proposta (RFC-0004 T1.6b + Onda 4 do epico Spec/Bancada).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'idea';
UPDATE product_proposals SET source = 'spec' WHERE origin_project_id IS NOT NULL AND source = 'idea';
ALTER TABLE product_proposals DROP CONSTRAINT IF EXISTS pp_source_check;
ALTER TABLE product_proposals ADD CONSTRAINT pp_source_check CHECK (source IN ('idea', 'spec', 'upload'));
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS model_used TEXT;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS cancelled_by UUID;
CREATE INDEX IF NOT EXISTS pp_review_pending ON product_proposals (tenant_id, updated_at DESC)
  WHERE status = 'done' AND consumed_at IS NULL;
