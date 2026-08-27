-- 065b_credit_ledger_guards.sql  — APLICAR VIA psql (NAO pelo runner). Idempotente.
--
-- ATENCAO: este arquivo NAO pode viver em src/db/migrations/ — o runner (init.ts:56-58)
-- varre TODO .sql daquele diretorio, faz split ingenuo por ';' e nao suporta dollar-quoting
-- ($fn$...$fn$), CREATE FUNCTION/TRIGGER nem DO $$ (classe de bug da 048). Colocado aqui,
-- fora do diretorio varrido, e aplicado manualmente por psql no rollout (F0b / secao 10 do plano):
--   psql "$DATABASE_URL" -f src/db/manual-sql/065b_credit_ledger_guards.sql
-- Depende de 065_credit_ledger.sql (tabelas + view) ja aplicado.

-- (1) Append-only: bloqueia qualquer UPDATE/DELETE nas tabelas do ledger.
CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'credit ledger is append-only: % on % rejected', TG_OP, TG_TABLE_NAME;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_tx_append_only ON credit_ledger_transactions;
CREATE TRIGGER trg_credit_tx_append_only
  BEFORE UPDATE OR DELETE ON credit_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

DROP TRIGGER IF EXISTS trg_credit_entries_append_only ON credit_ledger_entries;
CREATE TRIGGER trg_credit_entries_append_only
  BEFORE UPDATE OR DELETE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

-- (1b) TRUNCATE e statement-level: trigger de linha NAO o pega. Bloquear explicitamente.
DROP TRIGGER IF EXISTS trg_credit_tx_no_truncate ON credit_ledger_transactions;
CREATE TRIGGER trg_credit_tx_no_truncate
  BEFORE TRUNCATE ON credit_ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_append_only();

DROP TRIGGER IF EXISTS trg_credit_entries_no_truncate ON credit_ledger_entries;
CREATE TRIGGER trg_credit_entries_no_truncate
  BEFORE TRUNCATE ON credit_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_append_only();

-- (2) Zero-sum por transacao, validado no COMMIT (CONSTRAINT TRIGGER DEFERRED):
--     permite inserir as duas pernas na mesma tx e checa o balanceamento so no commit.
CREATE OR REPLACE FUNCTION credit_ledger_zero_sum() RETURNS trigger AS $fn$
DECLARE net INTEGER;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0)
    INTO net FROM credit_ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'credit ledger transaction % is unbalanced (net=%)', NEW.transaction_id, net;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_entries_zero_sum ON credit_ledger_entries;
CREATE CONSTRAINT TRIGGER trg_credit_entries_zero_sum
  AFTER INSERT ON credit_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_zero_sum();
