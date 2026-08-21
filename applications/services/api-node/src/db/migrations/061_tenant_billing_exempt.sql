-- Migration 061: isencao de cobranca/suspensao para tenants INTERNOS (ex.: fabrica ZFactory).
-- Motivacao: o financeBillingWorker suspende todo tenant ativo com assinatura vencida alem da
-- carencia. Tenants internos da Zentriz nao sao clientes pagantes e nao devem ser suspensos nem
-- receber cobrancas recorrentes. A regra e por ID FORTE (flag booleana por tenant), nao pelo nome,
-- e suporta MULTIPLOS tenants isentos.
--
-- Efeito no codigo (esta versao):
--   * generate-month (routes/finance.ts) NAO gera assinatura para tenant isento.
--   * financeBillingWorker NAO suspende tenant isento por inadimplencia.
--
-- Idempotente (IF NOT EXISTS). Nenhum ';' dentro de literal de string (guard do runner).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.billing_exempt IS 'Tenant interno isento de cobranca recorrente e de suspensao por inadimplencia (identificado por id, nao por nome)';

-- Seed do tenant interno ZFactory por UUID (id forte). Em ambientes sem esse id o UPDATE afeta 0 linhas.
UPDATE tenants SET billing_exempt = true WHERE id = 'beca944e-d7ee-4a5e-a8b6-cfd097239151';
