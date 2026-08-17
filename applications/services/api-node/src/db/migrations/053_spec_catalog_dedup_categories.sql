-- 053_spec_catalog_dedup_categories.sql
-- Zentriz Genesis — deduplica categorias do catalogo por problema de escrita.
--   Categorias que diferem apenas por ACENTO/CAIXA (ex.: 'Logistica' vs 'Logistica' acentuada)
--   apareciam como filtros/chips separados em /specs. Aqui canonizamos todas as variantes
--   de um mesmo grupo (chave = categoria sem acento, minuscula) para uma unica forma canonica.
--   Escolha do canonico: prefere a variante COM acento, depois a mais longa, depois alfabetica.
-- Runner (db/init.ts): remove linhas '--' e faz split ingenuo por ';'. Este arquivo tem UM
--   unico statement (um ';' ao final) e NENHUM ';' dentro de literal. Aspas balanceadas.
-- Idempotente: reexecucao nao encontra linhas fora do canonico -> no-op.

WITH norm AS (
  SELECT DISTINCT category,
         lower(translate(category, 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')) AS k,
         (category <> translate(category, 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')) AS has_accent
  FROM spec_catalog
),
canon AS (
  SELECT k, (ARRAY_AGG(category ORDER BY has_accent DESC, length(category) DESC, category ASC))[1] AS canonical
  FROM norm GROUP BY k
)
UPDATE spec_catalog s
SET category = c.canonical
FROM norm n
JOIN canon c ON c.k = n.k
WHERE s.category = n.category AND s.category <> c.canonical;
