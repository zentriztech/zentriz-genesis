-- 129 — cadastro internacional (signup): tenants ganha `country` (texto livre, ISO-2 quando
-- possivel, mas nao exigido). Default 'BR' preserva o significado dos tenants existentes
-- (todos brasileiros ate aqui) sem precisar de backfill condicional.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'BR';
