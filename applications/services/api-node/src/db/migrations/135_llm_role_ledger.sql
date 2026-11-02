-- 135_llm_role_ledger.sql
-- Plano de evolucao v2, tarefa 1.3 (ledger por papel, transversal). Tudo ADITIVO e NULLABLE.
-- Papeis: orchestrator, advisor, staff. Sem roteamento por papel ainda (isso e a Fase 2A).
-- So e escrito com LLM_ROLES_MODE em shadow ou on. Com off nenhuma coluna nova e escrita.
-- Sem backfill historico: linhas anteriores ficam com NULL (papel nao medido, diferente de orchestrator).
-- Rollback e por flag (LLM_ROLES_MODE=off), nao por migration.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

-- llm_role e o papel EXIGIDO pela chamada. effective_role e o papel realmente usado.
-- escalated_from e o papel de origem quando a chamada foi uma escalada (ex.: rework).
ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS llm_role TEXT;
ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS effective_role TEXT;
ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS escalated_from TEXT;

ALTER TABLE project_agent_metrics ADD COLUMN IF NOT EXISTS llm_role TEXT;

-- Sem CHECK de proposito: valor desconhecido e normalizado para NULL na aplicacao (nunca quebra o registro).
CREATE INDEX IF NOT EXISTS idx_llm_ledger_role ON llm_call_ledger (llm_role, created_at);
