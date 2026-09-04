-- 083 — RFC-0005: acoes de triagem de GAPs blocker na auditoria de governanca (D4).
-- E2E 2026-09-04: o CHECK de `action` (074/078) rejeitava gap_ignored_blocker/gap_refuted_blocker/gap_reactivated
-- e o INSERT falhava em silencio → auditoria D4 da triagem nao gravava. Mesmo padrao da 078 (drop + add).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE governance_audit DROP CONSTRAINT IF EXISTS governance_audit_action_check;
ALTER TABLE governance_audit ADD CONSTRAINT governance_audit_action_check
  CHECK (action IN ('force_promote', 'ack_findings', 'validate_trigger', 'spec_self_approved',
                    'gap_ignored_blocker', 'gap_refuted_blocker', 'gap_reactivated'));
