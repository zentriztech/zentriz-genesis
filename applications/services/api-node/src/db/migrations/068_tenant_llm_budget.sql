-- 068_tenant_llm_budget.sql
-- Parte A (cost cap por TENANT — anti denial-of-wallet):
--   tenants.monthly_llm_budget_usd -> teto mensal em USD para o tenant (NULL = herda plano/env)
--   plans.monthly_llm_budget_usd   -> default por plano (NULL = sem cap)
-- Precedência: tenant > plano > env TENANT_MONTHLY_LLM_BUDGET_USD_DEFAULT (unset/0 = sem cap).
-- Enforcement em services/tenantCostCap.ts (fail-open deliberado em erro de infra).
--
-- Parte B (value meter MVP INTERNO — spec docs/06-recommendations/2026-08-20-value-meter-spec.md):
--   value_events: tabela APPEND-ONLY de eventos de valor de cliente (nenhum UPDATE em código).
--   O contrato value-event.v1.json no Connect fica para follow-up com ADR (ADR-002).
--
-- Idempotente + forward-only. DDL pura: sem ';' dentro de string literal e sem '--' inline
-- (o runner de migrações em db/init.ts faz split ingênuo por ';').

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_llm_budget_usd numeric(10,2);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_llm_budget_usd numeric(10,2);

CREATE TABLE IF NOT EXISTS value_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        REFERENCES tenants(id) ON DELETE SET NULL,
  project_id uuid,
  event_type text        NOT NULL,
  source     text        NOT NULL DEFAULT 'genesis',
  quantity   numeric(12,4) NOT NULL DEFAULT 1,
  unit       text        NOT NULL DEFAULT 'count',
  metadata   jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_value_events_tenant_created
  ON value_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_value_events_type_created
  ON value_events (event_type, created_at DESC);

COMMENT ON TABLE value_events IS
  'Value meter MVP interno (spec 2026-08-20): eventos de valor append-only por tenant. Sem UPDATE em codigo. Contrato Connect fica para follow-up com ADR.';
