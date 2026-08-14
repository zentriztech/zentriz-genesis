-- Migration 047: registros de aprovacao de PROMOCAO do Deadpool (RFC-028 / ADR-024 Fase C).
--
-- Contexto: sob autonomia por ambiente (flag DEADPOOL_ALLOW_ENV_SCOPED_AUTONOMY no Deadpool),
--   dev libera merge+deploy sob gates verdes, mas staging/prod exigem um REGISTRO DE APROVACAO
--   humano emitido por este portal (RBAC tenant_admin/zentriz_admin). O guardrail R7/R9 do Deadpool
--   e FAIL-CLOSED: sem registro valido (decision=approved, ambiente/acao/incidente/repo casando,
--   janela nao expirada), a promocao e bloqueada.
--
-- deadpool_promotion_approvals: uma linha por pedido de promocao. Ciclo: pending -> approved|rejected.
--   target_environment: ambiente-alvo que a aprovacao autoriza (staging/prod e sinonimos).
--   actions: acoes autorizadas — 'promote' (cobre merge+deploy) ou lista separada por virgula.
--   expires_at: janela opcional; o Deadpool so honra registros nao expirados quando recebe o relogio.
--
-- Formato: runner (db/init.ts) faz split ingenuo por ';' e remove linhas iniciadas por '--'.
-- Sem literais contendo ';'. (Aspas simples em CHECK sao OK.)

CREATE TABLE IF NOT EXISTS deadpool_promotion_approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  incident_id        TEXT,
  repo_url           TEXT,
  target_environment TEXT NOT NULL CHECK (target_environment IN ('staging', 'stage', 'homolog', 'prod', 'production')),
  actions            TEXT NOT NULL DEFAULT 'promote',
  decision           TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  requested_by       UUID REFERENCES users(id),
  decided_by         UUID REFERENCES users(id),
  decided_by_role    TEXT,
  reason             TEXT,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deadpool_promotion_approvals_project
  ON deadpool_promotion_approvals(project_id, decision);

CREATE INDEX IF NOT EXISTS idx_deadpool_promotion_approvals_tenant
  ON deadpool_promotion_approvals(tenant_id, decision);

COMMENT ON TABLE deadpool_promotion_approvals IS 'Aprovacoes humanas de promocao Deadpool para staging/prod (RFC-028 Fase C). Consumidas pelo guardrail R7/R9 fail-closed.';
