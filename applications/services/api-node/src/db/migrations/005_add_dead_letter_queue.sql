-- Migration 005: dead letter queue for failed/abandoned pipelines + cost alert tracking

-- project_errors: DLQ for projects that failed permanently (watchdog gave up, circuit breaker, etc.)
CREATE TABLE IF NOT EXISTS project_errors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  error_type    TEXT NOT NULL CHECK (error_type IN (
    'watchdog_gave_up', 'circuit_breaker', 'cost_limit', 'timeout', 'manual', 'other'
  )),
  agent         TEXT,                   -- which agent failed
  task_id       TEXT,                   -- which task was running
  reason        TEXT NOT NULL DEFAULT '',
  extra         JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_errors_project ON project_errors(project_id);
CREATE INDEX IF NOT EXISTS idx_project_errors_type    ON project_errors(error_type, created_at DESC);

-- cost_alert_config: per-tenant budget thresholds
CREATE TABLE IF NOT EXISTS cost_alert_config (
  tenant_id          UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  daily_alert_usd    NUMERIC(10,4) NOT NULL DEFAULT 50.0,
  monthly_alert_usd  NUMERIC(10,4) NOT NULL DEFAULT 500.0,
  alert_enabled      BOOLEAN NOT NULL DEFAULT true,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
