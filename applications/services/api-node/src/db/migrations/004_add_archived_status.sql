-- Migration 004: add 'archived' to projects status constraint
-- Allows admin cleanup endpoint to soft-archive old projects without deleting them.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'stopped', 'completed', 'failed', 'accepted', 'archived'
));
