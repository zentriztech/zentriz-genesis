-- Migration 088: rastreabilidade do handoff de monitoramento entre versoes de uma linhagem.
-- Bloco 4 (M3) — Auto Care pos-merge. Quando uma evolucao vN e mergeada em 'dev', o monitoramento
-- do PAI (project_deadpool_monitoring) migra para o FILHO sem perder historico (o historico do
-- Deadpool e chaveado por service_name/incident_id, nao por project_id). Estas colunas registram a
-- migracao nos dois sentidos para a UI ("Monitoramento migrado para a nova versao" / "herdado da
-- versao anterior") e para auditoria.
--
-- Formato: runner (db/init.ts) faz split ingenuo por ';' e remove linhas iniciadas por '--'.
-- Sem literais contendo ';'. Somente ALTER TABLE ADD COLUMN IF NOT EXISTS e CREATE INDEX.

ALTER TABLE project_deadpool_monitoring
  ADD COLUMN IF NOT EXISTS migrated_to_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE project_deadpool_monitoring
  ADD COLUMN IF NOT EXISTS migrated_from_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pdm_migrated_to
  ON project_deadpool_monitoring (migrated_to_project_id);

COMMENT ON COLUMN project_deadpool_monitoring.migrated_to_project_id IS 'Bloco 4 M3: versao (filho) que assumiu o monitoramento deste projeto apos o merge da evolucao.';
COMMENT ON COLUMN project_deadpool_monitoring.migrated_from_project_id IS 'Bloco 4 M3: versao anterior (pai) da qual este projeto herdou o monitoramento.';
