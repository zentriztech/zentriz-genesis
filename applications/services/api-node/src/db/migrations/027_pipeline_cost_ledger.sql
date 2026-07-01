-- T18: pipeline_cost_ledger + gate MAX_USD_PER_PROJECT
-- Rastreia tokens/USD por chamada de agente, permitindo gate de custo por projeto.
-- Idempotente + forward-only (não usa DROP).

CREATE TABLE IF NOT EXISTS pipeline_cost_ledger (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent        text        NOT NULL,             -- 'cto' | 'engineer' | 'pm' | 'dev' | 'qa' | 'devops' | 'monitor' | 'cyborg'
  request_id   text        NOT NULL,
  model        text        NOT NULL,             -- 'us.anthropic.claude-sonnet-4-6' etc.
  tokens_in    integer     NOT NULL DEFAULT 0,
  tokens_out   integer     NOT NULL DEFAULT 0,
  usd_cost     numeric(10,6) NOT NULL DEFAULT 0,
  duration_ms  integer     NOT NULL DEFAULT 0,
  status       text        NOT NULL,             -- 'ok' | 'fail' | 'blocked' etc.
  ts           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cost_project
  ON pipeline_cost_ledger (project_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_cost_agent_ts
  ON pipeline_cost_ledger (agent, ts DESC);

COMMENT ON TABLE pipeline_cost_ledger IS
  'T18: telemetria de custo por chamada de agente. Suporta gate MAX_USD_PER_PROJECT no runner (env var). Baseline pós-incidente 54967064 (~US$ 2 desperdiçados).';
