-- 074 — RFC-0004 Onda 3 (F4): validacao adversarial de specs — a FILA E a tabela.
--
-- A "infra de jobs do splitter" e um Map em memoria que morre em todo deploy (auditoria):
-- aqui o job NASCE persistido; o portal faz poll em GET /api/specs/:id/validation; o
-- reaper de boot marca 'running' orfao como 'interrupted'; o watchdog aplica deadline_at.
-- Estado de validacao e DERIVADO (existe run passed p/ o hash atual?) — NUNCA toca
-- projects.status (a migration 040 e o rerun_requested fora do CHECK provaram o custo de
-- mexer no FSM da fabrica).
--
-- governance_audit: trilha de force-promote/ack/validate — finance_audit tem CHECK
-- restrito a entidades financeiras e nao serve.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.

CREATE TABLE IF NOT EXISTS spec_validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  spec_hash TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'passed', 'failed', 'superseded', 'interrupted', 'error'
  )),
  findings JSONB NOT NULL DEFAULT '[]',
  requested_by UUID,
  acked_by UUID,
  acked_role TEXT,
  acked_at TIMESTAMPTZ,
  ack_findings_snapshot JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(project_id, product_id) = 1)
);

-- one-flight: no maximo 1 run pendente/rodando por alvo (2 cliques = 1 run)
CREATE UNIQUE INDEX IF NOT EXISTS svr_one_flight
  ON spec_validation_runs (COALESCE(project_id, product_id))
  WHERE status IN ('pending', 'running');

-- dedupe por conteudo: revalidar hash identico devolve a run verde existente (custo zero)
CREATE UNIQUE INDEX IF NOT EXISTS svr_dedupe_passed
  ON spec_validation_runs (project_id, spec_hash)
  WHERE status = 'passed' AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS svr_by_project ON spec_validation_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS svr_by_product ON spec_validation_runs (product_id, created_at DESC);

-- debounce POR DADO (D1 — desenho fixado; automatico liga depois): PATCHes de spec marcam
-- spec_dirty_at; um tick futuro dispara validacao quando estabilizar. Nao usado no manual.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS spec_dirty_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS governance_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('force_promote', 'ack_findings', 'validate_trigger')),
  project_id UUID,
  product_id UUID,
  spec_hash TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_audit_by_project ON governance_audit (project_id, created_at DESC);
