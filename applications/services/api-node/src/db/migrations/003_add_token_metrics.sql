-- Migration 003: token and cost metrics per agent call
-- Captures Claude API usage (input_tokens, output_tokens) after each agent invocation.

CREATE TABLE IF NOT EXISTS project_agent_metrics (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent          TEXT NOT NULL,           -- 'CTO', 'Engineer', 'PM', 'Dev', 'QA', 'DevOps', 'Monitor'
  task_id        TEXT,                    -- null for planning-phase agents
  round          INTEGER NOT NULL DEFAULT 1,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  model          TEXT,                    -- 'claude-sonnet-4-6' etc.
  duration_ms    INTEGER,                 -- wall-clock ms for this agent call
  status         TEXT,                    -- 'OK', 'QA_PASS', 'QA_FAIL', 'FAIL', etc.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_metrics_project    ON project_agent_metrics(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_project_ts ON project_agent_metrics(project_id, created_at);
