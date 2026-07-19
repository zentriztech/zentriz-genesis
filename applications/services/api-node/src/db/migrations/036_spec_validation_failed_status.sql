-- Migration 036: SPEC-APPROVED — status spec_validation_failed
-- Feature "Especificações aprovadas por humanos": quando uma spec marcada como
-- aprovada por humano reprova na validação estrutural (formato PRODUCT_SPEC) ou
-- seu hash diverge da versão aprovada, o runner marca o projeto como
-- spec_validation_failed (não remenda silenciosamente — GAP-3 da auditoria).
-- Expande o CHECK constraint para aceitar o novo status.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed'
));
