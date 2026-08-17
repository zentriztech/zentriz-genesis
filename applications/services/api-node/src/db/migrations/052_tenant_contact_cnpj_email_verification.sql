-- Migration 052: reforma de cadastro de tenant (Fase B).
-- Adiciona ao tenant: e-mail de contato + status de confirmacao, CNPJ, dados do
-- responsavel e endereco (auto-preenchido por CNPJ). Cria a tabela de codigos de
-- verificacao de e-mail (signup com codigo enviado por SES).
--
-- Formato: runner faz split por ';' e remove linhas '--'. Sem ';' dentro de literal;
-- aspas simples sempre balanceadas por statement (ver migrations.test.ts).

-- ── Contato e confirmacao de e-mail do tenant ──────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_confirmed BOOLEAN NOT NULL DEFAULT false;

-- ── CNPJ (alfanumerico-ready: TEXT, guardado sem pontuacao) ────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cnpj TEXT;

-- ── Dados do responsavel ───────────────────────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS responsible_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS responsible_email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS responsible_phone TEXT;

-- ── Endereco (auto-preenchido via lookup de CNPJ) ─────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_cep TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_street TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_number TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_complement TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_district TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_city TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address_state TEXT;

-- ── Codigos de verificacao de e-mail (OTP curto, hash em repouso) ──────────────
-- Guardamos apenas o HASH do codigo (nunca o codigo em claro). Um codigo expira,
-- tem limite de tentativas e e consumido no uso. purpose permite reuso futuro
-- (reset de senha etc.) sem nova tabela.
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'tenant_signup',
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_email_purpose
  ON email_verification_codes (email, purpose);
CREATE INDEX IF NOT EXISTS idx_email_verification_created
  ON email_verification_codes (email, purpose, created_at);
