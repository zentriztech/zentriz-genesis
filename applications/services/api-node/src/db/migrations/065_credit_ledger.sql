-- 065_credit_ledger.sql
-- Sistema de creditos de cortesia: ledger de dupla entrada, append-only.
-- Convencao: dinheiro sempre em centavos inteiros (INTEGER), BRL; FKs ON DELETE RESTRICT/SET NULL
-- para preservar historico financeiro (mesma politica de 054). Idempotente + forward-only.
-- SEM trigger/function aqui: o runner faz split ingenuo por ';' e nao suporta dollar-quoting.
-- Os guards de append-only e zero-sum vivem em 065b (src/db/manual-sql), aplicado via psql.

CREATE TABLE IF NOT EXISTS credit_ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('grant','consume','reversal')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  competence_month TEXT CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  charge_id UUID REFERENCES charges(id) ON DELETE SET NULL,
  reverses_transaction_id UUID REFERENCES credit_ledger_transactions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  ref TEXT,
  memo TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES credit_ledger_transactions(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account TEXT NOT NULL CHECK (account IN ('tenant_credit','courtesy_offset','billing_consumption')),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia global do movimento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_idempotency
  ON credit_ledger_transactions (idempotency_key);

-- Um unico consumo por tenant/competencia (espelha uq_charges_subscription_competence 054:55-57).
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_consume_competence
  ON credit_ledger_transactions (tenant_id, competence_month)
  WHERE entry_type = 'consume' AND competence_month IS NOT NULL;

-- Um unico reversal por transacao estornada (bloqueia double-reversal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_reversal_target
  ON credit_ledger_transactions (reverses_transaction_id)
  WHERE entry_type = 'reversal';

CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant
  ON credit_ledger_transactions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_entries_tenant_account
  ON credit_ledger_entries (tenant_id, account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_entries_tx
  ON credit_ledger_entries (transaction_id);

-- Saldo DERIVADO (nunca campo mutavel). balance_cents >= 0 e invariante de aplicacao+trigger+reconciliacao.
CREATE OR REPLACE VIEW tenant_credit_balance AS
SELECT tenant_id,
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END), 0)::int AS balance_cents
FROM credit_ledger_entries
WHERE account = 'tenant_credit'
GROUP BY tenant_id;

-- Extensao do CHECK de payments.method. Reconstrucao lista TODOS os valores previos (054:66) + 'credit'.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('pix','boleto','card','transfer','cash','manual','credit'));

-- Extensao do CHECK de finance_audit.entity_type (054:85 + 055 'tenant') + 'credit_ledger'.
ALTER TABLE finance_audit DROP CONSTRAINT IF EXISTS finance_audit_entity_type_check;
ALTER TABLE finance_audit ADD CONSTRAINT finance_audit_entity_type_check
  CHECK (entity_type IN ('charge','payment','bank_account','invoice','tenant','credit_ledger'));

-- ATENCAO: a string do COMMENT NAO pode conter ';' (o runner faz split ingenuo por ';' - bug 048).
COMMENT ON TABLE credit_ledger_transactions IS 'Creditos de cortesia (dupla entrada, append-only enforced por trigger 065b). Concessao/reversal = injecao manual server-side, consumo = acoplado ao ciclo. Saldo derivado da view tenant_credit_balance. amount_cents do header e denormalizado, fonte de verdade sao as pernas.';
