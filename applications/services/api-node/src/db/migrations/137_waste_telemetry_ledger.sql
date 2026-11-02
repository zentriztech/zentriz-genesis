-- 137_waste_telemetry_ledger.sql
-- Plano de evolucao v2, tarefa 1.4 (telemetria de desperdicio). Tudo ADITIVO e NULLABLE.
-- Motivo da chamada de LLM: primary, retry, repair, rework, escalation, support.
-- So e escrito com WASTE_TELEMETRY em shadow ou on. Com off nenhuma coluna nova e escrita.
-- Sem backfill historico: linhas anteriores ficam com NULL (motivo nao medido, diferente de primary).
-- Rollback e por flag (WASTE_TELEMETRY=off), nao por migration.
-- Numeracao: 135 e a ultima desta linha, 136 esta reservada para a tarefa 1.6.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

-- call_reason e o motivo da chamada. call_idem_key e a chave projeto, task, etapa e tentativa:
-- retry de rede repete a chave e a analise o conta como UMA chamada de negocio.
-- Sem UNIQUE de proposito: o ledger e fonte de gasto real, nenhuma linha paga e descartada.
ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS call_reason TEXT;
ALTER TABLE llm_call_ledger ADD COLUMN IF NOT EXISTS call_idem_key TEXT;

-- Sem CHECK de proposito: valor desconhecido e normalizado para NULL na aplicacao (nunca quebra o registro).
CREATE INDEX IF NOT EXISTS idx_llm_ledger_reason ON llm_call_ledger (call_reason, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_ledger_idem ON llm_call_ledger (call_idem_key, created_at);
