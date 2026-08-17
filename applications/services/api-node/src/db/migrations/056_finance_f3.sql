-- Migration 056: Módulo Financeiro F3 (notas fiscais internas) — RFC-0002 Parte B.
-- MVP INTERNO: tabela de invoices (notas) geradas a partir de cobranças PAGAS, com
-- numeração sequencial própria e um provedor de emissão plugável (InvoiceProvider).
-- Nesta fase o provedor é um STUB interno ('internal') que devolve uma referência
-- sintética — SEM integração com prefeitura/NFS-e e SEM certificado A1 (isso é F4).
-- Convenções herdadas: dinheiro em centavos inteiros; moeda única BRL; FKs preservam
-- histórico (tenant RESTRICT, charge SET NULL). finance_audit já aceita 'invoice' (054/055).
-- Nenhum ';' dentro de literal de string (guard do runner de migrations).

-- Numeração sequencial de notas (independente do UUID técnico). Começa em 1.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           BIGINT NOT NULL DEFAULT nextval('invoice_number_seq'),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  charge_id        UUID REFERENCES charges(id) ON DELETE SET NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  currency         TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  description      TEXT,
  competence_month TEXT CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'canceled')),
  provider         TEXT NOT NULL DEFAULT 'internal',
  provider_ref     TEXT,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Numeração única.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_number ON invoices (number);

-- Uma nota EMITIDA por cobrança (cancelar libera reemissão). Guard de dupla emissão (409).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_charge_issued
  ON invoices (charge_id)
  WHERE status = 'issued' AND charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_tenant     ON invoices (tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_competence ON invoices (competence_month);
