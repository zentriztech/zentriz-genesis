-- 063 — RFC-0003 B4: vínculo de ORIGEM do produto com a spec da Bancada que o gerou.
-- Decompor uma spec já salva (POST /api/projects/:id/decompose) cria um produto; sem este
-- vínculo o produto ficava órfão (gap U#4/C7) — o portal não sabia de qual spec ele veio,
-- nem dava para deduplicar a spec de origem. ON DELETE SET NULL: apagar a spec não derruba
-- o produto (histórico preservado, vínculo só some).
ALTER TABLE products ADD COLUMN IF NOT EXISTS origin_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_origin_project ON products(origin_project_id) WHERE origin_project_id IS NOT NULL;
