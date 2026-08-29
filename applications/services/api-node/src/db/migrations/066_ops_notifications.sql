-- 066_ops_notifications.sql
-- Idempotência das notificações operacionais por e-mail ao time Zentriz (opsNotify.ts):
-- garante NO MÁXIMO um e-mail por evento (início na fábrica / bloqueio) por projeto.
--   kind = 'factory_start'        -> um e-mail no primeiro start do projeto
--   kind = 'block:' || <status>   -> um e-mail por status de bloqueio distinto
-- DDL pura (sem ';' em literais, sem '--' inline) -> compatível com o runner naïve de migração
-- (db/init.ts faz split por ';'). Aplica no boot da api.

CREATE TABLE IF NOT EXISTS ops_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ops_notifications_uq UNIQUE (project_id, kind)
);

CREATE INDEX IF NOT EXISTS ops_notifications_project_idx ON ops_notifications(project_id);
