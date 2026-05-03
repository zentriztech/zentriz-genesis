-- Migration 017: Monitor Autônomo BLOCKED Tasks (FT-11)
-- Coluna para evitar loop: Monitor só é chamado uma vez por task BLOCKED.

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS monitor_attempted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN project_tasks.monitor_attempted IS 'FT-11: true após Monitor Autônomo tentar resolver esta task. Evita chamada dupla.';
