-- Migration 057: Item 2 — Claude escolhido por projeto + deploy permanente.
-- (a) projects.llm_config_priority: slot LLM (0-3) fixado para a EXECUÇÃO do projeto.
--     NULL = comportamento atual (resolve por ordem de prioridade, Padrão primeiro).
--     Consumido por resolveProjectLlmConfig (run/evolve/deploy usam o mesmo Claude).
-- (b) ephemeral_deployments.expires_at passa a aceitar NULL = deploy PERMANENTE (nunca
--     expira por idade). Precedente: backend_deployments.expires_at já é nullable=durable
--     (033). O s3CleanupWorker usa `expires_at < now()` — NULL nunca casa, então permanente
--     sobrevive naturalmente à limpeza por TTL.
-- Nenhum ';' dentro de literal de string (guard do runner de migrations).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS llm_config_priority SMALLINT
    CHECK (llm_config_priority IS NULL OR llm_config_priority BETWEEN 0 AND 3);

ALTER TABLE ephemeral_deployments
  ALTER COLUMN expires_at DROP NOT NULL;
