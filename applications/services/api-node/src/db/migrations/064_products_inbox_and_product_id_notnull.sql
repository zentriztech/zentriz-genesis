-- Migration 064: todo projeto pertence a um produto. INBOX 'Rascunhos' (so pre-fabrica) +
-- produto homonimo por App SOLO em estado de fabrica/terminal. Runner nao-transacional; idempotente.
--
-- NOTA sobre o formato: o runner (db/init.ts) remove linhas iniciadas por '--' e faz split
-- INGENUO por ';'. Por isso NENHUM literal de string pode conter ';' (usa-se ',' no lugar) e
-- nao ha DO/PLpgSQL. WITH/WITH RECURSIVE/window functions sao SQL puro (permitidos).
--
-- ROLLBACK MANUAL (sem down automatico):
--   ALTER TABLE projects ALTER COLUMN product_id DROP NOT NULL;
--   ALTER TABLE projects DROP CONSTRAINT projects_product_id_fkey;
--   ALTER TABLE projects ADD CONSTRAINT projects_product_id_fkey FOREIGN KEY (product_id)
--     REFERENCES products(id) ON DELETE SET NULL;
--   UPDATE projects SET product_id=NULL WHERE product_id IN (SELECT id FROM products WHERE is_inbox OR solo_app);
--   DELETE FROM products WHERE is_inbox OR solo_app;
--   DROP INDEX IF EXISTS uq_products_inbox_per_tenant; DROP INDEX IF EXISTS uq_products_solo_origin;
--   DROP INDEX IF EXISTS uq_products_system_id_per_tenant;
--   ALTER TABLE products DROP COLUMN is_inbox; ALTER TABLE products DROP COLUMN solo_app;
--   DELETE FROM schema_migrations WHERE version='064_products_inbox_and_product_id_notnull';

-- (1) marcadores
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_inbox BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS solo_app BOOLEAN NOT NULL DEFAULT false;

-- (2c) dedup de system_id colidente por tenant (case-insensitive) ANTES do unique.
--      Mantem a linha mais antiga; sufixa as demais com o id curto (idempotente).
WITH dups AS (
  SELECT id, tenant_id, system_id,
    row_number() OVER (PARTITION BY tenant_id, lower(system_id) ORDER BY created_at, id) AS rn
  FROM products WHERE system_id IS NOT NULL
)
UPDATE products p
SET system_id = p.system_id || '-' || substr(p.id::text, 1, 8)
FROM dups WHERE dups.id = p.id AND dups.rn > 1;

-- (2) unicidade real de system_id por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_system_id_per_tenant
  ON products(tenant_id, lower(system_id)) WHERE system_id IS NOT NULL;

-- (2d) produto de USUARIO cujo nome normaliza p/ 'rascunhos' (NAO e o inbox) e renomeado (idempotente)
UPDATE products
SET name = name || ' (produto)'
WHERE is_inbox = false AND btrim(lower(name)) = 'rascunhos';

-- (2e) no maximo 1 inbox por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_inbox_per_tenant ON products(tenant_id) WHERE is_inbox;
-- (2f) unicidade do homonimo por origem
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_solo_origin ON products(origin_project_id) WHERE solo_app;

-- (3) INBOX para tenants com user OU projeto e sem inbox
INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox)
SELECT t.id,
       COALESCE(
         (SELECT u.id FROM users u WHERE u.tenant_id = t.id ORDER BY (u.role = 'tenant_admin') DESC, u.created_at LIMIT 1),
         (SELECT pr.created_by FROM projects pr WHERE pr.tenant_id = t.id LIMIT 1)
       ),
       'Rascunhos',
       'Caixa de entrada do sistema: specs ainda nao organizadas em um produto (re-alocaveis enquanto rascunho).',
       'active', 'draft', true
FROM tenants t
WHERE (EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)
       OR EXISTS (SELECT 1 FROM projects pr WHERE pr.tenant_id = t.id))
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = t.id AND p.is_inbox);

-- (4) desanexar cross-tenant legado
UPDATE projects pr SET product_id = NULL
FROM products p
WHERE p.id = pr.product_id AND p.tenant_id <> pr.tenant_id;

-- (4-tr) COMPONENTES DE DECOMPOSICAO orfaos herdam o product de um IRMAO do grafo project_triggers
--        (mesmo tenant, produto NAO-inbox). Guarda depth<64 (anti-ciclo). Roda ANTES dos homonimos-solo.
WITH RECURSIVE graph AS (
  SELECT pr.id AS orig, pr.id AS node, pr.tenant_id, 0 AS depth
  FROM projects pr
  WHERE pr.product_id IS NULL
    AND EXISTS (SELECT 1 FROM project_triggers t WHERE t.project_id = pr.id OR t.trigger_project_id = pr.id)
  UNION ALL
  SELECT g.orig, nb.id, g.tenant_id, g.depth + 1
  FROM graph g
  JOIN project_triggers t ON (t.project_id = g.node OR t.trigger_project_id = g.node)
  JOIN projects nb ON nb.id = (CASE WHEN t.project_id = g.node THEN t.trigger_project_id ELSE t.project_id END)
  WHERE g.depth < 64
),
sib AS (
  SELECT DISTINCT ON (g.orig) g.orig, np.product_id
  FROM graph g
  JOIN projects np ON np.id = g.node
  JOIN products pd ON pd.id = np.product_id
  WHERE np.product_id IS NOT NULL AND pd.is_inbox = false AND np.tenant_id = g.tenant_id
  ORDER BY g.orig, g.depth
)
UPDATE projects pr
SET product_id = sib.product_id, updated_at = now()
FROM sib
WHERE pr.id = sib.orig AND pr.product_id IS NULL;

-- (5) RAIZES ORFAS SOLO (parent_project_id NULL) em estado de FABRICA/terminal -> produto HOMONIMO.
INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox, solo_app, system_id, origin_project_id)
SELECT o.tenant_id, o.created_by, o.title, 'App migrado (era avulso, auto-criado na migracao 064).', 'active',
  CASE WHEN o.status='failed' THEN 'failed'
       WHEN o.status='accepted' THEN 'accepted'
       WHEN o.status='blocked_cyborg' THEN 'stalled_waiting_human'
       ELSE 'running' END,
  false, true,
  CASE
    WHEN o.base_slug IS NULL THEN 'app-' || substr(o.id::text, 1, 8)
    WHEN o.rn > 1 OR EXISTS (SELECT 1 FROM products p2 WHERE p2.tenant_id = o.tenant_id AND lower(p2.system_id) = o.base_slug)
      THEN o.base_slug || '-' || substr(o.id::text, 1, 8)
    ELSE o.base_slug END,
  o.id
FROM (
  SELECT pr.id, pr.tenant_id, pr.created_by, pr.title, pr.status,
    NULLIF(regexp_replace(regexp_replace(lower(pr.title), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '') AS base_slug,
    row_number() OVER (
      PARTITION BY pr.tenant_id,
        NULLIF(regexp_replace(regexp_replace(lower(pr.title), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '')
      ORDER BY pr.created_at, pr.id
    ) AS rn
  FROM projects pr
  WHERE pr.product_id IS NULL
    AND pr.parent_project_id IS NULL
    AND pr.status IN ('running','queued','cto_charter','pm_backlog','dev_qa','devops','pending_cyborg','blocked_cyborg','accepted','completed','stopped','failed')
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id)
) o;

-- (5b) des-orfanizar os solo recem-criados
UPDATE projects pr
SET product_id = (SELECT p.id FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id LIMIT 1)
WHERE pr.product_id IS NULL
  AND EXISTS (SELECT 1 FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id);

-- (5c) HERANCA DE LINHAGEM (parent_project_id) roda DEPOIS de (5)/(5b). Guarda depth<64.
--      Nunca herda produto is_inbox.
WITH RECURSIVE up AS (
  SELECT id AS orig, id AS cur, parent_project_id, tenant_id, 0 AS depth
  FROM projects WHERE product_id IS NULL AND parent_project_id IS NOT NULL
  UNION ALL
  SELECT u.orig, p.id, p.parent_project_id, u.tenant_id, u.depth + 1
  FROM up u JOIN projects p ON p.id = u.parent_project_id
  WHERE u.depth < 64
),
roots AS (SELECT orig, cur AS root_id, tenant_id FROM up WHERE parent_project_id IS NULL)
UPDATE projects pr
SET product_id = anc.product_id, updated_at = now()
FROM roots r
JOIN projects anc ON anc.id = r.root_id
JOIN products ap ON ap.id = anc.product_id
WHERE pr.id = r.orig AND anc.product_id IS NOT NULL AND anc.tenant_id = pr.tenant_id
  AND ap.is_inbox = false;

-- (6) orfaos remanescentes PRE-FABRICA -> INBOX do MESMO tenant
UPDATE projects pr
SET product_id = (SELECT p.id FROM products p WHERE p.tenant_id = pr.tenant_id AND p.is_inbox)
WHERE pr.product_id IS NULL
  AND pr.status IN ('draft','spec_submitted','pending_conversion','spec_validation_failed')
  AND EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = pr.tenant_id AND p.is_inbox);

-- (6b) SAFETY-NET: QUALQUER orfao remanescente em FABRICA/terminal -> HOMONIMO PROPRIO, NUNCA inbox.
INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox, solo_app, system_id, origin_project_id)
SELECT o.tenant_id, o.created_by, o.title, 'App migrado (era orfao de fabrica, auto-criado na migracao 064).', 'active',
  CASE WHEN o.status='failed' THEN 'failed'
       WHEN o.status='accepted' THEN 'accepted'
       WHEN o.status='blocked_cyborg' THEN 'stalled_waiting_human'
       ELSE 'running' END,
  false, true,
  CASE
    WHEN o.base_slug IS NULL THEN 'app-' || substr(o.id::text, 1, 8)
    WHEN o.rn > 1 OR EXISTS (SELECT 1 FROM products p2 WHERE p2.tenant_id = o.tenant_id AND lower(p2.system_id) = o.base_slug)
      THEN o.base_slug || '-' || substr(o.id::text, 1, 8)
    ELSE o.base_slug END,
  o.id
FROM (
  SELECT pr.id, pr.tenant_id, pr.created_by, pr.title, pr.status,
    NULLIF(regexp_replace(regexp_replace(lower(pr.title), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '') AS base_slug,
    row_number() OVER (
      PARTITION BY pr.tenant_id,
        NULLIF(regexp_replace(regexp_replace(lower(pr.title), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '')
      ORDER BY pr.created_at, pr.id
    ) AS rn
  FROM projects pr
  WHERE pr.product_id IS NULL
    AND pr.status IN ('running','queued','cto_charter','pm_backlog','dev_qa','devops','pending_cyborg','blocked_cyborg','accepted','completed','stopped','failed')
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id)
) o;
UPDATE projects pr
SET product_id = (SELECT p.id FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id LIMIT 1)
WHERE pr.product_id IS NULL
  AND EXISTS (SELECT 1 FROM products p WHERE p.solo_app AND p.origin_project_id = pr.id);

-- (7) so agora: NOT NULL (idempotente)
ALTER TABLE projects ALTER COLUMN product_id SET NOT NULL;

-- (8) FK ON DELETE SET NULL -> NO ACTION
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_product_id_fkey;
ALTER TABLE projects ADD CONSTRAINT projects_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION;

COMMENT ON COLUMN products.is_inbox IS 'true = INBOX Rascunhos do tenant (so specs pre-fabrica, re-alocaveis). 1 por tenant (uq_products_inbox_per_tenant).';
COMMENT ON COLUMN products.solo_app IS 'true = produto homonimo de um App que roda sozinho (auto-criado ao promover do inbox ou na migracao 064).';
