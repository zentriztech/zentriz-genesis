-- Migration 079: D3 (decisão do Jean, 2026-09-04) — retorno HUMANO real da fábrica à Bancada.
--
-- Antes: um NEEDS_INFO do CTO era "respondido" pelo Engineer (outro LLM) e o pipeline seguia
-- ("usando última versão do Charter") — a proteção "não inventar requisitos" era anulada; não
-- existia nenhum status de espera humana além do expo-confirm. Agora o runner PARA no NEEDS_INFO,
-- grava as perguntas, notifica o tenant (in-app + e-mail) e retoma do checkpoint quando respondido.
--
-- NOTA runner de migrations: split ingênuo por ';' — sem ';' em literais, sem blocos DO/$$.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'queued', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  'blocked_structural_gate',
  'blocked_backlog_empty_with_frs',
  'blocked_awaiting_expo_confirm',
  'needs_spec_input'
));

CREATE TABLE IF NOT EXISTS project_questions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round        INTEGER NOT NULL DEFAULT 1,
  stage        TEXT NOT NULL DEFAULT 'spec_review',
  questions    JSONB NOT NULL DEFAULT '[]',
  asked_by     TEXT NOT NULL DEFAULT 'cto',
  answer       TEXT,
  answered_by  UUID,
  answered_at  TIMESTAMPTZ,
  notified_at  TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_questions_by_project ON project_questions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_questions_open ON project_questions (created_at) WHERE answered_at IS NULL;

-- Notificação in-app ao tenant (a página /notifications já existe): tipo novo.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('project_finished', 'provisioning_done', 'blocked', 'alert', 'spec_question'));
