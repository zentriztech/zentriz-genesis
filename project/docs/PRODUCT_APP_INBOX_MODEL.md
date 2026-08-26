# Modelo Produto · App · INBOX — o modelo canônico do Genesis

> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br
> **Status:** ✅ EM PRODUÇÃO desde 2026-08-26 (`genesis.zentriz.com.br`). Migração **064** aplicada.
> Este é o **modelo de domínio canônico** do Zentriz Genesis. Onde qualquer outro documento
> divergir deste, **este vence** para o que descreve (organização Produto/App/Spec/INBOX).
> Fontes: plano de implementação [`plans/PLANO_PRODUCT_MANDATORY_INBOX_2026-08-26.md`](plans/PLANO_PRODUCT_MANDATORY_INBOX_2026-08-26.md)
> e [`rfc/RFC-0003-SPEC-BANCADA-E-SPLITTER-VIVO.md`](rfc/RFC-0003-SPEC-BANCADA-E-SPLITTER-VIVO.md).

---

## 1. Princípio central

> **Todo App pertence a um Produto. A Spec nasce organizada. Um App que roda sozinho vira um produto homônimo ao ser promovido.**

Não existe mais App "avulso"/"standalone". `projects.product_id` é **NOT NULL**: todo projeto tem uma casa
desde o instante em que nasce. Specs que ainda não foram organizadas em um produto real vivem numa **caixa
de entrada por tenant** — o **INBOX "Rascunhos"** — e só lá; assim que entram em fábrica, saem do inbox e
ganham um produto de verdade.

---

## 2. Glossário (termos oficiais PT-BR)

| Termo | O que é |
|-------|---------|
| **Produto** | Guarda-chuva que agrupa Apps (projetos) relacionados. É a unidade de topo. |
| **App** | Um projeto (`projects`). Termo oficial de UI em minúsculo: "Meus apps", "Apps do tenant". Substituiu "Meus projetos". |
| **Spec** | Requisito enviado pelo usuário; nasce como App em estado pré-fábrica dentro de um Produto (o INBOX, por padrão). |
| **Bancada** (`/specs`) | Pré-fábrica: onde vivem os rascunhos e o Decompor. **Único lugar onde o INBOX aparece.** |
| **INBOX "Rascunhos"** | Produto especial, 1 por tenant (`is_inbox=true`), que contém **somente** specs pré-fábrica re-alocáveis. Infra do sistema, não um produto criado pelo usuário. |
| **Produto homônimo (solo)** | Produto auto-criado (`solo_app=true`) para um App que roda sozinho — na migração 064 ou ao promover do inbox. `name` = título do App. |
| **Produto de entrega** | Produto "comum" (`is_inbox=false`, `solo_app=false`): grafo de Apps de uma decomposição ou vínculo manual. |

---

## 3. As três casas de um App

Todo App vive em exatamente uma destas três casas:

| Casa | `is_inbox` | `solo_app` | Contém | Invariante-chave |
|------|:---------:|:---------:|--------|------------------|
| **INBOX "Rascunhos"** | `true` | `false` | Só specs em `PRE_FACTORY_STATUSES` | Re-alocável enquanto rascunho. **Nunca** contém App em fábrica/terminal. Máx. **1 por tenant**. |
| **Produto homônimo (solo)** | `false` | `true` | Um único App solo (migrado/promovido) | `name`=título; `system_id`=slug(título) desambiguado e único por tenant. Nunca fica com 0 Apps (cleanup atômico). |
| **Produto de entrega** | `false` | `false` | Grafo de Apps de uma decomposição ou vínculo manual | Comportamento clássico de produto. |

**Invariante central inviolável:** nenhum App em estado de fábrica/terminal vive no inbox — em nenhuma ordem
de migração e em nenhum caminho de runtime.

---

## 4. Modelo de dados (migração 064)

Arquivo: `applications/services/api-node/src/db/migrations/064_products_inbox_and_product_id_notnull.sql`
(auto-aplicada no boot da API; runner não-transacional, idempotente).

| Item | Antes | Depois |
|------|-------|--------|
| `projects.product_id` | `UUID NULL`, FK `ON DELETE SET NULL` | **`UUID NOT NULL`, FK `ON DELETE NO ACTION`** |
| Órfão (`product_id IS NULL`) | possível | **impossível** |
| `products.is_inbox` | — | `BOOLEAN NOT NULL DEFAULT false` |
| `products.solo_app` | — | `BOOLEAN NOT NULL DEFAULT false` |
| Unicidade inbox | — | `uq_products_inbox_per_tenant ON products(tenant_id) WHERE is_inbox` |
| Unicidade homônimo | — | `uq_products_solo_origin ON products(origin_project_id) WHERE solo_app` |
| Unicidade `system_id` (identidade Deadpool) | índice não-único | `uq_products_system_id_per_tenant ON products(tenant_id, lower(system_id)) WHERE system_id IS NOT NULL` |

**Backfill (ordem):** colunas → dedup+unique `system_id` → rename de 'Rascunhos' legado → índices únicos →
cria INBOX por tenant → desanexa cross-tenant → herança de **decomposição** (`project_triggers`) →
homônimos-solo (raízes órfãs em fábrica) → des-orfanização solo → herança de **linhagem**
(`parent_project_id`, com guarda anti-ciclo `depth<64`) → órfãos pré-fábrica remanescentes → INBOX →
safety-net (órfão de fábrica → homônimo, nunca inbox) → `SET NOT NULL` → troca da FK.

### Invariantes verificáveis
1. `projects.product_id` sempre NOT NULL.
2. `produto.is_inbox=true ⟺ App ∈ PRE_FACTORY_STATUSES`.
3. `system_id` único por `(tenant_id, lower(system_id))`.
4. App em produto `solo_app=true` ⇒ identidade Deadpool `serviceId=null`, `systemId=product.system_id`.
5. Produto homônimo nunca fica com 0 Apps (cleanup atômico).

### Duas relações que NUNCA se confundem
- **Versionamento** = `parent_project_id` (v2 é filho de v1).
- **Decomposição** = `project_triggers` + `product_id` direto.

---

## 5. Estados canônicos — fonte única

`applications/services/api-node/src/services/projectStatus.ts`:

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
```

> `cto_charter`/`pm_backlog` são **fábrica-ativa**; `spec_validation_failed` é o único não-`draft` que
> continua pré-fábrica (elegível ao INBOX).

---

## 6. Regras de runtime

Serviços em `applications/services/api-node/src/services/inbox.ts` (`resolveInboxProductId`,
`graduateFromInbox`, `demoteToInbox`, `cleanupEmptySoloProduct`, `normalizeProductId`,
`assertProductOwnership`).

- **Criação de Spec** (`/api/specs`, `catalog/:slug/use`, decomposer, Telegram): `productId` ausente/`""` →
  resolve o INBOX do tenant (find-or-create idempotente). `productId` presente → valida posse (mesmo tenant).
- **Promoção / auto-graduação** (`/api/pipeline/:id/run`): quando uma spec do inbox passa por todos os portões
  e o dispatch tem sucesso, ela **sai do inbox** e ganha (ou reusa) um **produto homônimo solo**. Falha no
  dispatch → `demoteToInbox` reverte. Fora do inbox, `/run` não realoca produto.
- **Mover App entre produtos** (`PATCH /api/products/... {productId}`): mover para produto real (não-inbox,
  mesmo tenant) é livre — inclusive App rodando. Mover **de volta ao inbox** só é permitido se o App for
  rascunho; App em fábrica → `409 APP_RUNNING_CANNOT_INBOX`. Se o produto de origem era `solo_app` e ficou
  vazio → hard-delete atômico (`cleanupEmptySoloProduct`).
- **Decompor** (`/api/products/.../decompose`): permitido a partir do INBOX; barrado (409) se o App já está
  num produto real. A spec de origem é **consumida** (arquivada) na mesma transação, com guarda de status
  (se já graduou por `/run` concorrente, não desvincula o App vivo).
- **Evolução (nova versão)**: herda `product_id` do pai; se o pai está arquivado ou é o inbox → resolve inbox.
  Nunca grava `null`.

---

## 7. Superfície de API — proteções e códigos de erro

| Endpoint | Regra | Código de erro |
|----------|-------|----------------|
| `DELETE /api/products/:id` | INBOX não pode ser excluído (hard nem soft) | `409 INBOX_PROTECTED` |
| `PATCH /api/products/:id` | INBOX não muda `status` nem `name` (só `description`) | `409 INBOX_PROTECTED` |
| `POST /api/products` / rename | `name` que normaliza para "rascunhos" (não-inbox) é rejeitado | `409 RESERVED_PRODUCT_NAME` |
| `POST /api/products/:id/promote` | INBOX não é promovível em bloco | `409 INBOX_NOT_PROMOTABLE` |
| `PATCH`/`DELETE` mover App→inbox | Só rascunho volta ao inbox; App em fábrica não | `409 APP_RUNNING_CANNOT_INBOX` |
| `DELETE /api/users/:id` | Reatribui produtos (`created_by`) a outro admin antes de deletar; 409 só se for o último usuário dono de produtos | `409 LAST_USER_OWNS_PRODUCTS` |
| `GET /api/products` | Oculta o INBOX por padrão; `?includeInbox=1` para incluir; expõe `is_inbox`, `solo_app`, `origin_project_id` | — |
| `GET /api/projects` / `/api/specs` | Expõem `product_is_inbox` (e `product_solo_app`) | — |

`recomputeProductLifecycle` **isenta** o INBOX (homônimo NÃO é isento).

---

## 8. Superfície do Portal (`genesis-web`) — estado implantado

### 8.1 Ordem do menu (`components/AppLayout.tsx`, `navUser`)
**Dashboard → Enviar spec → Bancada → Meus produtos → Meus apps → Notificações.**

> **Supersessão:** o plano (A10 / "Decisão 6") havia definido *Meus apps → Meus produtos*. O Jean reverteu
> em 2026-08-26: **o Produto é o guarda-chuva do App, logo vem antes.** A ordem acima é a canônica/implantada.

Colisão do master: `navZentriz` relabela o `/projects` herdado como **"Apps do tenant"** e o global
`/zentriz/projects` como **"Apps (todos os tenants)"** — nunca dois rótulos idênticos.

### 8.2 Onde o INBOX aparece
- **Só na Bancada** (`/specs`): grupo "Rascunhos (inbox)", re-alocável, com Decompor habilitado.
- **NÃO** aparece em "Meus apps" (`/projects` filtra `PRE_FACTORY_STATUSES`, `archived` e `product_is_inbox`).
- **NÃO** aparece em "Meus produtos" (`/products` oculta `is_inbox`).

### 8.3 Layout unificado dos projetos por produto
`/products/<id>/projects` **redireciona** (server-side) para `/projects?product=<id>` — a mesma lista/cards de
"Meus apps", já filtrada, com o cabeçalho **`🧩 <produto> · N projeto(s)`**. Fonte única de layout: o antigo
drilldown próprio (rollup "Progresso do produto" + roadmap por ondas) foi retirado para não manter dois
layouts divergentes. **"Promover à fábrica"** segue disponível por card em `/products`.

### 8.4 Produtos homônimos (solo)
Aparecem em "Meus produtos" com badge **"App solo (auto-criado)"**; homônimos vazios (0 Apps) ficam ocultos.
Quando dois produtos compartilham `name` no tenant, o rótulo recebe sufixo curto client-side (`«Loja» ·a1b2c3d4`)
— sem alterar o `name` no banco.

---

## 9. Identidade Deadpool (produto solo)

`deriveSystemService` (`services/githubPush.ts`) recebe `soloProduct`: para App em produto `solo_app=true`,
`systemId = product.system_id` (slug desambiguado, único por tenant) e **`serviceId = null` explicitamente**.
As três SELECTs de origem (`githubPush.ts` + `routes/deadpool.ts` ×2) selecionam e repassam `solo_app`.
Apps cujo slug foi desambiguado por sufixo devem ter o `systemId` correspondente auditado/renomeado no
lado Deadpool (evitar serviço órfão bare-slug).

---

## 10. Deploy / Rollback (estado em prod)

- **Fluxo:** manual ECR→SSH (ver [`../../CLAUDE.md`](../../CLAUDE.md) e [DEPLOYMENT.md](DEPLOYMENT.md)). A API sobe
  **primeiro** (migração 064 aplica no boot); depois o `genesis-web`. GitHub **não** deploya prod.
- **Estado 2026-08-26:** `dev` e `main` em `18570bc`. Migração 064 aplicada e verificada em prod
  (`product_id` NOT NULL, 0 órfãos, 1 inbox por tenant, 0 apps de fábrica no inbox, homônimos solo criados).
- **Rollback da migração:** bloco de rollback manual no cabeçalho do `064_*.sql` +
  `DELETE FROM schema_migrations WHERE version='064_products_inbox_and_product_id_notnull'`.
- **Rollback de imagem:** tags `rollback-<svc>:pre-inbox` / `rollback-genesis-web:pre-list-redirect` em prod.

---

## 11. Referências

- Plano de implementação completo (42 gaps, migração, testes, riscos): [`plans/PLANO_PRODUCT_MANDATORY_INBOX_2026-08-26.md`](plans/PLANO_PRODUCT_MANDATORY_INBOX_2026-08-26.md)
- Bancada e Splitter vivo: [`rfc/RFC-0003-SPEC-BANCADA-E-SPLITTER-VIVO.md`](rfc/RFC-0003-SPEC-BANCADA-E-SPLITTER-VIVO.md)
- Arquitetura geral: [ARCHITECTURE.md](ARCHITECTURE.md) · Contrato de API: [API_CONTRACT.md](API_CONTRACT.md) · Deploy: [DEPLOYMENT.md](DEPLOYMENT.md)

---

*Documento criado em 2026-08-26 — Zentriz Genesis. Modelo canônico Produto · App · INBOX.*
