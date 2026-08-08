-- Migration 038: idempotência de ingestão de produto (ADR-018 / Cenário A, DoD).
--
-- Reingerir o MESMO produto (manifesto + specs byte a byte idênticos) deve ser no-op,
-- não criar produto/projetos duplicados. `product_hash` = SHA-256 determinístico do
-- manifesto + todos os arquivos do ZIP (ver productManifest.ts::computeProductHash).
--
-- Unicidade POR TENANT: dois tenants podem, em tese, ter produtos idênticos; a colisão
-- que queremos barrar é o mesmo tenant reingerindo o mesmo ZIP. Índice parcial ignora
-- linhas com hash NULL (produtos criados fora do fluxo de ingestão — ex.: POST /api/products).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_tenant_hash
  ON products (tenant_id, product_hash)
  WHERE product_hash IS NOT NULL;

COMMENT ON COLUMN products.product_hash IS
  'SHA-256 determinístico do manifesto + arquivos do ZIP (idempotência de ingestão). NULL para produtos criados fora do fluxo de ingestão.';
