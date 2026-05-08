-- Migration 019: Telegram Bot integration
-- Tabelas para vinculação chat_id ↔ user e códigos de onboarding.

CREATE TABLE IF NOT EXISTS user_telegram (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chat_id      BIGINT      NOT NULL UNIQUE,
  username     TEXT,
  active       BOOLEAN     NOT NULL DEFAULT true,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_telegram_chat      ON user_telegram(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_telegram_tenant    ON user_telegram(tenant_id);

-- Códigos temporários de vinculação (6 dígitos, TTL 10 min)
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_code ON telegram_link_codes(code);

-- Ações destrutivas pendentes de confirmação 2FA (TTL 60s)
CREATE TABLE IF NOT EXISTS telegram_pending_actions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    BIGINT      NOT NULL,
  action     TEXT        NOT NULL CHECK (action IN ('run', 'stop', 'accept', 'reject', 'blocked')),
  project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_chat ON telegram_pending_actions(chat_id, used, expires_at);
