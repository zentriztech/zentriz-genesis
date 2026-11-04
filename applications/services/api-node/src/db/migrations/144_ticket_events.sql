-- 144 — Tarefa 1.4 (EVOLUIR-PROJETO-BANCADA, Fase 1'): auditoria das transicoes de ticket. Aditiva e idempotente.
-- Uma linha por transicao de `tickets.status` aplicada com TICKET_TRANSITIONS=on (padrao off: a tabela fica vazia).
--   * actor_kind: user (PATCH humano) ou system (claim do /evolve, descarte do filho). actor_id e UUID, sem PII.
--   * reason: codigo curto do sistema (ex. child_discarded, materialization_failed), nunca texto livre do usuario.
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

CREATE TABLE IF NOT EXISTS ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id UUID,
  reason TEXT,
  child_project_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket_id, created_at);
