-- 080 — Evoluir E2 (E-D4): numeração de RFC/ADR por PRODUTO (ADRs são do produto, não do serviço).
-- Alocação atômica: UPDATE products SET next_rfc_seq = next_rfc_seq + N RETURNING next_rfc_seq.
-- Regra do runner de migrations: nenhum ';' dentro de string literal.
ALTER TABLE products ADD COLUMN IF NOT EXISTS next_rfc_seq INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS next_adr_seq INTEGER NOT NULL DEFAULT 1;
