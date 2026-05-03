-- 014: adicionar 'test' e 'infra' como valores válidos para project_tasks.module
-- Necessário para TSK-FULL-TEST e TSK-DEVOPS-001

ALTER TABLE project_tasks DROP CONSTRAINT IF EXISTS project_tasks_module_check;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_module_check
  CHECK (module = ANY (ARRAY['backend','web','mobile','test','infra']));
