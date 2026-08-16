> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Credenciais Zentriz, gestão de tenants, seletor de tenant, signup e endurecimento RBAC

**Data:** 2026-08-16 · **Repo:** `zentriz-genesis` · **Branch:** `dev` (commit `5973b9e`) · **Status:** **DEPLOYADO EM PRODUÇÃO** 2026-08-16 (api `sha256:6eb66b5a…` / web `sha256:d513d268…`; migration 049 aplicada; rollback `pre-credentials-rbac`).

Documento de referência de **todas as modificações** feitas nesta frente. Segue os padrões do
ecossistema (Database-per-Product, RBAC por papel, PT-BR na prosa / inglês no código) e a
disciplina FIX-FIRST (revisão adversarial antes de fechar).

---

## 1. Objetivo (pedido do Jean)

1. **Credenciais internas** — `admin@zentriz.com` → **`jean@zentriz.com.br`** (master `zentriz_admin`,
   controla tudo e gerencia tenants). `admin@tenant.com` e `user@tenant.com` também → `jean@zentriz.com.br`.
   Tenant modelo `Tenant Demo` → **`ZFactory`**. **Todas as senhas = `#Jean@2026!`** (fixo).
2. **Gestão de tenants** — tela `/zentriz/tenants` profissional (CRUD + status).
3. **Seletor de tenant** — `SELECT` no cabeçalho das telas que exibem dados de tenant
   (specs, projetos, usuários), que **lembra** o último tenant escolhido entre telas.
4. **Signup** — `/tenant/signup` profissional e responsivo; tenant nasce **DESATIVADO** e só
   é liberado após ativação pela Zentriz; usuário de tenant inativo **não** consegue logar.
5. **RBAC** — Zentriz domina tudo; tenant domina seus dados/usuários; usuário comum gerencia
   tudo **exceto** criar outros usuários e configs.

---

## 2. Modelo de identidade e RBAC

| Papel | E-mail | Tenant | Poderes |
|-------|--------|--------|---------|
| `zentriz_admin` (master) | `jean@zentriz.com.br` | — (NULL) | Tudo. Cria/gerencia tenants, vê e escopa dados de qualquer tenant, gerencia status. |
| `tenant_admin` | `jean@zentriz.com.br` | ZFactory | Domina os dados e usuários **do próprio tenant**. Não cria `zentriz_admin`. |
| `user` | `jean@zentriz.com.br` | ZFactory | Opera specs/projetos do próprio tenant; **não** cria usuários nem mexe em configs. |

- **Senha compartilhada:** `#Jean@2026!` para os três (uso interno da Zentriz — Jean).
- **Unicidade `(email, role)`** (migration 049): o mesmo e-mail existe nos três papeis; a tela de
  login envia o `role` para desambiguar. Sem `role`, o backend escolhe o papel de maior privilégio.

> ⚠️ **Caveat de produção (endurecimento):** e-mail e senha compartilhados entre papeis são uma
> conveniência **interna** e deliberada. Em qualquer implantação de cliente, trocar as senhas
> (`ZENTRIZ_DEFAULT_PASSWORD`) e usar e-mails/contas distintas. Documentado em `SECRETS_AND_ENV.md`.

---

## 3. Backend (`applications/services/api-node`)

### 3.1 Migration `049_zfactory_and_email_per_role.sql` (nova)
- Remove a unicidade **global** de e-mail (`users_email_key`).
- Renomeia as contas Zentriz para `jean@zentriz.com.br` (por papel) e o tenant `Tenant Demo` → `ZFactory`.
- Cria a unicidade composta **`UNIQUE (email, role)`**.
- Statements idempotentes; **nenhum literal contém `;`** (o runner faz split ingênuo por `;` — ver gotcha do runner de migrations).

### 3.2 `db/seed.ts`
- `ZENTRIZ_EMAIL = jean@zentriz.com.br`, `ZENTRIZ_DEFAULT_PASSWORD = #Jean@2026!`, `MODEL_TENANT_NAME = ZFactory`.
- Semeia os três papeis com o mesmo e-mail/senha (ZFactory ativo). **Reconciliação** em DB não-vazio
  (`ensureZentrizAdmin` + `ensureModelTenantUsers`) por `ON CONFLICT (email, role)` / UPDATE por papel.
- Aliases retrocompatíveis mantêm imports antigos válidos.

### 3.3 `routes/auth.ts` — login (endurecimento anti-enumeração)
- Login aceita `role` opcional; sem `role`, escolhe o papel de maior privilégio.
- **Timing/enumeração:** quando o e-mail não existe, roda `comparePassword` contra um **dummy hash**
  em cache (mesmo custo de tempo do caminho válido) e responde 401 genérico.
- **Ordem:** a checagem de senha ocorre **antes** do 403 de status, para não vazar existência/estado.
- **Tenant inativo:** usuário de tenant com `status != 'active'` recebe **403 `TENANT_INACTIVE`**; o master (sem tenant) sempre loga.

### 3.4 `routes/users.ts` — CRUD + RBAC + integridade
- **Criação:** unicidade verificada por `(email, role)`; colisão → **409** (não 500). `tenant_admin`
  só cria no próprio tenant e nunca `zentriz_admin`.
- **PATCH:** `UPDATE` em try/catch; `23505` → **409**.
- **DELETE:** bloqueia se o usuário **possui qualquer projeto** (`created_by`) → **409** explícito
  (evita 500 por violação de FK); rede de segurança para `23503`. Não permite auto-remoção.
- **GET (lista) — escopo:** só o `zentriz_admin` escopa por `?tenantId=` (validado por `UUID_RE`,
  ignorado se inválido → sem erro de cast `uuid`). **Não-master nunca alarga escopo** — sempre
  restrito ao próprio tenant.

### 3.5 `routes/projects.ts` e `routes/specs.ts`
- Mesmo padrão de escopo do master via `?tenantId=` validado por `UUID_RE`; não-master sempre no próprio tenant.

### 3.6 `routes/tenants.ts` — governança (só master)
- `GET /api/tenants` com plano + contadores (`usersCount`, `projectsCount`).
- `POST` cria tenant; **status inválido → 400** (consistente com o PATCH), default `active` no
  provisionamento interno.
- `PATCH` altera nome/plano/**status**; valida status (`active|suspended|inactive`). Base do
  bloqueio de login por tenant inativo.

---

## 4. Frontend (`applications/apps/genesis-web`)

### 4.1 Seletor de tenant (persistente entre telas)
- **`stores/tenantScopeStore.ts` (novo):** observável MobX com `selectedTenantId` persistido em
  `localStorage` (`genesis_selected_tenant`), `hydrate()`, `setSelected()`, `effectiveTenantId`, `clear()`.
- **`components/TenantSelector.tsx` (novo):** `Select` no cabeçalho; visível só para o master.
- **`AppLayout.tsx` / `(dashboard)/layout.tsx`:** monta o seletor no topo das telas de dados.
- **`authStore.logout()`** chama `tenantScopeStore.clear()` — zera memória + `localStorage` + `hydrated`
  (SPA não recarrega no logout; sem isso a próxima sessão herdaria o filtro errado).

### 4.2 Stores com *latest-wins* (troca rápida de escopo)
- `projectsStore` e `usersStore`: token `reqSeq` por chamada — só a resposta do **token mais recente**
  aplica; removida a guarda por `loading` (que engoliria a recarga disparada pela troca de escopo).
- `tenantsStore.ts` (novo): `load/getById/create/update/setStatus`. O `update()` recarrega quando o
  **plano** muda (o PATCH não devolve o objeto `plan` aninhado nem os contadores).

### 4.3 Telas
- **`zentriz/tenants/page.tsx`:** gestão profissional — tabela com plano/uso, `Chip` + `Select` de
  status (via `setStatus`), diálogo de criação/edição, `Alert` explicando que desativar bloqueia o login.
- **`zentriz/users/page.tsx`:** dados reais (`usersStore`/`tenantsStore`/`tenantScopeStore`), recarrega
  ao trocar de escopo, CRUD com diálogos, `Snackbar` para 409.
- **`specs/page.tsx`:** `MySpecs` agora é `observer` — recarrega ao trocar o tenant no seletor
  *(correção H2 da revisão)*.
- **`zentriz/projects/page.tsx`:** lista escopada pelo seletor.
- **`tenant/signup/page.tsx`:** tema indigo escuro, cards de plano clicáveis, "Confirmar senha",
  validação client-side, sucesso "aguardando ativação" (Alert info + Stepper 3 passos). Preserva o
  contrato `POST /api/tenant/signup`. Os dois títulos **sobre o gradiente escuro** usam cores fixas
  claras (`#F8FAFC` / `rgba(248,250,252,0.72)`) — nunca tokens de tema — para não sumirem no tema
  claro *(correção M2, regra de ouro de contraste)*.

---

## 5. Verificação

### 5.1 Gates
- **genesis-web:** `npx tsc --noEmit` → **0**; `npm run build` → **0** (31 rotas compiladas).
- **api-node:** `npx tsc --noEmit` → **0**; `npm test` (vitest) → **433 passed | 1 skipped** (46 arquivos).

### 5.2 Revisão adversarial (FIX-FIRST) — corrigido antes de fechar
**Backend (7):** #4 login enum/timing → dummy-hash + reordenação; #2/#3 unicidade `(email,role)` →
409; #5 escopo `?tenantId=` validado por `UUID_RE` em users/projects/specs; #6 DELETE com projeto → 409;
#7 `POST /tenants` status inválido → 400.
**Frontend (6):** H1 `logout` limpa escopo; H2 `MySpecs` observer; M1 latest-wins em projects/users;
M2 títulos on-gradient com cor fixa; L1 `tenantsStore.update` recarrega ao mudar plano.
*(Senha compartilhada NÃO foi "corrigida" — é instrução explícita; tratada como caveat de produção.)*

### 5.3 Testes de regressão adicionados (`integration.test.ts`, +4)
Bloco **"RBAC + integridade (regressões da revisão adversarial)"**:
1. `tenant_admin` **não** alarga escopo com `?tenantId=` de outro tenant (só vê o próprio).
2. Mesmo e-mail em papeis distintos → **201 + 201**; mesmo `(email, role)` repetido → **409**.
3. Deletar usuário que **possui projeto** → **409** (FK protegida, não 500).

---

## 6. Arquivos tocados

**Novos:** `stores/tenantScopeStore.ts`, `stores/tenantsStore.ts`, `components/TenantSelector.tsx`,
`db/migrations/049_zfactory_and_email_per_role.sql`.
**Modificados (backend):** `db/seed.ts`, `db/schema.sql`, `routes/auth.ts`, `routes/users.ts`,
`routes/projects.ts`, `routes/specs.ts`, `routes/tenants.ts`, `routes/plans.ts`, `integration.test.ts`.
**Modificados (frontend):** `app/(dashboard)/layout.tsx`, `.../projects/page.tsx`, `.../specs/page.tsx`,
`.../zentriz/projects/page.tsx`, `.../zentriz/tenants/page.tsx`, `.../zentriz/users/page.tsx`,
`app/tenant/signup/page.tsx`, `components/AppLayout.tsx`, `lib/api.ts`, `stores/authStore.ts`,
`stores/projectsStore.ts`, `stores/usersStore.ts`, `types/index.ts`.

Total: **22 arquivos modificados + 4 novos** (~1824 inserções / 221 remoções).

---

## 7. Promoção para produção (2026-08-16 — EXECUTADA)

Autorizada por Jean ("promover para prod"). Fluxo build-based (ver runbook e gotcha de deploy):
1. Commit `dev` **5973b9e** (pushado `c77b011..5973b9e`).
2. `docker compose build api genesis-web` → `ecr-push.sh 820198199720 us-east-1 api genesis-web`
   (`--profile zentriz`; guard anti-localhost do genesis-web aprovado).
3. **Rollback tags** `pre-credentials-rbac` gravadas no ECR **antes** de sobrescrever `latest`
   (api `sha256:9942170c…` / web `sha256:621bd197…`).
4. **Backup do DB** antes do deploy: `/opt/zentriz-genesis/backups/pre-credentials-rbac-20260816-213250.sql` (1.9 MB).
5. EC2 `3.220.66.113` (`/opt/zentriz-genesis`, instance role): `pull` do ECR + **retag** para
   `zentriz-genesis-<svc>:latest` + `docker compose up -d --force-recreate api genesis-web`.
6. **Migration 049 auto-aplicada no boot** do `api` (`initDb` roda migrations pendentes: 048 → 049).
   O Postgres de prod é **container** do compose (não RDS).

**Verificação (tudo verde):** `container.Image` == digests pushados (api `6eb66b5a`, web `d513d268`);
`schema_migrations` max = `049`; `/api/health` = `{status:ok, version:1.3.0-beta}`; login
`jean@zentriz.com.br` / `#Jean@2026!` nos 3 papéis → **200**; senha errada → **401**; contas dos
tenants reais (`admin@saliforg.com`, `admin@cabralorg.com`) **intactas**; `Tenant Demo` → `ZFactory`.

**Rollback (se necessário):** retag `latest` de volta para o manifesto `pre-credentials-rbac` (api/web),
repetir pull+retag+recreate; restaurar o dump acima se preciso reverter a migration 049.

### Endurecimento de produção (pendente, quando for implantação de cliente)
- Trocar `ZENTRIZ_DEFAULT_PASSWORD` e usar contas/e-mails distintos por papel (o compartilhamento é conveniência interna).
