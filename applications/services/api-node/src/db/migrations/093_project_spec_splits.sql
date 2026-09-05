-- 093 — F2/PR-3: proposta de DIVISAO da spec monolitica em varios arquivos.
--
-- Causa (medida em prod 2026-09-05): a spec do NVX LastMile tem 98.045 chars num unico arquivo. Toda
-- revisao do CTO reemitia o documento inteiro e batia no teto de 64.000 tokens de SAIDA do Opus 5 —
-- `stop_reason=max_tokens` voltava como `status: OK` e o modo autonomo aplicava a spec mutilada
-- (14 -> 7 secoes). Repartida por tema, cada rodada de melhoria toca UM arquivo e cabe com folga.
--
-- A divisao e AGENTICA (arquiteto decide a estrutura + 1 redator por arquivo) e segue o guardrail do
-- ADR-018 / product_proposals: PROPOE, nunca grava. A proposta vive aqui ate o humano aplicar ou
-- descartar na Bancada — o job nasce persistido (licao do spec_chat_jobs efemero, migration 089:
-- job em memoria morre em todo deploy e o trabalho do LLM e jogado fora).
--
-- `source_sha` congela o arquivo primario no instante da proposta: se a spec mudou entre propor e
-- aplicar, o apply recusa (409) em vez de sobrescrever trabalho novo com um plano velho.
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios em linha propria.
CREATE TABLE IF NOT EXISTS project_spec_splits (
  id              UUID PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id       UUID,
  owner_user_id   UUID,
  agents_job_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  source_path     TEXT,
  source_sha      TEXT,
  source_chars    INTEGER NOT NULL DEFAULT 0,
  produced_chars  INTEGER NOT NULL DEFAULT 0,
  payload         JSONB,
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  error           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  model_used      TEXT,
  deadline_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  applied_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pspl_status_chk CHECK (status IN ('pending','running','done','error','interrupted','applied','discarded'))
);

CREATE INDEX IF NOT EXISTS pspl_by_project ON project_spec_splits(project_id, created_at DESC);

-- Uma proposta VIVA por projeto: duas divisoes simultaneas do mesmo arquivo primario colidiriam na
-- escrita (a segunda aplicaria sobre a arvore que a primeira acabou de criar).
CREATE UNIQUE INDEX IF NOT EXISTS pspl_one_live ON project_spec_splits(project_id) WHERE status IN ('pending','running');
