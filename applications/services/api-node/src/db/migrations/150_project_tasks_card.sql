-- 150 — Fase 2 (tarefa 2.3) do plano EVOLUIR-PROJETO-BANCADA: vinculo da TASK com o card e com o arquivo de spec de origem.
-- Aditiva e idempotente. Somente esquema: quem preenche e o runner na Fase 4 (tarefa 4.2). O formato do task_id NAO muda
-- (o regex de backlog do runner continua o mesmo).
--
--   * card_id: ticket (card) que originou a task. ON DELETE SET NULL: apagar o card nao apaga a task.
--   * origin_spec_file: caminho relativo (rel_dir/filename) do arquivo de spec que originou a task.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS card_id UUID REFERENCES tickets(id) ON DELETE SET NULL;

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS origin_spec_file TEXT;

CREATE INDEX IF NOT EXISTS idx_project_tasks_card ON project_tasks (card_id) WHERE card_id IS NOT NULL;
