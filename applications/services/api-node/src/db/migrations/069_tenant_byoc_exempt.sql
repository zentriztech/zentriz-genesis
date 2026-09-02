-- 069_tenant_byoc_exempt.sql
-- Whitelist BYOC gerenciável pelo Portal: quais tenants podem usar a infraestrutura de deploy
-- da Zentriz (conta 820) pelo pipeline do host quando GENESIS_BYOC_ENFORCED está ligado.
-- Antes, a whitelist vivia só na env var GENESIS_BYOC_EXEMPT_TENANTS (CSV). Esta coluna é a
-- fonte primária (gerenciável por zentriz_admin em Configurações); a env segue como fallback.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS byoc_exempt BOOLEAN NOT NULL DEFAULT false;
