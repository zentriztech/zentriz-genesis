-- 013: tabela de gatilhos de pipeline entre projetos dentro de um produto
-- Quando projeto trigger_project_id atingir trigger_status,
-- o projeto project_id inicia automaticamente.

CREATE TABLE IF NOT EXISTS project_triggers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_status    TEXT NOT NULL DEFAULT 'accepted',
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT project_triggers_no_self CHECK (project_id <> trigger_project_id),
  CONSTRAINT project_triggers_unique UNIQUE (project_id, trigger_project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_triggers_trigger ON project_triggers(trigger_project_id, trigger_status);
CREATE INDEX IF NOT EXISTS idx_project_triggers_project ON project_triggers(project_id);
