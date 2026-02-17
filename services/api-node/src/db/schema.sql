-- Zentriz Genesis — schema para portal (auth, tenants, users, projects, specs)
-- Executar uma vez: psql -U genesis -d zentriz_genesis -f src/db/schema.sql

-- Planos fixos (Prata, Ouro, Diamante)
CREATE TABLE IF NOT EXISTS plans (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  max_projects INTEGER NOT NULL DEFAULT 3,
  max_users_per_tenant INTEGER NOT NULL DEFAULT 5
);

INSERT INTO plans (id, name, slug, max_projects, max_users_per_tenant) VALUES
  ('plan_prata', 'Prata', 'prata', 3, 5),
  ('plan_ouro', 'Ouro', 'ouro', 10, 20),
  ('plan_diamante', 'Diamante', 'diamante', 50, 100)
ON CONFLICT (id) DO NOTHING;

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users (global e por tenant)
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  password_hash TEXT,
  tenant_id  UUID REFERENCES tenants(id),
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'tenant_admin', 'zentriz_admin')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  created_by      UUID NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  spec_ref        TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog', 'dev_qa', 'devops', 'completed', 'failed'
  )),
  charter_summary TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Arquivos de spec por projeto (paths no servidor)
CREATE TABLE IF NOT EXISTS project_spec_files (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  mime_type  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_project_spec_files_project ON project_spec_files(project_id);
