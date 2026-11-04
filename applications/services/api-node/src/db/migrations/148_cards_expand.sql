-- 148 — Fase 2 (tarefa 2.1) do plano EVOLUIR-PROJETO-BANCADA: migracao EXPAND do modelo de dados do card. Aditiva e idempotente.
--
-- NAO toca tickets.status (continua open/promoted/delivered/rejected). O estado do card vive em tickets.card_state,
-- NULL = ticket legado (fora da maquina de estados). Nenhum caminho antigo le ou escreve as colunas novas:
-- so o servico cardState.ts e o backfill, e so quando a flag CARDS_BANCADA liga para o tenant.
--
--   * card_state: draft, refining, ready, promoted, in_factory, delivered, blocked, rejected (desenho H secao 4).
--   * blocked_reason: obrigatorio quando card_state = blocked (codigo do sistema, nunca texto livre do usuario).
--   * origin: manual ou import. Decisao do Jean: sem origem Deadpool (o Auto Care nao vira card).
--   * external_ref: referencia opaca para importacao.
--   * draft_project_id: projeto de rascunho (status card_draft) do card. Indice unico parcial no passo de boot em TypeScript.
--   * card_contract_version: versao do contrato do card quando entrou na maquina (1 hoje).
--   * ticket_card_events: auditoria das transicoes de card_state (ator, de-para, motivo, chave de idempotencia).
--   * projects.status ganha card_draft: rascunho do card, SEM versao (version_number 0) e SEM pai.
--
-- A regra de status e um SUPERCONJUNTO da 141: nenhum dado existente viola e o codigo antigo continua valido.
-- NOTA runner de migrations (db/init.ts): split ingenuo por ponto e virgula e sem blocos DO. Nenhum ponto e virgula em literal ou comentario.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS card_state TEXT;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_card_state_check;

ALTER TABLE tickets ADD CONSTRAINT tickets_card_state_check CHECK (card_state IS NULL OR card_state IN (
  'draft', 'refining', 'ready', 'promoted', 'in_factory', 'delivered', 'blocked', 'rejected'
));

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_blocked_reason_check;

ALTER TABLE tickets ADD CONSTRAINT tickets_blocked_reason_check CHECK (card_state IS DISTINCT FROM 'blocked' OR blocked_reason IS NOT NULL);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_origin_check;

ALTER TABLE tickets ADD CONSTRAINT tickets_origin_check CHECK (origin IN ('manual', 'import'));

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_ref TEXT;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS draft_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS card_contract_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_tickets_card_state ON tickets (tenant_id, card_state) WHERE card_state IS NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id UUID,
  reason TEXT,
  child_project_id UUID,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tce_ticket ON ticket_card_events (ticket_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tce_dedupe ON ticket_card_events (ticket_id, to_state, dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'queued', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  'blocked_structural_gate',
  'blocked_backlog_empty_with_frs',
  'blocked_awaiting_expo_confirm',
  'needs_spec_input',
  'promoted',
  'materializing',
  'card_draft'
));

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_card_draft_shape_check;

ALTER TABLE projects ADD CONSTRAINT projects_card_draft_shape_check CHECK (status <> 'card_draft' OR (version_number = 0 AND parent_project_id IS NULL));
