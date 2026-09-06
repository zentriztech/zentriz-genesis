-- 096 — G7/A3.3: a BANCADA passa a aprender (produtor de licoes do laco autonomo).
-- Medicao em prod (2026-09-05): `lessons_corpus` = 0 linhas. O unico produtor de licao era o
-- Cyborg (accept/reject de uma ENTREGA), logo o laco de refinamento de spec — onde um validador
-- adversarial aponta GAPs e o CTO reescreve — nao deixava aprendizado nenhum.
-- Ao terminar (qualquer status terminal), a run e reclamada UMA vez pelo worker da Bancada, que
-- monta o relatorio do episodio e chama /invoke/lesson_extract/async no agents (quem decide o que
-- e licao e o MODELO — LEI 100% LLM; o codigo so transporta e veta contaminacao).
-- Semantica das colunas novas:
--   learning_kicked_at  quando o worker RECLAMOU a run (claim idempotente: uma extracao por run)
--   learning_job_id     job assincrono no agents (para o poll do tick seguinte)
--   learning_result     telemetria do episodio: mode/extracted/persisted/slugs/indexer ou o erro
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios so em
-- linha propria, sem blocos DO/$$.
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS learning_kicked_at TIMESTAMPTZ;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS learning_job_id TEXT;
ALTER TABLE spec_autonomy_runs ADD COLUMN IF NOT EXISTS learning_result JSONB;
-- Indice parcial: a varredura do tick procura exatamente as runs terminadas e ainda nao reclamadas.
CREATE INDEX IF NOT EXISTS idx_spec_autonomy_learning_pending
  ON spec_autonomy_runs (finished_at)
  WHERE learning_kicked_at IS NULL AND finished_at IS NOT NULL;
-- Segunda fase do tick: as reclamadas que ainda esperam o resultado do job no agents.
CREATE INDEX IF NOT EXISTS idx_spec_autonomy_learning_polling
  ON spec_autonomy_runs (learning_kicked_at)
  WHERE learning_job_id IS NOT NULL AND learning_result IS NULL;
