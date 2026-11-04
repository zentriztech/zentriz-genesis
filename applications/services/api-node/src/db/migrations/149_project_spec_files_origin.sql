-- 149 — Fase 2 (tarefa 2.2) do plano EVOLUIR-PROJETO-BANCADA: origem e execucao de cada arquivo de spec. Aditiva e idempotente.
--
--   * spec_origin: initial (spec inicial do produto) ou card:TK-NNNN (arquivo nascido de um card). NULL = ainda nao classificado
--     (todo arquivo existente e todo arquivo gravado por caminho antigo). O backfill (services/specOrigin.ts) preenche NULL
--     quando a flag CARDS_BANCADA liga para o tenant, e e idempotente. O valor card:legacy marca arquivos de evolucao
--     anteriores aos cards.
--   * executed_in_project / executed_at: preenchidos pela Fase 4 (tarefa 4.3) quando o filho e aceito e o PR e mergeado.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS spec_origin TEXT;

ALTER TABLE project_spec_files DROP CONSTRAINT IF EXISTS project_spec_files_spec_origin_check;

ALTER TABLE project_spec_files ADD CONSTRAINT project_spec_files_spec_origin_check CHECK (spec_origin IS NULL OR spec_origin = 'initial' OR spec_origin ~ '^card:[A-Za-z0-9_-]+$');

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS executed_in_project UUID REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_spec_files_origin ON project_spec_files (project_id, spec_origin) WHERE spec_origin IS NOT NULL;
