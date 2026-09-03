-- 075 — RFC-0004 Onda 5 (F5): severidade nas mensagens do pipeline.
-- project_dialogue tinha so event_type — "1-3 ultimas mensagens importantes" do dashboard
-- precisa de taxonomia. ADD COLUMN com default estatico e metadata-only (PG>=11, sem scan);
-- SEM CHECK (validaria a tabela inteira no boot — hot path). Valores: info|notice|warning|critical.
--
-- Backfill heuristico DETERMINISTICO (mesma regra do fallback no summary — auditoria F7):
-- erros/escalations = critical; product_ready = notice; cyborg = warning; resto = info.
-- INSERTs diretos legados continuam nascendo 'info' — o summary aplica a MESMA heuristica
-- por event_type como fallback, entao nada some do card.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.

ALTER TABLE project_dialogue ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info';

UPDATE project_dialogue SET severity = 'critical'
 WHERE severity = 'info' AND event_type IN ('error', 'escalation');

UPDATE project_dialogue SET severity = 'notice'
 WHERE severity = 'info' AND event_type = 'product_ready';

UPDATE project_dialogue SET severity = 'warning'
 WHERE severity = 'info' AND from_agent = 'cyborg';

-- indice parcial p/ o LATERAL "ultimas 3 importantes" do dashboard
CREATE INDEX IF NOT EXISTS idx_project_dialogue_important
  ON project_dialogue (project_id, created_at DESC)
  WHERE severity IN ('notice', 'warning', 'critical');
