-- 071 — RFC-0004 Onda 1 (F1): specs hierarquicas — arvore de arquivos por spec.
--
-- rel_dir: diretorio relativo do arquivo DENTRO da spec ('' = raiz, retrocompativel com
--   o layout plano atual — verificado: nenhum dos 12 SELECTs existentes filtra por diretorio).
-- is_primary: arquivo canonico da spec (README/corpo principal) — os leitores LIMIT-1
--   (pipeline, spec-content, watchdog, dispatch) passam a preferir o canonico.
-- content_sha256: hash do CONTEUDO do arquivo — serve ao If-Match do editor (Onda 4) e e
--   insumo do hash canonico da arvore (Onda 3). Nullable: backfill e LAZY (computado na
--   primeira leitura/escrita pelo codigo — o runner de migrations nao le disco).
--
-- Pre-verificado 2026-09-03: zero duplicatas (project_id, filename) em dev E prod — o
-- dedupe abaixo e rede de seguranca idempotente para qualquer ambiente com sujeira.
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$ (split ingenuo por ';').

ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS rel_dir TEXT NOT NULL DEFAULT '';
ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project_spec_files ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

-- Dedupe defensivo: renomeia duplicatas de (project_id, rel_dir, filename) mantendo a mais
-- antiga com o nome original (sufixo = id, garantidamente unico). No-op em base limpa.
UPDATE project_spec_files f SET filename = f.filename || '.dup-' || f.id
FROM (
  SELECT id, row_number() OVER (PARTITION BY project_id, rel_dir, filename ORDER BY created_at, id) AS rn
  FROM project_spec_files
) d
WHERE d.id = f.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_spec_files_tree
  ON project_spec_files (project_id, rel_dir, filename);

-- Arquivo canonico inicial: em specs de arquivo unico, ele e o primario; em specs
-- multi-arquivo legadas, o MAIS ANTIGO (comportamento do pipeline.ts hoje: primeiro .md).
UPDATE project_spec_files f SET is_primary = true
FROM (
  SELECT DISTINCT ON (project_id) id FROM project_spec_files ORDER BY project_id, created_at ASC, id
) first_file
WHERE f.id = first_file.id;
