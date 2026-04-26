-- Migration 006: track GitHub repositories created for accepted projects

CREATE TABLE IF NOT EXISTS project_github_repos (
  project_id      UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repo_name       TEXT NOT NULL,           -- "auto-parts-api"
  repo_full_name  TEXT NOT NULL,           -- "acme-org/auto-parts-api"
  repo_url        TEXT NOT NULL,           -- "https://github.com/acme-org/auto-parts-api"
  clone_url       TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  pushed_at       TIMESTAMPTZ,             -- when files were last pushed
  sha_dev         TEXT,                    -- latest commit SHA on dev branch
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
