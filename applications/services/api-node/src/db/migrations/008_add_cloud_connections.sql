-- Migration 008: tenant cloud connections for GitHub Actions deploy
-- Credentials are stored AES-256-GCM encrypted — never in plaintext.

CREATE TABLE IF NOT EXISTS tenant_cloud_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL CHECK (provider IN ('aws', 'azure', 'gcp')),
  region                    TEXT,                    -- e.g. "us-east-1", "eastus", "us-central1"
  service_type              TEXT NOT NULL DEFAULT 'container',
                                                     -- 'container' | 'serverless' | 'k8s'
  encrypted_credentials     TEXT NOT NULL,           -- AES-256-GCM encrypted JSON
  encryption_iv             TEXT NOT NULL,           -- hex-encoded IV
  encryption_tag            TEXT NOT NULL,           -- hex-encoded auth tag
  github_secrets_synced_at  TIMESTAMPTZ,             -- last time secrets were pushed to GitHub
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)                       -- one connection per provider per tenant
);

CREATE INDEX IF NOT EXISTS idx_cloud_connections_tenant ON tenant_cloud_connections(tenant_id);
