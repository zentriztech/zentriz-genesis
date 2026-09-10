-- Migration 124: destravar os 4 slots de LLM por tenant (Padrão + 3 Contingências).
--
-- A migration 021 já tinha a intenção certa ("Remove a constraint UNIQUE(tenant_id)"), mas dropou o
-- nome ERRADO: `tenant_llm_configs_tenant_id_key` — o nome que o Postgres geraria sozinho para um
-- UNIQUE de coluna. A 010 criou a constraint com nome EXPLÍCITO:
--
--   CONSTRAINT tenant_llm_configs_tenant_unique UNIQUE (tenant_id)
--
-- Logo o DROP ... IF EXISTS foi um no-op silencioso e a constraint sobreviveu. Resultado medido em
-- prod (2026-09-09): a tela oferece 4 vagas, as rotas fazem ON CONFLICT (tenant_id, priority) e
-- resolveProjectLlmConfig itera priority ASC — mas o INSERT da 2ª vaga sempre falhava, porque
-- UNIQUE (tenant_id) colapsa o tenant em UMA linha só.

ALTER TABLE tenant_llm_configs
  DROP CONSTRAINT IF EXISTS tenant_llm_configs_tenant_unique;

-- Cinto e suspensório: garante o par correto mesmo em bancos que nunca rodaram a 021 por inteiro.
ALTER TABLE tenant_llm_configs
  DROP CONSTRAINT IF EXISTS tenant_llm_configs_tenant_id_key;

-- NÃO usar bloco DO $$ ... $$ aqui: o runner de migrations faz split ingênuo por ponto-e-vírgula e
-- quebraria o corpo do bloco ao meio, derrubando a api em crash-loop. O par correto
-- UNIQUE (tenant_id, priority) já é criado pela migration 021, que roda antes desta.
