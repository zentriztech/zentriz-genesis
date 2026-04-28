-- Migration 012: pipeline runs history + consolidated metrics on projects
-- pipeline_runs: each start/stop cycle of the runner for a project
-- projects: complexity_hint, finished_at, run_count, total_duration_sec

-- Tabela de histórico de execuções do pipeline
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL,           -- ex: "abc123-run-001"
  request_id       TEXT,                    -- UUID da requisição que disparou o run
  trigger          TEXT NOT NULL DEFAULT 'api' CHECK (trigger IN ('api', 'manual', 'retry', 'resume')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  duration_sec     INTEGER,                 -- calculado no stop; null se interrompido
  stop_reason      TEXT CHECK (stop_reason IN (
    'completed', 'accepted', 'stopped', 'sigterm', 'timeout', 'error', 'api_unreachable', 'interrupted'
  )),
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project    ON pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_ts ON pipeline_runs(project_id, started_at DESC);

-- Campos de métricas consolidadas e complexidade no projeto
ALTER TABLE projects ADD COLUMN IF NOT EXISTS complexity_hint TEXT
  CHECK (complexity_hint IN ('trivial', 'low', 'medium', 'high'));

ALTER TABLE projects ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS run_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS total_duration_sec INTEGER NOT NULL DEFAULT 0;

-- Atualizar constraint de status para incluir 'archived' caso migration 004 não tenha rodado
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'completed', 'failed', 'running', 'stopped', 'accepted', 'archived'
));
