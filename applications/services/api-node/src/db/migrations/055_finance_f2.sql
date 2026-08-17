-- Migration 055: Módulo Financeiro F2 — RFC-0002 Parte B.
-- Ciclo de vida da assinatura: vencimento (overdue), suspensão por inadimplência
-- e reativação por pagamento. Sem novas tabelas — apenas índices de apoio aos jobs
-- e a extensão da trilha de auditoria para eventos de TENANT (ativar/suspender).
-- Nenhum ';' dentro de literal de string (guard do runner de migrations).

-- Auditoria passa a registrar também eventos de ciclo de vida do tenant (activate/suspend).
-- O CHECK inline de 054 tem o nome canônico <tabela>_<coluna>_check.
ALTER TABLE finance_audit DROP CONSTRAINT IF EXISTS finance_audit_entity_type_check;
ALTER TABLE finance_audit ADD CONSTRAINT finance_audit_entity_type_check
  CHECK (entity_type IN ('charge', 'payment', 'bank_account', 'invoice', 'tenant'));

-- Sweep de vencimento: varre cobranças em aberto por (status, due_date).
CREATE INDEX IF NOT EXISTS idx_charges_due_status ON charges (status, due_date);

-- Suspensão/reativação: EXISTS de cobrança de assinatura vencida por tenant.
CREATE INDEX IF NOT EXISTS idx_charges_tenant_kind_status ON charges (tenant_id, kind, status);
