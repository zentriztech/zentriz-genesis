-- Migration 015: GitHub App por tenant (FT-12)
-- Permite que cada tenant configure sua própria GitHub App (app_id + chave privada).
-- Fallback para App global do env quando tenant não tem config própria.

ALTER TABLE tenant_github_installations
  ADD COLUMN IF NOT EXISTS app_id               BIGINT,
  ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS app_client_id        TEXT,
  ADD COLUMN IF NOT EXISTS app_client_secret    TEXT;

COMMENT ON COLUMN tenant_github_installations.app_id               IS 'FT-12: GitHub App ID do tenant (opcional — usa env GITHUB_APP_ID como fallback)';
COMMENT ON COLUMN tenant_github_installations.private_key_encrypted IS 'FT-12: Chave privada PEM cifrada com AES-256-CBC usando ENCRYPTION_KEY do env';
COMMENT ON COLUMN tenant_github_installations.app_client_id        IS 'FT-12: OAuth client_id da App do tenant (opcional)';
COMMENT ON COLUMN tenant_github_installations.app_client_secret    IS 'FT-12: OAuth client_secret cifrado (opcional)';
