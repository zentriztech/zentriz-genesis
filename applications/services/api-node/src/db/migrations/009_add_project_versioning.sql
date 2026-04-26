-- Migration 009: project versioning — link v2/v3 back to the original project
-- parent_project_id: points to the project this was derived from (null = root/v1)
-- version_number: 1-based counter within a product lineage

ALTER TABLE projects ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project_id);
