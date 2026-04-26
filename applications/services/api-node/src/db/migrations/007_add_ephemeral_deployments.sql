-- Migration 007: ephemeral cloud deployments (Fly.io + AWS ECS Fargate)
-- Each row represents a temporary deployment of a generated project.
-- Deployments expire after TTL; the watchdog destroys them automatically.

CREATE TABLE IF NOT EXISTS ephemeral_deployments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('fly', 'ecs', 'mock')),
  machine_id   TEXT,                          -- Fly machine ID or ECS task ARN
  app_name     TEXT,                          -- Fly app name or ECS service name
  image_tag    TEXT,                          -- Docker image tag used
  app_url      TEXT,                          -- public URL (e.g. https://xxx.fly.dev)
  status       TEXT NOT NULL DEFAULT 'provisioning'
               CHECK (status IN ('provisioning', 'running', 'failed', 'destroying', 'destroyed')),
  ttl_minutes  INTEGER NOT NULL DEFAULT 30,
  expires_at   TIMESTAMPTZ NOT NULL,
  destroyed_at TIMESTAMPTZ,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_project   ON ephemeral_deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_ephemeral_status    ON ephemeral_deployments(status, expires_at);
