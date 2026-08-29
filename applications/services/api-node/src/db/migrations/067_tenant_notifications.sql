-- 067_tenant_notifications.sql
-- Idempotência das notificações por e-mail ao TENANT (tenantNotify.ts):
-- garante NO MÁXIMO um e-mail por evento por tenant.
--   kind = 'onboarding_config'  -> um e-mail de boas-vindas + guia de Configurações (PDF)
--                                  na ativação do tenant (status -> active)
-- DDL pura (sem ';' em literais, sem '--' inline) -> compatível com o runner naïve de migração
-- (db/init.ts faz split por ';'). Aplica no boot da api.

CREATE TABLE IF NOT EXISTS tenant_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_notifications_uq UNIQUE (tenant_id, kind)
);

CREATE INDEX IF NOT EXISTS tenant_notifications_tenant_idx ON tenant_notifications(tenant_id);

-- BACKFILL anti-retroação: todo tenant JÁ ativo no momento do deploy é marcado como
-- notificado, para que uma edição futura (PATCH com status=active no body) NÃO dispare
-- um e-mail de boas-vindas retroativo a clientes que já operam (VENUXX, CABRAL, etc.).
-- Só tenants ATIVADOS depois desta migração (linha ausente) receberão o guia.
INSERT INTO tenant_notifications (tenant_id, kind)
  SELECT id, 'onboarding_config' FROM tenants WHERE status = 'active'
  ON CONFLICT (tenant_id, kind) DO NOTHING;
