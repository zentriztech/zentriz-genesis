-- 145 — Fase 1' (tarefa 1.8): achados do reconciliador do /evolve (EVOLVE_RECONCILER).
--
-- Tudo ADITIVO. Tabela nova e independente: so e escrita com EVOLVE_RECONCILER em shadow ou on. Com off nada e escrito.
-- Um achado por (kind, entity_hash): o UPSERT do job e idempotente (rodar N vezes nao duplica).
-- SEM PII e sem id em claro: project_hash/ticket_hash/entity_hash sao sha256 truncado (16 hex) do id; o operador
-- consulta pelo id em claro e o servidor converte em hash (nao e ecoado). detail guarda so codigos, contagens e idades.
-- Rollback e por flag (EVOLVE_RECONCILER=off), nao por migration.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.
-- (A numeracao pula a 144, reservada a frente de ticket_events.)

CREATE TABLE IF NOT EXISTS evolve_reconciler_findings (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_hash TEXT NOT NULL,
  project_hash TEXT,
  ticket_hash TEXT,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  -- Auditoria da unica acao automatica (limpeza de claim vencido sem efeitos) e do desfecho do achado.
  action_taken TEXT,
  action_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  seen_count INTEGER NOT NULL DEFAULT 1,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evolve_reconciler_findings_entity ON evolve_reconciler_findings (kind, entity_hash);
CREATE INDEX IF NOT EXISTS idx_evolve_reconciler_findings_open ON evolve_reconciler_findings (detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evolve_reconciler_findings_project ON evolve_reconciler_findings (project_hash);
CREATE INDEX IF NOT EXISTS idx_evolve_reconciler_findings_ticket ON evolve_reconciler_findings (ticket_hash);
