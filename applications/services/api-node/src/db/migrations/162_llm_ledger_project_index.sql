-- AN/M7: índice em llm_call_ledger(project_id). `cardSpentUsd` (todo preflight de card com política) e as métricas dos cards
-- (`cardMetrics.ts`, junção por project_id) somavam o ledger SEM índice nesta coluna (só existia budget_project_id, migration 131).
-- Aditiva e idempotente; sem transação; sem blocos DO.
CREATE INDEX IF NOT EXISTS idx_llm_ledger_project ON llm_call_ledger (project_id);
