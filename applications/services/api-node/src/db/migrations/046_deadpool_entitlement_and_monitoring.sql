-- Migration 046: entitlement de PRODUTO por tenant + estado de monitoramento Deadpool por projeto.
-- Feature #1 "Ativar Monitoramento Deadpool".
--
-- tenant_entitlements: licenca de produto por tenant (genesis|deadpool|connect).
--   Ate aqui a tabela plans so tinha quotas numericas (max_projects, max_users) — nao havia
--   como dizer "tenant X tem Deadpool". Uma linha por (tenant, produto). Linha ausente OU
--   enabled=false = SEM licenca. Extensivel para novos produtos do ecossistema.
-- project_deadpool_monitoring: estado do vinculo ativo de um projeto com o Deadpool
--   (monitoramento ativo de logs + intake reativo de incidentes). Re-disparavel e auditavel.
--
-- Formato: runner (db/init.ts) faz split ingenuo por ';' e remove linhas iniciadas por '--'.
-- Sem literais contendo ';'. (Aspas simples em CHECK/valores sao OK, como no schema.sql.)

CREATE TABLE IF NOT EXISTS tenant_entitlements (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product     TEXT NOT NULL CHECK (product IN ('genesis', 'deadpool', 'connect')),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  granted_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product)
);

CREATE TABLE IF NOT EXISTS project_deadpool_monitoring (
  project_id         UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  active             BOOLEAN NOT NULL DEFAULT false,
  system_id          TEXT,
  service_id         TEXT,
  activated_by       UUID REFERENCES users(id),
  activated_at       TIMESTAMPTZ,
  deactivated_at     TIMESTAMPTZ,
  last_registered_at TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_deadpool_monitoring_active
  ON project_deadpool_monitoring(active) WHERE active = true;

COMMENT ON TABLE tenant_entitlements IS 'Licenca de produto por tenant (genesis|deadpool|connect). Ausente ou enabled=false = sem licenca.';
COMMENT ON TABLE project_deadpool_monitoring IS 'Estado do monitoramento Deadpool por projeto (feature Ativar Monitoramento).';
