-- C3' (desenho 27, §3.4): políticas de custo de LLM versionadas, com histórico e trilha de auditoria.
-- O Guard (services/llmGuard.ts) LÊ desta tabela. Sem linha, nada muda no comportamento atual.
-- Idempotente; sem transação; sem blocos DO.
CREATE TABLE IF NOT EXISTS cost_policies (
  id            BIGSERIAL PRIMARY KEY,
  scope_type    TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'tenant')),
  scope_id      TEXT NOT NULL DEFAULT '',
  policy_key    TEXT NOT NULL,
  pct           NUMERIC(5,2) CHECK (pct IS NULL OR (pct >= 1 AND pct <= 100)),
  base          TEXT,
  floor_usd     NUMERIC(14,4) CHECK (floor_usd IS NULL OR floor_usd > 0),
  abs_cap_usd   NUMERIC(14,4) CHECK (abs_cap_usd IS NULL OR abs_cap_usd > 0),
  value_usd     NUMERIC(14,4) CHECK (value_usd IS NULL OR value_usd > 0),
  calibrated    BOOLEAN NOT NULL DEFAULT false,
  calibrated_at TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'manual',
  version       INTEGER NOT NULL DEFAULT 1,
  author        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cost_policies_scope_uq UNIQUE (scope_type, scope_id, policy_key)
);
CREATE TABLE IF NOT EXISTS cost_policy_history (
  id          BIGSERIAL PRIMARY KEY,
  policy_id   BIGINT NOT NULL,
  scope_type  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  policy_key  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  before_state JSONB,
  after_state  JSONB,
  author      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_policy_history_key ON cost_policy_history (scope_type, scope_id, policy_key, version);
