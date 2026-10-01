-- 131 - LLM GUARD + ORCAMENTO EM DOLAR POR PROJETO (post-mortem 30/09/2026, BRL 90.305,78).
--
-- O incidente: ensureConnectDeclarationsTick (connectDeclaration.ts) reprocessou 3 projetos em
-- blocked_cyborg a ~1 chamada/min de Opus por 22 dias. O teto de tentativas nunca valeu (o SELECT
-- nao lia connect_decl_result) e o gasto era INVISIVEL aos tetos existentes (068 / T18): a chamada
-- vinha por /invoke/raw sem projeto e ninguem debitava o usage.
--
-- Esta migracao cria a FONTE UNICA de controle de gasto, alimentada NO PONTO DA CHAMADA (runtime
-- dos agents), nao por quem lembrar de debitar:
--   * projects.budget_*: orcamento em USD por projeto (Bancada + Fabrica), passo de alerta, pausa.
--     budget_owner_project_id = projeto dono do orcamento (filhos de split dividem o do pai).
--   * llm_call_ledger: 1 linha por chamada de LLM paga, com custo em USD gravado na hora.
--   * llm_guard_events: toda recusa, disjuntor e pausa fica auditavel.
-- Sem orcamento => o guard NEGA (fail-closed). Projetos antigos ficam parados ate alguem definir.
-- NOTA runner de migrations: sem ponto-e-virgula em literais ou comentarios, sem blocos DO/$$.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_usd NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_alert_step_pct SMALLINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_owner_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_paused_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_paused_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_updated_at TIMESTAMPTZ;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_budget_usd_check;
ALTER TABLE projects ADD CONSTRAINT projects_budget_usd_check CHECK (budget_usd IS NULL OR budget_usd >= 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_budget_alert_step_check;
ALTER TABLE projects ADD CONSTRAINT projects_budget_alert_step_check
  CHECK (budget_alert_step_pct IS NULL OR budget_alert_step_pct IN (10, 20, 30, 40, 50));

CREATE INDEX IF NOT EXISTS idx_projects_budget_owner ON projects (budget_owner_project_id);

CREATE TABLE IF NOT EXISTS llm_call_ledger (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  budget_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  tenant_id UUID,
  phase TEXT NOT NULL DEFAULT 'unattributed',
  source TEXT NOT NULL DEFAULT 'agents',
  purpose TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
  prompt_hash TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_llm_ledger_budget ON llm_call_ledger (budget_project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_ledger_hash ON llm_call_ledger (prompt_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_ledger_created ON llm_call_ledger (created_at);

CREATE TABLE IF NOT EXISTS llm_guard_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_llm_guard_events_created ON llm_guard_events (created_at);
CREATE INDEX IF NOT EXISTS idx_llm_guard_events_project ON llm_guard_events (project_id, created_at);

-- Configuracao do guard (chave geral e tetos globais), lida a cada chamada. Tabela propria:
-- genesis_runtime_config tem UNIQUE (key, tenant_id) e NULL nunca conflita (linha duplicada).
CREATE TABLE IF NOT EXISTS llm_guard_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chave geral (kill switch). Comeca LIGADA (on = tudo bloqueado): religar o Genesis nao pode
-- religar o gasto sem um humano decidir. Valor off = liberado (o orcamento por projeto segue valendo).
INSERT INTO llm_guard_settings (key, value, updated_by) VALUES ('kill_switch', 'on', 'migration-131') ON CONFLICT (key) DO NOTHING;

-- Foundry REMOVIDO como provider (decisao do Jean, 01/10/2026). Slots existentes ficam inativos
-- e marcados - nada e apagado (credencial e do tenant, reversivel por um humano).
UPDATE tenant_llm_configs SET is_active = false, updated_at = now() WHERE provider = 'foundry' AND is_active = true;
UPDATE zentriz_llm_config SET is_active = false, updated_at = now() WHERE provider = 'foundry' AND is_active = true;
