-- Migration 078: governance_audit aceita a ação 'spec_self_approved' (R4 PR5 / decisão D4 do Jean).
--
-- D4 (2026-09-04): o flag specApproved (Sub-modo C do CTO: "validar, não regenerar") continua
-- aceito de qualquer usuário do tenant — mas passa a ser AUDITADO. O aprovador registrado é sempre
-- o próprio submissor (autor = aprovador por design em tenants de 1 usuário); a trilha torna isso
-- explícito e legível (GET /api/governance-audit) em vez de invisível.
--
-- NOTA runner de migrations: split ingênuo por ';' — sem ';' em literais, sem blocos DO/$$.
-- O CHECK original (074) foi criado inline sem nome → Postgres nomeia governance_audit_action_check.

ALTER TABLE governance_audit DROP CONSTRAINT IF EXISTS governance_audit_action_check;

ALTER TABLE governance_audit ADD CONSTRAINT governance_audit_action_check
  CHECK (action IN ('force_promote', 'ack_findings', 'validate_trigger', 'spec_self_approved'));

CREATE INDEX IF NOT EXISTS governance_audit_by_product ON governance_audit (product_id, created_at DESC);
