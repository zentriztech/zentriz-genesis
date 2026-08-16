-- 050_plan_monthly_price.sql
-- Zentriz Genesis — valor monetario do plano.
--   Adiciona plans.monthly_price_cents: preco mensal em CENTAVOS (BRL). Inteiro, default 0.
--   Semeia valores de exemplo para os planos base (Jean pode editar depois na tela /zentriz/plans).
-- Runner (db/init.ts): split ingenuo por ';' — NENHUM literal abaixo contem ';'.
-- Statements idempotentes: ADD COLUMN IF NOT EXISTS + UPDATEs guardados por valor atual 0.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0;

UPDATE plans SET monthly_price_cents = 9900 WHERE slug = 'prata' AND monthly_price_cents = 0;
UPDATE plans SET monthly_price_cents = 29900 WHERE slug = 'ouro' AND monthly_price_cents = 0;
UPDATE plans SET monthly_price_cents = 99900 WHERE slug = 'diamante' AND monthly_price_cents = 0;
