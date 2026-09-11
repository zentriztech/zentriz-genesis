-- 127 — RFC-0008 Emenda 01: passo [Normalizar] antes de promover.
-- O produto so entra na fabrica depois que a Bancada gerou/atualizou os docs (RFC + o que fizer
-- sentido). `normalized_hash` e o hash canonico da spec do produto no momento da normalizacao:
-- editar qualquer spec invalida a normalizacao e a trava do /promote volta.
-- `normalization_md` e o INDICE do produto (links relativos) — escrito por CODIGO, nao por agente
-- (indice e transporte). Nao reusa `manifest_md` (072), que e do decomposer e nao pode ser perdido.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_hash TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalized_by UUID;
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalization_model TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS normalization_md TEXT;
