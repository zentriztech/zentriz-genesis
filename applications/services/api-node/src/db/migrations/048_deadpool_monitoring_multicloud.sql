-- 048 — Monitoramento Deadpool multi-cloud (M1/M2).
-- Persiste a nuvem monitorada por projeto + os ponteiros de escopo por nuvem, para que o painel
-- lembre a escolha e a reativação seja idempotente. Fonte de verdade do POLLING é o registry do
-- Deadpool; estas colunas espelham a config para exibição/reativação no Genesis.
-- Aditivo e idempotente (ADD COLUMN IF NOT EXISTS) — ausência = CloudWatch (retrocompat feature #1).

ALTER TABLE project_deadpool_monitoring
  ADD COLUMN IF NOT EXISTS monitor_provider     TEXT,
  ADD COLUMN IF NOT EXISTS azure_workspace_id   TEXT,
  ADD COLUMN IF NOT EXISTS azure_table          TEXT,
  ADD COLUMN IF NOT EXISTS azure_message_column TEXT,
  ADD COLUMN IF NOT EXISTS gcp_project_id       TEXT,
  ADD COLUMN IF NOT EXISTS gcp_log_filter       TEXT;

COMMENT ON COLUMN project_deadpool_monitoring.monitor_provider IS 'Nuvem monitorada: cloudwatch (default) | azure | gcp. Linhas ativadas pós-048 gravam o valor explícito (inclusive cloudwatch); NULL só em linhas legadas pré-048.';
