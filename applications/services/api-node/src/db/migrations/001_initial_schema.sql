-- Migration 001: baseline schema
-- All tables created from scratch; safe to run on empty DB.

CREATE TABLE IF NOT EXISTS plans (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  max_projects INTEGER NOT NULL DEFAULT 3,
  max_users_per_tenant INTEGER NOT NULL DEFAULT 5
);

INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant) VALUES
  ('plan_prata',    'Prata',    'prata',    3,  5),
  ('plan_ouro',     'Ouro',     'ouro',     10, 20),
  ('plan_diamante', 'Diamante', 'diamante', 50, 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  tenant_id     UUID REFERENCES tenants(id),
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'tenant_admin', 'zentriz_admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  created_by      UUID NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  spec_ref        TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
    'dev_qa', 'devops', 'running', 'stopped', 'completed', 'failed', 'accepted'
  )),
  charter_summary  TEXT,
  backlog_summary  TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant     ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);

CREATE TABLE IF NOT EXISTS project_spec_files (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  mime_type  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_spec_files_project ON project_spec_files(project_id);

CREATE TABLE IF NOT EXISTS project_dialogue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_agent    TEXT NOT NULL,
  to_agent      TEXT NOT NULL,
  event_type    TEXT,
  summary_human TEXT NOT NULL,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_dialogue_project ON project_dialogue(project_id);
CREATE INDEX IF NOT EXISTS idx_project_dialogue_created ON project_dialogue(project_id, created_at);

CREATE TABLE IF NOT EXISTS project_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      TEXT NOT NULL,
  module       TEXT NOT NULL DEFAULT 'backend' CHECK (module IN ('backend', 'web', 'mobile')),
  owner_role   TEXT NOT NULL CHECK (owner_role IN (
    'DEV_BACKEND', 'QA_BACKEND', 'DEVOPS_DOCKER', 'DEV_WEB', 'QA_WEB', 'DEV_MOBILE', 'QA_MOBILE',
    'DEV', 'QA', 'DEVOPS', 'MONITOR', 'ENGINEER', 'CTO', 'PM'
  )),
  requirements TEXT,
  status       TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN (
    'NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_REVIEW', 'QA_FAIL', 'QA_PASS', 'BLOCKED', 'DONE', 'CANCELLED'
  )),
  artifacts_ref TEXT,
  evidence      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project        ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status ON project_tasks(project_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  type       TEXT NOT NULL CHECK (type IN ('project_finished', 'provisioning_done', 'blocked', 'alert')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_github_installations (
  tenant_id         UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id   BIGINT NOT NULL,
  github_login      TEXT NOT NULL,
  installation_type TEXT NOT NULL DEFAULT 'Organization' CHECK (installation_type IN ('Organization', 'User')),
  repos_authorized  TEXT NOT NULL DEFAULT 'all' CHECK (repos_authorized IN ('all', 'selected')),
  selected_repos    TEXT[] NOT NULL DEFAULT '{}',
  scope_genesis     BOOLEAN NOT NULL DEFAULT true,
  scope_deadpool    BOOLEAN NOT NULL DEFAULT true,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_github_installations_installation ON tenant_github_installations(installation_id);
