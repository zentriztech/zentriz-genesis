-- 072 — RFC-0004 Onda 1 (D6): manifesto do PRODUTO.
-- A arvore de specs e por PROJETO (project_spec_files); o README do PRODUTO (kind: product)
-- nao tinha onde morar (products nao tem tabela de arquivos). Decisao D6: coluna simples —
-- um produto tem UM manifesto. Gerado deterministicamente pelo decomposer; NAO entra no
-- product_hash (idempotencia e sobre o payload da proposta, nunca artefatos gerados).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE products ADD COLUMN IF NOT EXISTS manifest_md TEXT;
