-- Migration 054: Módulo Financeiro F1 (MVP) — RFC-0002 Parte B.
-- Introduz contas bancárias da empresa (recebedora), cobranças (charges),
-- pagamentos (baixa manual) e trilha de auditoria append-only.
-- SEM gateway de pagamento e SEM nota fiscal nesta fase (F3/F4).
-- Convenções: dinheiro sempre em centavos inteiros; FKs com ON DELETE
-- RESTRICT/SET NULL para preservar histórico financeiro (M5).

-- ── Contas bancárias da empresa (Zentriz recebedora) ────────────────────────
CREATE TABLE IF NOT EXISTS company_bank_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label           TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  bank_code       TEXT,
  agency          TEXT,
  account         TEXT,
  account_type    TEXT CHECK (account_type IN ('checking', 'savings')),
  pix_key         TEXT,
  pix_key_type    TEXT CHECK (pix_key_type IN ('cpf', 'cnpj', 'email', 'phone', 'random')),
  holder_name     TEXT,
  holder_document TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- L3: no máximo UMA conta padrão (partial unique index sobre a flag verdadeira).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_bank_accounts_default
  ON company_bank_accounts (is_default) WHERE is_default;

-- ── Cobranças (charges) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS charges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id          TEXT REFERENCES plans(id) ON DELETE SET NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency         TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  description      TEXT,
  competence_month TEXT CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind             TEXT NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'one_off', 'proration')),
  due_date         DATE,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'paid', 'partially_paid', 'overdue', 'canceled', 'refunded')),
  issued_at        TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  payment_method   TEXT,
  external_id      TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_charges_tenant       ON charges(tenant_id);
CREATE INDEX IF NOT EXISTS idx_charges_status       ON charges(status);
CREATE INDEX IF NOT EXISTS idx_charges_competence   ON charges(competence_month);

-- M2: uma única cobrança de assinatura por tenant/competência (ignorando canceladas).
CREATE UNIQUE INDEX IF NOT EXISTS uq_charges_subscription_competence
  ON charges (tenant_id, competence_month)
  WHERE kind = 'subscription' AND status <> 'canceled';

-- ── Pagamentos (baixa manual em F1) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id       UUID NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  method          TEXT NOT NULL CHECK (method IN ('pix', 'boleto', 'card', 'transfer', 'cash', 'manual')),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  bank_account_id UUID REFERENCES company_bank_accounts(id) ON DELETE SET NULL,
  external_id     TEXT,
  reference       TEXT,
  notes           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_charge  ON payments(charge_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant  ON payments(tenant_id);

-- L2: baixa idempotente por origem externa (quando houver external_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_method_external
  ON payments (method, external_id) WHERE external_id IS NOT NULL;

-- ── Trilha de auditoria financeira (append-only, M5) ────────────────────────
CREATE TABLE IF NOT EXISTS finance_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('charge', 'payment', 'bank_account', 'invoice')),
  entity_id     UUID NOT NULL,
  action        TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_audit_entity ON finance_audit(entity_type, entity_id);
