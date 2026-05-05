-- Migration 018: Cyborg validation cycle
-- Adds pending_cyborg / blocked_cyborg statuses, cyborg_attempts counter,
-- and cyborg_logs table for real-time progress entries.

-- 1. Expand project status CHECK constraint
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg'
));

-- 2. Cyborg attempt counter
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cyborg_attempts INT NOT NULL DEFAULT 0;

-- 3. Cyborg log table — one entry per heartbeat / step posted by the Cyborg
CREATE TABLE IF NOT EXISTS cyborg_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attempt       INT         NOT NULL DEFAULT 1,
  message       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cyborg_logs_project ON cyborg_logs(project_id, attempt, created_at DESC);
