-- 134_skill_feedback_idempotency.sql
-- Plano de evolucao v2, tarefas 1.1 e 1.2 (ADR-025). Tudo ADITIVO, usado so com SKILL_FEEDBACK em shadow ou on.
-- Rollback e por flag (SKILL_FEEDBACK=off), nao por migration.
--
-- NOTA runner de migrations: sem ponto e virgula em literais, sem blocos DO.

-- 1. Chave de idempotencia do feedback: projeto, task, skill e sinal. Repetir o mesmo sinal nao conta duas vezes.
ALTER TABLE skill_feedback ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_feedback_idempotency
  ON skill_feedback (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2. Sinais novos. Fortes (oraculo externo ou humano) podem transitar estado. Fracos so ajustam o score informativo.
ALTER TABLE skill_feedback DROP CONSTRAINT IF EXISTS skill_feedback_signal_check;

ALTER TABLE skill_feedback ADD CONSTRAINT skill_feedback_signal_check CHECK (
  signal IN ('qa_pass','qa_fail','cyborg_reject','bug_recurrence','human_fix','human_approve',
             'oracle_pass','oracle_fail','human_reject')
);

-- 3. Quais licoes entraram no prompt de qual task (registrado pelo runtime quando o CAG esta live).
CREATE TABLE IF NOT EXISTS lesson_injection (
  project_id   UUID        NOT NULL,
  task_id      TEXT        NOT NULL,
  lesson_slug  TEXT        NOT NULL,
  injected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, task_id, lesson_slug)
);

-- 4. Eventos de acerto de licao. A chave primaria impede dupla contagem em retry.
CREATE TABLE IF NOT EXISTS lesson_hit_event (
  idempotency_key TEXT        PRIMARY KEY,
  lesson_slug     TEXT        NOT NULL,
  project_id      UUID,
  signal          TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE lesson_injection IS 'Licoes injetadas no prompt por projeto e task. Insumo do hit_count idempotente (ADR-025).';
COMMENT ON TABLE lesson_hit_event IS 'Um acerto por projeto, licao e sinal de oraculo. Chave com prefixo shadow nao altera hit_count.';
