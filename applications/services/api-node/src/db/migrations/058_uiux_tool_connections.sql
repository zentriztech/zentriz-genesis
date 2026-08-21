-- Migration 058: Item 3 — Ferramentas UI/UX (Figma/Canva) por tenant.
-- Conexões multi-conta a ferramentas de design, espelhando o padrão de
-- tenant_cloud_connections (slots + credenciais criptografadas AES-256-GCM).
-- provider: figma (Personal Access Token, self-service) | canva (Connect API OAuth).
-- account_ref: identificador da conta na ferramenta (Figma team_id / Canva user),
--   usado para listar os projetos da conta no form de spec. Opcional.
-- Credenciais NUNCA em claro: encrypted_credentials + encryption_iv + encryption_tag.
-- Idempotente (CREATE TABLE/INDEX IF NOT EXISTS). Nenhum ';' dentro de literal de string
-- (guard do runner de migrations).

CREATE TABLE IF NOT EXISTS tenant_uiux_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL CHECK (provider IN ('figma', 'canva')),
  slot_index            SMALLINT NOT NULL DEFAULT 0,
  label                 TEXT,
  account_ref           TEXT,
  encrypted_credentials TEXT NOT NULL,
  encryption_iv         TEXT NOT NULL,
  encryption_tag        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade de slot deve valer SÓ para linhas ativas: o delete é soft (status='revoked')
-- e não zera slot_index, então uma constraint total colidiria no próximo add/recompact
-- (duplicate key). Removemos a constraint total (se já criada em DB pré-existente) e
-- usamos índice único PARCIAL sobre status='active'.
ALTER TABLE tenant_uiux_connections
  DROP CONSTRAINT IF EXISTS tenant_uiux_connections_tenant_slot_key;

-- Também remove o nome auto-gerado (caso alguma versão prévia tenha usado UNIQUE inline sem nome).
ALTER TABLE tenant_uiux_connections
  DROP CONSTRAINT IF EXISTS tenant_uiux_connections_tenant_id_slot_index_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_uiux_connections_tenant_slot_active
  ON tenant_uiux_connections (tenant_id, slot_index)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_uiux_connections_tenant
  ON tenant_uiux_connections (tenant_id)
  WHERE status = 'active';
