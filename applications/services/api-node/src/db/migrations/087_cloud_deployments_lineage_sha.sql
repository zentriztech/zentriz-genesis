-- Migration 087: redeploy da nuvem com a MESMA identidade de linhagem + rollback por SHA.
-- Bloco 4 (M5). Rastreia por qual git_sha cada deploy foi feito, encadeia deploys da mesma
-- linhagem (lineage_root_id) e permite que o teardown ignore recursos que ja pertencem a uma
-- versao mais nova (superseded_by_deployment_id). trigger_kind distingue deploy manual, redeploy
-- pos-merge de evolucao e rollback.
--
-- Formato: runner (db/init.ts) faz split ingenuo por ';' e remove linhas iniciadas por '--'.
-- Sem literais contendo ';'. Somente ALTER TABLE, CREATE INDEX e UPDATE de backfill.

ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS git_sha TEXT;

ALTER TABLE cloud_deployments
  ADD COLUMN IF NOT EXISTS lineage_root_id UUID REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE cloud_deployments
  ADD COLUMN IF NOT EXISTS supersedes_deployment_id UUID REFERENCES cloud_deployments(id) ON DELETE SET NULL;

ALTER TABLE cloud_deployments
  ADD COLUMN IF NOT EXISTS superseded_by_deployment_id UUID REFERENCES cloud_deployments(id) ON DELETE SET NULL;

ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS trigger_kind TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE cloud_deployments DROP CONSTRAINT IF EXISTS cloud_deployments_trigger_kind_check;

ALTER TABLE cloud_deployments
  ADD CONSTRAINT cloud_deployments_trigger_kind_check CHECK (trigger_kind IN ('manual','evolution_merge','rollback'));

CREATE INDEX IF NOT EXISTS idx_cloud_deployments_lineage
  ON cloud_deployments (lineage_root_id, created_at DESC);

-- Backfill: para linhas pre-evolucao a raiz da linhagem e o proprio projeto.
UPDATE cloud_deployments d SET lineage_root_id = d.project_id WHERE lineage_root_id IS NULL;
