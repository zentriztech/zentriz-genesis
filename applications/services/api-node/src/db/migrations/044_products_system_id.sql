-- Migration 044: system_id canônico em products (#60 — vínculo com o Deadpool).
--
-- O manifesto de produto (PRODUCT.json) traz product.systemId (ex.: zvoices), que é
-- o identificador estável usado nos envelopes Connect de incidente. Antes ele não era
-- persistido, então o Genesis derivava um systemId do NOME do produto ao registrar o
-- projeto no Deadpool — o que NÃO casava com o systemId canônico que um incidente
-- carrega. Esta coluna guarda o systemId do manifesto para que registro (Genesis) e
-- diagnóstico (Deadpool) compartilhem exatamente o mesmo identificador.
--
-- NOTA sobre o formato: o runner de migrations (db/init.ts) faz split ingênuo por ';'
-- e remove linhas iniciadas por '--'. Sem literais com ';' ou aspas simples.

ALTER TABLE products ADD COLUMN IF NOT EXISTS system_id TEXT;

CREATE INDEX IF NOT EXISTS idx_products_system_id ON products(system_id) WHERE system_id IS NOT NULL;

COMMENT ON COLUMN products.system_id IS 'systemId canonico do manifesto (product.systemId) — usado no vinculo com o Deadpool e nos envelopes Connect';
