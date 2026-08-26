<!-- Plano gerado por workflow adversarial (Opus 4.8) em 2026-08-26. 42 gaps fechados em 3 rodadas. Fonte de verdade para a implementacao em curso. -->

# PLANO DE IMPLEMENTAÇÃO — VERSÃO FINAL (aprovação)
## "Todo App pertence a um Produto; a Spec nasce organizada; App solo vira produto homônimo ao promover"

> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br
> Repo: Genesis · API `applications/services/api-node` · Portal `applications/apps/genesis-web` · branch `dev` · migration nova **064**.
> Rodada adversarial: **42 gaps confirmados e fechados** (G1–G15 + R3-1..R3-12 + cross-checks).

---

## 1. Sumário executivo

Hoje `projects.product_id` é nullable e specs "avulsas" ficam órfãs, criando Apps invisíveis e identidades Deadpool ambíguas. Esta mudança torna **`product_id` obrigatório (NOT NULL, FK `ON DELETE NO ACTION`)** e institui **duas casas explícitas**: um **INBOX "Rascunhos"** por tenant (só specs pré-fábrica, re-alocáveis) e **produtos homônimos** para cada App solo que roda sozinho (auto-criados na migração e ao promover do inbox). A **invariante central inviolável**: nenhum App em estado de fábrica/terminal vive no inbox — em nenhuma ordem de migration e em nenhum caminho de runtime. Preserva-se a identidade Deadpool (`system_id`) com **unicidade real por tenant** no banco. O rollout é o fluxo ECR canônico (API primeiro; migration aplica no boot), reversível por bloco de rollback manual documentado.

---

## 2. Modelo de dados final e invariantes

### 2.1 Tabela de mudanças

| Item | Antes | Depois |
|------|-------|--------|
| `projects.product_id` | `UUID NULL`, FK `ON DELETE SET NULL` (011:22) | `UUID NOT NULL`, FK `ON DELETE NO ACTION` |
| Órfão (`product_id IS NULL`) | possível | **impossível** |
| `products.is_inbox` | — | `BOOLEAN NOT NULL DEFAULT false` |
| `products.solo_app` | — | `BOOLEAN NOT NULL DEFAULT false` |
| INBOX por tenant | — | 1 produto `is_inbox=true`, `name='Rascunhos'`, `lifecycle_status='draft'`, `status='active'` |
| Unicidade inbox | — | `uq_products_inbox_per_tenant ON products(tenant_id) WHERE is_inbox` |
| Unicidade solo | — | `uq_products_solo_origin ON products(origin_project_id) WHERE solo_app` |
| Unicidade `system_id` | índice **não-único** (044:15) | `uq_products_system_id_per_tenant ON products(tenant_id, lower(system_id)) WHERE system_id IS NOT NULL` |
| Herança em filhos-versão | `parent.product_id ?? null` | herda a **raiz da linhagem** (`parent_project_id`), com guarda anti-inbox e anti-ciclo |
| Herança em componentes-decomp | — | herda `product_id` de **irmão do grafo `project_triggers`** |

### 2.2 As três casas

| Casa | `is_inbox` | `solo_app` | Contém | Invariante |
|------|-----------|-----------|--------|-----------|
| **INBOX "Rascunhos"** | `true` | `false` | Somente specs em `PRE_FACTORY_STATUSES` | Re-alocável enquanto rascunho. **Nunca** contém App em fábrica/terminal. 1 por tenant. |
| **Produto homônimo (solo)** | `false` | `true` | Um único App solo promovido/migrado | `name`=título, `system_id`=slug(título) desambiguado e único por tenant. |
| **Produto de entrega** | `false` | `false` | Grafo de Apps de uma decomposição (`project_triggers`) ou vínculo manual | Comportamento atual. |

### 2.3 Invariantes verificáveis

1. `projects.product_id` sempre NOT NULL.
2. `produto.is_inbox=true ⟺ projeto ∈ PRE_FACTORY_STATUSES`.
3. `system_id` único por `(tenant_id, lower(system_id))`.
4. `deriveSystemService(solo_app=true) ⇒ serviceId=null` e `systemId=product.system_id`.
5. Homônimo solo nunca fica com 0 projetos (cleanup atômico).

### 2.4 Duas relações NUNCA confundidas

- **Versionamento** = `parent_project_id` (migration 009).
- **Decomposição** = `project_triggers` + `product_id` direto (`productDecomposer.ts`).

### 2.5 Constantes canônicas — fonte única (`services/projectStatus.ts`, novo)

```ts
// Pré-fábrica / re-alocáveis como rascunho ⟺ elegíveis ao INBOX.
export const PRE_FACTORY_STATUSES = [
  "draft", "spec_submitted", "pending_conversion", "spec_validation_failed",
] as const;

// Fábrica-ativa / terminal — produção, NUNCA rascunho de inbox.
export const FACTORY_OR_TERMINAL_STATUSES = [
  "running", "queued", "cto_charter", "pm_backlog", "dev_qa", "devops",
  "pending_cyborg", "blocked_cyborg", "accepted", "completed", "stopped", "failed",
] as const;

export function isPreFactory(status: string): boolean {
  return (PRE_FACTORY_STATUSES as readonly string[]).includes(status);
}
```

> **Decisão G1:** `cto_charter`/`pm_backlog` = fábrica-ativa (`watchdog.ts:70` os lista em `MILESTONE_STATUSES`); `spec_validation_failed` = único não-`draft` pré-fábrica → INBOX.

---

## 3. Migration `064_products_inbox_and_product_id_notnull.sql`

**Runner** (`db/init.ts`): não-transacional, divide por `;`, remove linhas iniciadas por `--`, sem `DO`/PLpgSQL. `WITH`/`WITH RECURSIVE`/window functions são SQL puro (permitidos). Todos os statements idempotentes.

**Ordem exata:**
`colunas → dedup+unique system_id → rename legado 'Rascunhos' → índices únicos → inbox → detach cross-tenant → herança de DECOMPOSIÇÃO (project_triggers) → homônimos-solo (raízes órfãs em fábrica) → des-orfanização solo → herança de LINHAGEM (parent_project_id, CYCLE guard) → inbox (remanescentes pré-fábrica) → safety-net homônimo (remanescentes de fábrica) → NOT NULL → FK.`

```sql
-- Migration 064: todo projeto pertence a um produto. INBOX 'Rascunhos' (so pre-fabrica) +
-- produto homonimo por App SOLO em estado de fabrica/terminal. Runner nao-transacional; idempotente.
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
SELECT o.tenant_id, o.created_by, o.title, 'App migrado (era avulso; auto-criado na migracao 064).', 'active',
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

-- (5c) HERANCA DE LINHAGEM (parent_project_id) — roda DEPOIS de (5)/(5b). Guarda depth<64.
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
SELECT o.tenant_id, o.created_by, o.title, 'App migrado (era orfao de fabrica; auto-criado na migracao 064).', 'active',
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
```

### 3.1 Garantias de idempotência e ordem

- `uq_products_solo_origin` + `NOT EXISTS` ⇒ re-INSERT de homônimo é no-op; re-run após falha entre (5) e (5b) não cria 2º homônimo.
- `row_number` + `EXISTS(lower(system_id))` ⇒ desambiguação determinística e idempotente; título só-símbolos → `app-<id8>`.
- Homônimos-solo (5/5b) **antes** da linhagem (5c) ⇒ filho `running` herda o homônimo da raiz `stopped`; safety-net (6b) cobre remanescentes de fábrica sem raiz/irmão com produto não-inbox. Passo (6) só absorve pré-fábrica (filtro explícito de status).
- `depth < 64` nas duas CTEs recursivas ⇒ sem recursão infinita em ciclo legado.
- Lifecycle CASE = `deriveProductLifecycle([status])` (`productLifecycle.ts:36`) — `ELSE 'running'` é o valor canônico; teste §6.2 assevera igualdade.
- `SET NOT NULL` (7) só após todo órfão ter casa. Se (7) falhar, (1–6b) persistiram mas `schema_migrations` não gravou (`init.ts:43`) ⇒ re-run reexecuta idempotente e retenta.

### 3.2 Diagnóstico pré-deploy (manual no prod, FORA da migration)

```sql
SELECT count(*) FROM tenants;
SELECT status, count(*) FROM projects WHERE product_id IS NULL GROUP BY status;                       -- dimensiona 5/6/6b
SELECT count(*) FROM projects WHERE product_id IS NULL AND parent_project_id IS NOT NULL;              -- filhos-versao orfaos
-- componentes de DECOMPOSICAO orfaos (aresta em project_triggers):
SELECT count(*) FROM projects pr WHERE pr.product_id IS NULL
  AND EXISTS (SELECT 1 FROM project_triggers t WHERE t.project_id=pr.id OR t.trigger_project_id=pr.id);
-- ciclos em parent_project_id — DEVE ser 0:
WITH RECURSIVE up AS (
  SELECT id AS orig, id AS cur, parent_project_id, 0 AS depth FROM projects WHERE parent_project_id IS NOT NULL
  UNION ALL SELECT u.orig, p.id, p.parent_project_id, u.depth+1 FROM up u JOIN projects p ON p.id=u.parent_project_id WHERE u.depth<128
) SELECT count(*) FROM up WHERE depth >= 100;
-- system_id colidente por tenant (serao dedupados por 2c):
SELECT tenant_id, lower(system_id), count(*) FROM products WHERE system_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1;
-- produtos de usuario chamados 'Rascunhos' (serao renomeados por 2d):
SELECT id, tenant_id, name FROM products WHERE is_inbox=false AND btrim(lower(name))='rascunhos';
-- cross-tenant mismatch — DEVE ser 0:
SELECT pr.id FROM projects pr JOIN products p ON p.id=pr.product_id WHERE p.tenant_id<>pr.tenant_id;
-- colisoes de slug de titulo por tenant (serao desambiguadas em 5/6b):
SELECT tenant_id, lower(regexp_replace(title,'[^a-z0-9]+','-','g')) AS slug, count(*)
FROM projects WHERE product_id IS NULL AND parent_project_id IS NULL GROUP BY 1,2 HAVING count(*)>1;
```

---

## 4. Mudanças de API (por arquivo)

### 4.1 Novos serviços

**`services/projectStatus.ts`** (novo): `PRE_FACTORY_STATUSES`, `FACTORY_OR_TERMINAL_STATUSES`, `isPreFactory(status)`. Fonte única para backfill, detach, PATCH-null, graduação, decompose-consume.

**`services/inbox.ts`** (novo):
- `resolveInboxProductId(client, tenantId, createdBy)` — find-or-create idempotente, reativa inbox arquivado:
  ```sql
  INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox)
  VALUES ($tenant,$createdBy,'Rascunhos','...','active','draft',true)
  ON CONFLICT (tenant_id) WHERE is_inbox DO UPDATE SET status='active';
  SELECT id FROM products WHERE tenant_id=$tenant AND is_inbox;
  ```
- `graduateFromInbox(client, { projectId, tenantId, createdBy, title })` — cria/reusa homônimo e move o App, no client/transação do chamador:
  ```sql
  INSERT INTO products (tenant_id, created_by, name, status, lifecycle_status, is_inbox, solo_app, system_id, origin_project_id)
  VALUES ($tenant,$createdBy,$title,'active','running',false,true,$disambiguatedSlug,$projectId)
  ON CONFLICT (origin_project_id) WHERE solo_app DO UPDATE SET updated_at=now()
  RETURNING id;
  UPDATE projects SET product_id=$novoId, updated_at=now() WHERE id=$projectId;
  ```
  - `$disambiguatedSlug` computado lendo `lower(system_id)` existentes do tenant; em colisão, sufixo curto do id.
  - **Tratamento de 23505 em `system_id`:** capturar violação de `uq_products_system_id_per_tenant`, re-sufixar com mais bytes do id e retentar (loop N≤3).
  - Depois chama `recomputeProductLifecycle(client, novoId)`.
- `demoteToInbox(client, projectId, soloProductId)` — reverte o App ao inbox e remove o produto solo se recém-criado e sem outros projetos (rollback do dispatch).
- `cleanupEmptySoloProduct(client, productId)` — se produto é `solo_app`, `is_inbox=false` e ficou com 0 projetos, hard-delete na mesma transação.
- `normalizeProductId(raw)` — `(raw ?? '').trim() || null`.
- `assertProductOwnership(client, productId, tenantId)` — erro tipado se não pertence.

### 4.2 Funil de criação — `services/projectCreation.ts:96,184-189`
`normalizeProductId` na entrada. `null` → `resolveInboxProductId`. Explícito → `assertProductOwnership`. Cobre `POST /api/specs`, `catalog/:slug/use` e o decomposer.

### 4.3 `POST /api/specs` — `routes/specs.ts:533,599-606`
`productId` via `normalizeProductId`; null → inbox; presente → posse validada.

### 4.4 `POST /api/catalog/:slug/use` — `routes/catalog.ts:101`
Fluxo via §4.2 (null→inbox, presente→posse).

### 4.5 Telegram — corrigir DENTRO de `saveProjectSpec` — `routes/telegram.ts:1014-1037`
- No ponto do INSERT (`telegram.ts:1037`), dentro do helper: `const pid = normalizeProductId(params.productId) ?? await resolveInboxProductId(client, params.tenantId, params.userId)`. Cobre os 4 chamadores: `1101` (/new project), `1147`/`1311` (multi-doc) e `1345` (doc único).
- `telegram.ts:799`: bucket `'__standalone__'` vira código morto → remover; agrupar por produto; filtro do agrupamento por `PRE_FACTORY_STATUSES`.

### 4.6 Evolução (nova versão) — `routes/projects.ts:2917,2926`
Trocar `parentRow.product_id ?? null` por: se produto-pai `status='archived'` **ou** `is_inbox=true` → `resolveInboxProductId`; senão herdar `parent.product_id`. Nunca gravar `null`.

### 4.7 Decompor — `routes/products.ts:447-458` + `services/productDecomposer.ts:113-180`
- Guarda 409: barrar só se `is_inbox=false` (`if (proj.product_id && !proj.product_is_inbox) return 409 ALREADY_IN_PRODUCT`).
- Consumir a spec de origem dentro da transação do decomposer (entre criação dos filhos e o COMMIT :180), COM GUARDA DE STATUS:
  ```sql
  UPDATE projects SET product_id=$novoProdutoId, status='archived', updated_at=now()
  WHERE id=$originProjectId AND status IN ('draft','spec_submitted','pending_conversion','spec_validation_failed');
  ```
  Se `rowCount=0` (origem já graduou via `/run` concorrente) → abortar consumo, não desvincular App vivo; sinalizar `originAlreadyPromoted:true`.
- Fechar a janela: no dispatch do `POST /decompose`, marcar origem `pending_conversion` (pré-fábrica, ainda no inbox).
- Reuse idempotente (`buildReuseResult`/handler 23505): mesmo consumo com a mesma guarda; se 0 linhas, não desvincular.

### 4.8 PATCH associar produto — `routes/products.ts:888-912`
- `productId` presente (não-inbox, mesmo tenant) → mover livremente (inclui App rodando). Manter posse do alvo.
- `null`/ausente → "mover para o inbox" SÓ se rascunho: `SELECT status, product_id`; se `status NOT IN PRE_FACTORY_STATUSES` → `409 APP_RUNNING_CANNOT_INBOX`. Caso rascunho → `resolveInboxProductId`.
- Envolver em transação (`client` + BEGIN/COMMIT): guardar `product_id` anterior; após mover, se produto anterior era `solo_app` e ficou com 0 projetos → `cleanupEmptySoloProduct(client, previousProductId)`.

### 4.9 DELETE "tirar do produto" — `routes/products.ts:793-816`
Mesmo predicado: `NOT IN PRE_FACTORY_STATUSES` → `409 APP_RUNNING_CANNOT_INBOX`. Se rascunho → `SET product_id=<inbox>, updated_at=now()`. Se produto de origem era `solo_app` e ficou vazio → `cleanupEmptySoloProduct` na mesma transação.

### 4.10 Proteger o INBOX — `routes/products.ts`
- **DELETE `/api/products/:id`** (`652-735`): incluir `is_inbox` no SELECT (:662); se `is_inbox` → `409 INBOX_PROTECTED` (hard e soft). Homônimo (`solo_app`) segue fluxo normal.
- **PATCH `/api/products/:id`** (`738-766`): após carregar `owner`, ler `is_inbox`; se `true`, rejeitar mudança de `status` e de `name` → `409 INBOX_PROTECTED` (aceitar só `description`, opcional).

### 4.11 Auto-graduação atômica pós-portões — `routes/pipeline.ts:82`
O `/run` não é transacional (client do pool sem BEGIN; `claimSlotOrQueue` roda em transação própria). Tratar como saga com compensação:
1. `checkProjectAccess` (404) → rate limit (429) → status ∈ `ALLOWED_STATUS_FOR_RUN` (409) → `checkDependencyGate` (409) → `getProjectSpecFilePath` (400 se faltar `.md`).
2. `claimSlotOrQueue`:
   - **`queued`:** graduar agora em `BEGIN/COMMIT` no client do `/run` (`graduateFromInbox`→`recomputeProductLifecycle`). Retornar `queued`.
   - **`started`:** prosseguir ao dispatch.
3. Dispatch:
   - Antes do sucesso, num `BEGIN`: `graduateFromInbox` (se `is_inbox`) → `UPDATE status='running'` → `COMMIT`.
   - Em falha: `revertSlotClaim(projectId, previousStatus)` **e** `demoteToInbox(...)` num `BEGIN/COMMIT`; retornar 500/503.
- Fora do inbox: `/run` não realoca (Decisão 5). Idempotência: 2º `/run` → no-op (`ON CONFLICT origin_project_id`). Graduação trata 23505 com retry re-sufixando.

### 4.12 Bloquear promoção em bloco do inbox — `routes/products.ts:574`
`POST /api/products/:id/promote`: se `is_inbox` → `409 INBOX_NOT_PROMOTABLE`.

### 4.13 `recomputeProductLifecycle` isenta o inbox — `services/productLifecycle.ts:60`
Curto-circuito: `SELECT is_inbox`; se `is_inbox` → não recomputar. Homônimo **não** é isento.

### 4.14 Bloquear nome reservado — `POST /api/products` e rename (§4.10)
Rejeitar `name` que normalize para "rascunhos" (case/acento/trim-insensível) com `is_inbox=false` → `409 RESERVED_PRODUCT_NAME`. (Legado colidente já renomeado pela migration 2d.)

### 4.15 GET listagens — flags, filtros, aging
- `GET /api/products` (`160-189`): default `WHERE is_inbox=false`. `?includeInbox=1` inclui o inbox. Expor `solo_app`, `is_inbox`, `origin_project_id`, `auto_created_migration` (`description LIKE '%migracao 064%'`). Ocultar (ou marcar `empty=true`) homônimos `solo_app` com 0 projetos por padrão.
- `GET /api/projects` (`82-181`): remover `WHERE product_id IS NOT NULL` e o `CASE ... NULLS FIRST` (mortos). Expor `product_is_inbox`, `product_solo_app`. Ordenar por fluxo. Expor `age_days`, `inbox_count`, `inbox_stale_count`.
- `GET /api/zentriz/projects` (master): expor `product_is_inbox`, `product_id`, `product_name` por linha.
- `GET /api/specs`: incluir `product_is_inbox`.

### 4.16 Signup / criação de tenant
- `routes/signup.ts:200-238`: na mesma transação, após criar `tenant_admin`, chamar `resolveInboxProductId(client, tenantId, adminUserId)`.
- `routes/tenants.ts:218`: ao provisionar tenant **e criar o 1º usuário** (com `created_by` disponível), chamar `resolveInboxProductId(client, tenantId, firstUserId)` na mesma transação — elimina divergência eager/lazy. Se tenant criado sem usuário, manter lazy (fallback na 1ª spec).

### 4.17 `deriveSystemService` — preservar identidade do App solo — `services/githubPush.ts:100`
- Parâmetro `soloProduct?: boolean`. No ramo `solo_app=true`: `systemId = product.system_id` (slug desambiguado) e **`serviceId = null` explicitamente**.
- **Enumeração obrigatória das três SELECTs:**
  - `githubPush.ts:251` — adicionar `pr.solo_app AS product_solo_app`; passar `soloProduct: row.product_solo_app` na chamada :390.
  - `routes/deadpool.ts:394` — adicionar `pr.solo_app AS product_solo_app`; passar `soloProduct` na chamada :441.
  - `routes/deadpool.ts:569` — adicionar `pr.solo_app AS product_solo_app`; passar `soloProduct` na chamada :584.
- Guard defensivo: se `is_inbox`, cair em `slug(title)` e logar aviso.
- Auditoria Deadpool: Apps cujo slug foi desambiguado por sufixo — auditar/renomear o registro `systemId` no lado Deadpool (evitar serviço órfão bare-slug). Documentar no runbook (§7).

### 4.18 Branches mortos
`telegram.ts:799` `__standalone__`; `projects.ts` `NULLS FIRST`. Caminho "standalone" (`projects.ts:646-660`, `githubPush.ts:97,387`): pós-backfill o path canônico sempre tem `product_id`; o standalone é reaproveitado logicamente pelo `solo_app` (`serviceId=null`).

### 4.19 DELETE `/api/users/:id` — reatribuir produtos antes de deletar — `routes/users.ts:219-260`
`products.created_by` é ON DELETE CASCADE (011:10); pós-064 apagar produtos referenciados por projetos de outros usuários → 23503 → 409. Correção, na mesma transação, antes do `DELETE FROM users`:
```sql
-- outro admin do MESMO tenant (preferir tenant_admin mais antigo; senao qualquer user)
reassignee := SELECT u.id FROM users u WHERE u.tenant_id=$targetTenant AND u.id<>$targetId
              ORDER BY (u.role='tenant_admin') DESC, u.created_at LIMIT 1;
-- se reassignee IS NULL -> 409 { code:'LAST_USER_OWNS_PRODUCTS' }
UPDATE products SET created_by=$reassignee WHERE created_by=$targetId;   -- cobre is_inbox, solo_app e comuns
```
Manter checagem de projetos próprios (`users.ts:245`) e rede de segurança 23503 (`users.ts:252`). Mudança de comportamento registrada em §7/Riscos.

---

## 5. Mudanças no Portal (`genesis-web`)

### 5.1 Menu por FLUXO (Decisão 6) — `components/AppLayout.tsx:83-93,116-131`
- Nova ordem de `navUser`: **Dashboard → Enviar spec → Bancada → Meus apps → Meus produtos → Notificações** (entrada/desenho antes de saída).
- Atualizar o comentário `:83-85` refletindo a nova ordem e citando a Decisão 6 (2026-08-26) como autoridade que supersede o pedido de 2026-08-25.
- `Meus projetos` → **`Meus apps`** (minúsculo).
- **Colisão master (3 variantes):** `navZentriz` faz `[...navUser, ...]` e declara `Projetos → /zentriz/projects`. Construir `navZentriz` sem herdar cegamente `/projects`: relabelar o herdado para **`Apps do tenant`** e o global `/zentriz/projects` para **`Apps (todos os tenants)`**. Validar user, tenant_admin, master (com/sem tenant) — nunca dois rótulos idênticos.

### 5.2 Página cross-tenant do master (tabela plana) — `app/(dashboard)/zentriz/projects/page.tsx:38-73`
- A página é uma tabela plana (Título/Tenant/Status/Recursos/Atualizado/Ações), sem seções.
- Adicionar coluna **"Produto"** exibindo `product_name`; quando `product_is_inbox=true`, badge **"Rascunhos (inbox) — infra"**.
- Toggle **"Ocultar rascunhos (inbox)"** (default ligado) que filtra client-side linhas com `product_is_inbox=true`.
- Copy: "Gestão global de projetos" → "Gestão global de Apps (todos os tenants)"; "Exibindo projetos…" → "…Apps…"; "Nenhum projeto encontrado" → "Nenhum App encontrado".

### 5.3 Criação de spec — `app/(dashboard)/spec/page.tsx:475,502-508,897,1139,1175,1210`
- Select de produto via `GET /api/products?includeInbox=1`. Remover `MenuItem value="" "Nenhum / Projeto standalone"`; item do inbox rotulado **"Rascunhos (inbox)"** (via `is_inbox`). Default: produto herdado do contexto, senão o inbox.
- **Fallback:** se a lista não contém item `is_inbox`, injetar opção sintética "Rascunhos (inbox)" com value sentinela vazio (`""`), pré-selecionada; backend resolve via `normalizeProductId`→`resolveInboxProductId`.
- `handleSaveSpec`/`handleUploadSubmit`: sempre `append("productId", productId)`. Nova versão (`/spec?parentProjectId=`): herdar `product_id` do pai. Corrigir legenda duplicada (`:502-508`).

### 5.4 Bancada — ÚNICO lugar do inbox — `app/(dashboard)/specs/page.tsx:208-243,289-290,411,417,452-461`
- Bucket `product_id=inbox` → grupo **"Rascunhos (inbox)"** por `product_is_inbox`, com destaque "caixa de entrada, re-alocável".
- Filtrar por `PRE_FACTORY_STATUSES` (não só is_inbox): App graduado aparece sob o homônimo.
- Badge de contagem (`inbox_count`) e marca de rascunhos antigos (`age_days > N`, via `inbox_stale_count`).
- Botão **Decompor** (`:289-290`): habilitar quando `s.product_is_inbox === true`. Botão **Promover** (`:417`): esconder quando `product_is_inbox===true`. Diálogo "Vincular SPEC" (`:452-461`): opções de `?includeInbox=1`; `confirmLink` envia id do inbox, nunca `null`.
- DELETE/arquivar de spec individual dentro do inbox continua funcionando (proteção §4.10 é do PRODUTO inbox).

### 5.5 Cockpit — `app/(dashboard)/projects/[id]/page.tsx:2343-2351,2367-2369,2422-2426,2496`
"Desvincular do produto" (`:2369`, `{productId:null}`) → **"Mover para outro produto"** (inclui "Rascunhos (inbox)" apenas quando o App está em rascunho; para App em execução, ocultar/desabilitar a opção inbox e exigir destino = produto real — espelha o 409). Remover estado "Sem produto vinculado" (`:2422-2426`).

### 5.6 Meus apps — SEM DRAFTS (RFC-0003 F2 mantido) — `app/(dashboard)/projects/page.tsx:342-384,441-443,452,489,534-560,637-638`
- **NÃO recriar** seção "Rascunhos (inbox)" em /projects. O inbox vive só na Bancada.
- Manter filtro real de drafts `:441-443` (`!PRE_FACTORY_STATUSES.has(p.status) && p.status !== "archived"`). Alinhar o set local `:333` à constante backend incluindo `spec_validation_failed` (hoje ausente).
- **Filtrar produtos inbox:** excluir de Meus apps qualquer projeto com `product_is_inbox===true` (defesa robusta independente do set de status).
- `buildProductSections` (`342-384`): remover o ramo `productId: null` / "standalone" (`:379-383`, código morto pós-migração).
- Título → **`Meus apps`** (`:489`). Filtro (`:452`): simplificar (ramo morto `!selectedProductId && !p.productId`). Empty state/CTAs "projeto"→"app".

### 5.7 Aviso de migração — CTA único dispensável (1ª visualização)
(a) "Rascunhos" é a caixa de entrada do sistema (na **Bancada**), não um produto criado por você; (b) "cada App avulso que já rodava virou seu próprio produto (auto-criado na migração)" — badge "auto-criado na migração" (`auto_created_migration`/`solo_app`).

### 5.8 Dashboard — `app/(dashboard)/dashboard/page.tsx:203-204,311-318,396-423`
"Projetos avulsos" / `standaloneProjects` → representar o INBOX como atalho para a **Bancada** (não uma seção de apps), com contador, ou fundir na listagem.

### 5.9 Meus produtos — `app/(dashboard)/products/page.tsx:156,174`
Inbox não aparece. Homônimos (`solo_app`) aparecem, diferenciados: badge "auto-criado na migração"; quando dois produtos compartilham `name` no mesmo tenant, sufixo curto client-side no rótulo (`«Loja» ·a1b2c3d4`) — sem mangling do `name` no banco. Homônimos `solo_app` com 0 projetos não aparecem (ocultos por §4.15). Ajustar empty state.

### 5.10 Ajuda Telegram — `app/(dashboard)/settings/telegram/page.tsx:254`
"/new project — cria projeto standalone" → "cria um App em Rascunhos (inbox), na Bancada; ao promover, ele vira um produto próprio".

---

## 6. Plano de testes (vitest api-node — ~614 verdes)

> Quase tudo é mock-based (fake pool) e não bate NOT NULL nem constraints. A quebra real só aparece em `integration.test.ts`/`migrations.test.ts` com Postgres up. **Não confiar na contagem verde** — R3-5, R3-1, R3-2, R3-4 exigem DB real e queries não-mockadas.

### 6.1 Fixtures/asserts obsoletos
- `integration.test.ts:63,832`: inbox criado antes do 1º POST; asserir `res.body.productId` = inbox.
- `routes/products.decompose.test.ts:46,49,116`: fixture `product_id:null` → `product_is_inbox:true`; decompose do inbox permitido; novo 409 para produto real; assert origem `status='archived'` (consumida) e concorrente: origem já `running` → consumo NÃO arquiva (rowCount 0, App preservado).
- `seed-example-projects.ts:47,65`: incluir `product_id` (inbox).

### 6.2 Novos testes de migração (`migrations.test.ts:33`, Postgres real)
- 064 deixa `product_id` NOT NULL.
- v1 raiz `stopped` (parent NULL, product NULL) + v2 filho `running` (parent=v1, product NULL) → v2 em produto NÃO-inbox (homônimo herdado da raiz), NUNCA no inbox.
- Filho `running` cuja raiz é `draft` (foi p/ inbox) → filho ganha homônimo próprio (safety-net 6b), não inbox.
- Órfão SOLO em fábrica → homônimo `system_id=slug`; `spec_validation_failed`/`draft`/`spec_submitted`/`pending_conversion` → INBOX; `cto_charter`/`pm_backlog` → homônimo.
- Componente de decomposição órfão (aresta `project_triggers`, `parent_project_id NULL`) → herda o product do irmão do grafo, não vira solo.
- Dois produtos legados com mesmo `lower(system_id)` no tenant → dedup (2c) sufixa o 2º, `CREATE UNIQUE` passa; após 064, INSERT de `system_id` duplicado → 23505.
- Dado cíclico em `parent_project_id` (A.parent=B, B.parent=A) → migration termina (corte `depth<64`).
- Produto de usuário `name='Rascunhos'` (is_inbox=false) → renomeado para 'Rascunhos (produto)'; inbox 'Rascunhos' criado sem conflito.
- Dois solos de mesmo título → `system_id` desambiguado; título só-símbolos → `system_id='app-<id8>'`; re-run após falha entre (5) e (5b) não cria 2º homônimo; `lifecycle` da 064 == `deriveProductLifecycle([status])`; cross-tenant desanexado e reclassificado.

### 6.3 Novos testes de runtime
- **Auto-graduação pós-portões:** `/run` de spec no inbox com dispatch OK → App sai do inbox, ganha homônimo; dependencyGate 409 / sem .md 400 → NÃO gradua; queued → gradua com lifecycle coerente; dispatch falha → `demoteToInbox` reverte; 2º `/run` no-op; dois `/run` concorrentes de mesmo título → um sufixa via retry 23505, `system_id` distintos.
- **Detach/PATCH-null:** App `running`/`accepted` → `DELETE /products/:id/projects/:pid` e `PATCH /product {null}` → 409; App `draft` → volta ao inbox OK; PATCH com destino produto real → OK mesmo rodando.
- **Cleanup de homônimo esvaziado:** mover o único App de um `solo_app` para produto real → homônimo hard-deletado na mesma transação; não aparece em Meus Produtos.
- **Deadpool identity (NÃO-MOCKADO):** com query real, produto `solo_app` → `serviceId=null`, `systemId=product.system_id`; as três SELECTs selecionam `solo_app` e o repassam.
- **DELETE usuário:** admin fundador dono do inbox, sem projetos próprios, com outro admin no tenant → DELETE reatribui produtos e sucede (não 409); último usuário do tenant dono de produtos → 409 `LAST_USER_OWNS_PRODUCTS`.
- **Onboarding:** tenant criado por master com 1º usuário → inbox já existe; `/spec` do 1º uso tem "Rascunhos (inbox)" default.
- `recomputeProductLifecycle` isenta inbox; Promote em bloco → 409; Evolução sob produto arquivado → inbox; `normalizeProductId ""`→inbox (funil/specs/catalog/Telegram); Telegram (4 callers, upload doc único 1345); Nome reservado 409; includeInbox; INBOX protegido (DELETE/PATCH status/PATCH name → 409); INBOX individual (delete de spec ok); FK NO ACTION (hard-delete homônimo 0 projetos ok, com filhos bloqueia).

---

## 7. Rollout / Deploy e matriz de riscos

### 7.1 Pré-deploy (identidade Deadpool)
Antes do backfill, auditar em staging/dump quais Apps standalone já estão no Deadpool (`systemId=slug(título)`, `serviceId=null`). Rodar o diagnóstico §3.2: contagem por status; componentes de decomposição órfãos (via `project_triggers`); ciclos em `parent_project_id` (deve ser 0); colisões de `system_id` por tenant (serão dedupadas por 2c); produtos 'Rascunhos' de usuário (renomeados por 2d). Listar Apps cujo slug será desambiguado por sufixo e planejar rename correspondente no lado Deadpool.

### 7.2 Fluxo (API primeiro — migration no boot; ECR canônico)
1. Local: suite completa com Postgres real (`dbAvailable=true`) — inclui os novos testes de migração. Diagnóstico §3.2 em dump/staging.
2. Build local `api` (+ `genesis-web`) → `ecr-push.sh 820198199720 us-east-1 api genesis-web`.
3. Prod (SSH `3.220.66.113`): tag rollback do id atual; pull/retag/`compose up -d --no-build --force-recreate api` **primeiro**; depois `genesis-web`.
4. Verificar: digest == buildado; `/health`; spec sem produto → nasce em Rascunhos (Bancada); promover spec do inbox → App sai do inbox e ganha homônimo; detach de App rodando → 409; decompor do inbox → 200 e origem arquivada; decompor + promover concorrente → origem preservada; `?includeInbox=1`; promover inbox em bloco → 409; excluir/arquivar/renomear inbox → 409; DELETE do admin fundador com reatribuição → sucede.
5. Rollback: bloco de rollback do cabeçalho da 064 + `DELETE FROM schema_migrations WHERE version='064_...'`; retag `rollback-api:pre-inbox`.

### 7.3 Matriz de riscos (todos endereçados)

| Risco | Mitigação |
|-------|-----------|
| Crash-loop no boot se backfill não preceder `SET NOT NULL` | Ordem §3: (7) só após (1–6b). |
| App de fábrica caindo no inbox por ordem de migration | Homônimos-solo (5/5b) antes da linhagem (5c) + safety-net (6b) + filtro de status no passo (6). |
| Componente de decomposição virando solo | Herança via `project_triggers` (4-tr) antes de (5); `parent_project_id` reservado a versionamento. |
| `system_id` Deadpool duplicado sob concorrência | Dedup legado (2c) + `uq_products_system_id_per_tenant` + retry 23505 em `graduateFromInbox`. |
| Recursão infinita no boot por ciclo em `parent_project_id` | Corte `depth<64` nas CTEs + diagnóstico de ciclo pré-deploy. |
| `serviceId` regredindo null→slug em App solo | As três SELECTs passam `solo_app`; ramo solo mantém `serviceId=null`; teste não-mockado; auditoria de rename no Deadpool. |
| Admin fundador indeletável / DELETE usuário 409 | Reatribuição de `created_by` dos produtos no `DELETE /api/users/:id` antes do delete; **mudança de comportamento registrada** (agora reatribui produtos silenciosamente; 409 só quando é o último usuário dono de produtos). |
| Homônimo-fantasma vazio ao mover o único App | `cleanupEmptySoloProduct` no PATCH/DELETE + ocultação na listagem. |
| Dois 'Rascunhos' coexistindo | Rename do produto de usuário legado (2d) + `RESERVED_PRODUCT_NAME` para writes novos. |
| Drafts reintroduzidos em Meus apps / RFC-0003 F2 quebrado | Inbox só na Bancada; §5.6 não recria seção; filtro 441-443 mantido + filtro `product_is_inbox`; null-branch removido. |
| Menu fora de ordem de fluxo | Reordenação por fluxo implementada (Decisão 6) + comentário atualizado. |
| Tabela plana do master sem coluna de produto | Coluna "Produto" + badge "Rascunhos (inbox)" + toggle de ocultar drafts. |
| Onboarding divergente eager/lazy | Inbox criado no 1º usuário do tenant provisionado + fallback sintético no `/spec`. |
| CI mascarado (verde sem DB) | Validar asserts com DB up; testes de identidade e migração não-mockados. |
| G1–G15 (rodadas anteriores) | Partição de status, 409 em detach de App rodando, `uq_products_solo_origin`, saga de graduação, guarda de janela do decompose, Telegram helper, INBOX_PROTECTED, relabel de menu master, badges/aging, caixa "Meus apps" — preservados. |

---

## 8. ASSUNÇÕES / decisões que ainda dependem do Jean

| # | Assunção adotada | O que confirmar |
|---|-----------------|-----------------|
| **A1** | FK `ON DELETE NO ACTION` (CASCADE proibido). | OK como está? |
| **A6** | Decompor a partir do INBOX permitido; de produto real → 409. Ao aprovar, spec de origem é consumida (arquivada). | Confirmar semântica de "consumir origem". |
| **A7** | Auto-graduação: `/run` de spec no inbox cria/entra em produto homônimo após todos os portões e o claim/dispatch (Decisão 5: fora do inbox `/run` não muda produto). | Confirmar auto-graduação vs. exigir escolha explícita de produto no portal ao promover. |
| **A10 / Decisão 6** | Nova ordem do menu: **Dashboard → Enviar spec → Bancada → Meus apps → Meus produtos → Notificações** (por fluxo). | **Confirmar a ordem exata** (a Decisão 6 supersede o comentário de 2026-08-25). |
| **A12** | Termo "App" padronizado em caixa minúscula (`Meus apps`, `Apps do tenant`, `Apps (todos os tenants)`). | Confirmar se "App" entra oficialmente como termo PT-BR (afeta empty states, titles, copy §5.2/§5.6/§5.8). |
| **R3-6 / A4** | `DELETE /api/users/:id` passa a **reatribuir silenciosamente** os produtos (inbox, solo, comuns) do usuário-alvo para outro admin; 409 `LAST_USER_OWNS_PRODUCTS` só quando é o último usuário dono de produtos. | Confirmar a mudança de comportamento do endpoint (antes o CASCADE apagava produtos de admins sem projetos). |
| **R3-9 / RFC-0003 F2** | Inbox/Rascunhos vive **só na Bancada**; "Meus apps" fica livre de drafts (RFC-0003 F2 mantido). | Confirmar que NÃO se deseja duplicação Bancada×Meus apps. |
| **A3** | `created_by` do inbox/homônimo = `COALESCE(tenant_admin mais antigo, qualquer user, created_by de projeto)`; durabilidade da deleção garantida por §4.19, não pela escolha. | OK. |
| **Aging** | Marca de "rascunho antigo" em `age_days > N`. | Definir `N` (dias). |
