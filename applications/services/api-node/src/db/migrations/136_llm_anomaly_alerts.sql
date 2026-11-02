-- 136_llm_anomaly_alerts.sql
-- Plano de evolucao v2, tarefa 1.6 (alerta estatistico de anomalia de custo/uso de LLM).
-- Tudo ADITIVO. Tabela nova e independente: o LLM Guard NAO le esta tabela e nenhum alerta altera o corte dele.
-- So e escrita com ANOMALY_ALERTS em shadow ou on. Com off nada e escrito.
-- Sem PII: scope_hash e um hash curto do id (tenant ou projeto), nunca o id em claro nem nome/e-mail.
-- Rollback e por flag (ANOMALY_ALERTS=off), nao por migration.
--
-- NOTA runner de migrations: sem ponto e virgula em literais ou comentarios, sem blocos DO.

CREATE TABLE IF NOT EXISTS llm_anomaly_alerts (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Hora (inicio do balde) a que a anomalia se refere.
  detected_at TIMESTAMPTZ NOT NULL,
  -- shadow = so registrado, on = registrado e notificado quando ha canal.
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
  detector TEXT NOT NULL CHECK (detector IN ('ewma', 'cusum', 'mad', 'repeat_payload', 'stalled_run')),
  metric TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'project')),
  scope_hash TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  value NUMERIC(18,6),
  baseline NUMERIC(18,6),
  threshold NUMERIC(18,6),
  score NUMERIC(18,6),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  notified BOOLEAN NOT NULL DEFAULT false,
  -- Idempotencia: o mesmo alerta (detector, escopo, janela de cooldown) nunca duplica.
  dedupe_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_anomaly_alerts_dedupe ON llm_anomaly_alerts (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_llm_anomaly_alerts_detected ON llm_anomaly_alerts (detected_at);
CREATE INDEX IF NOT EXISTS idx_llm_anomaly_alerts_scope ON llm_anomaly_alerts (scope, scope_hash, detected_at);
