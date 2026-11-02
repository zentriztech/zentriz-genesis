-- 138_llm_roles_columns.sql
--
-- Plano de evolucao v2, tarefa 2A.1 — esquema ADITIVO dos tres papeis de modelo por slot:
-- Orchestrator, Advisor e Staff. Decisao explicita: colunas NA MESMA LINHA do slot (tabela filha
-- so depois de reescrever o reorder, que ja foi reescrito em 2A.2).
--
-- Nada existente muda de significado: model_id, model_id_fallback, cyborg_model_id* e verify_*
-- continuam como sao e continuam AUTORITATIVAS enquanto houver agents antigos (dupla escrita).
-- Com LLM_ROLES_MODE=off nenhum caminho de codigo le ou escreve as colunas novas.
--
-- Semantica (ver docs-evo/2A0-semanticas-fallback.md):
--   model_orchestrator  modelo principal do slot (espelha model_id)
--   model_advisor       modelo de escalada por fato duro (espelha model_id_fallback, semanticas 1 e 2)
--                       NULL = sem escalada (D1b), nunca default de plataforma
--   model_staff         modelo barato para apoio. NULL = usa o Orchestrator do mesmo slot (D1)
--   verify_<papel>_*    resultado do ultimo probe real POR PAPEL (padrao da migration 125)
--
-- Restricoes do runner (db/init.ts): split ingenuo por ponto-e-virgula, entao nada de bloco de
-- procedimento e nenhum ponto-e-virgula dentro de literal. Sem "down".

ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS model_orchestrator TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS model_advisor TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS model_staff TEXT;

ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_orchestrator_status TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_orchestrator_at TIMESTAMPTZ;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_orchestrator_error TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_advisor_status TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_advisor_at TIMESTAMPTZ;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_advisor_error TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_staff_status TEXT;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_staff_at TIMESTAMPTZ;
ALTER TABLE tenant_llm_configs ADD COLUMN IF NOT EXISTS verify_staff_error TEXT;

-- Espelho na conta de gestao (mesma estrutura de slots, migration 126).
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS model_orchestrator TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS model_advisor TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS model_staff TEXT;

ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_orchestrator_status TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_orchestrator_at TIMESTAMPTZ;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_orchestrator_error TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_advisor_status TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_advisor_at TIMESTAMPTZ;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_advisor_error TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_staff_status TEXT;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_staff_at TIMESTAMPTZ;
ALTER TABLE zentriz_llm_config ADD COLUMN IF NOT EXISTS verify_staff_error TEXT;

-- Reorder como UPDATE de prioridade (2A.2). A restricao UNIQUE (tenant_id, priority) nao e
-- DEFERRABLE e nao pode ser, porque o upsert usa ON CONFLICT (tenant_id, priority), que nao aceita
-- arbitro deferivel. Para permutar linhas sem apagar nenhuma, o reorder estaciona as linhas em
-- prioridades negativas (-1 a -4) dentro da transacao. Por isso a faixa permitida passa de 0..3
-- para -4..3. Valores negativos nunca persistem: so existem dentro da transacao do reorder, e as
-- rotas de escrita continuam validando 0..3 antes de tocar o banco.
ALTER TABLE tenant_llm_configs DROP CONSTRAINT IF EXISTS tenant_llm_configs_priority_check;
ALTER TABLE tenant_llm_configs ADD CONSTRAINT tenant_llm_configs_priority_check CHECK (priority BETWEEN -4 AND 3);
ALTER TABLE zentriz_llm_config DROP CONSTRAINT IF EXISTS zentriz_llm_config_priority_range;
ALTER TABLE zentriz_llm_config ADD CONSTRAINT zentriz_llm_config_priority_range CHECK (priority BETWEEN -4 AND 3);

COMMENT ON COLUMN tenant_llm_configs.model_orchestrator IS
  'Papel Orchestrator do slot. Espelha model_id durante a transicao (model_id segue autoritativo).';
COMMENT ON COLUMN tenant_llm_configs.model_advisor IS
  'Papel Advisor do slot. NULL = sem escalada. Espelha model_id_fallback (semanticas 1 e 2) durante a transicao.';
COMMENT ON COLUMN tenant_llm_configs.model_staff IS
  'Papel Staff do slot. NULL = usa o Orchestrator do mesmo slot, declarado no ledger.';
