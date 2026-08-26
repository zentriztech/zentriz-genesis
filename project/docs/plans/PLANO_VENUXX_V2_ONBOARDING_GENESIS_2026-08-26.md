> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano (REV. 2) — Plugar o Venuxx V2 no Zentriz Genesis + Auto Care (Deadpool)

> **Objetivo operacional:** trazer os **28 apps do Venuxx V2** para dentro do Genesis **como se tivessem nascido lá** — com Produto, Apps tipados e diálogos/logs autênticos em `project_dialogue` — respeitando o modelo canônico Produto · App · INBOX (migração 064), e, para os apps com serviço vivo, habilitando monitoramento no Auto Care (Deadpool) **pelo caminho que a topologia brownfield permite**, sem tocar produção às cegas.
> **Documento de referência inviolável:** `project/docs/PRODUCT_APP_INBOX_MODEL.md` (vence qualquer divergência de organização Produto/App/Spec/INBOX).
> **Data:** 2026-08-26 (REV. 2) · **Ambiente:** `genesis.zentriz.com.br` (EC2 `3.220.66.113`). A Fase 1 (tenant) **já foi feita em PROD**; para o seed dos 28 apps (Fase 2–3) vale `--dry-run` antes do `--commit` + `pg_dump` de rollback (o tenant só existe em PROD — ver §8.1).
> **Nota da versão final:** este plano foi submetido a uma banca adversarial (1 blocker, 11 majors, minors). Todas as correções estão incorporadas no corpo; a seção 12 mapeia cada achado. **Duas mudanças estruturais** em relação ao rascunho: (1) o `max_projects` do plano é **display-only** — não há enforcement, logo a escolha de plano é decisão comercial, não bloqueio técnico; (2) o Auto Care via `activate` (caminho A) é **inviável para apps semeados** (exige GitHub App + repos + deployments reais) — adotamos formalmente o **caminho B (Connect/`/diagnose`, ADR-015)** como rota de monitoramento, com o caminho A registrado como esforço de provisionamento separado.

> ### 🟢 REV. 2 (2026-08-26) — Fase 1 JÁ EXECUTADA em PRODUÇÃO
> O tenant **já foi criado pelo Jean no portal de PROD** e **ativado** (não em dev). Isto **resolve as decisões A1 e A2** e muda três coisas no plano abaixo:
> 1. **Plano escolhido = Diamante (definido, não mais "a decidir").** `tenant_id=0931c5dc-46eb-474a-a54a-dad12733b4b2` · **VENUXX TECHNOLOGIES LTDA** · `plan_diamante` · admin `jeanolbar@venuxx.com` (tenant_admin, active) · INBOX "Rascunhos" (`016cad3b-…`) criado. A barra de uso lerá `28/50` (cosmético; `max_projects` não tem enforcement).
> 2. **Carência aplicada.** `status='active'` + `billing_exempt=true`; a cobrança inicial (`Assinatura inicial`) foi **cancelada**. **Flip D+180 = 2027-02-26** (`billing_exempt=false` + `generate-month`) — não expira sozinho.
> 3. **O tenant só existe em PROD** → o **seed dos 28 apps (Fases 2–3) roda contra o Postgres de PROD** (o dev não tem esse tenant). O ensaio em dev, se desejado, exige recriar o tenant em dev antes; caso contrário, roda-se direto em prod com `--dry-run` obrigatório antes do `--commit`. Ver §8/§9 (chave de idempotência do tenant **corrigida**: buscar por `id`/`email`, não por `lower(name)='venuxx'` — o nome real é `VENUXX TECHNOLOGIES LTDA`).
>
> **Pendências herdadas da criação (não bloqueiam o seed, confirmar com o Jean):** `tenants.responsible_name` está como **"Diogo Della Gomes"** e `responsible_email` **vazio** (o pedido inicial dizia responsável = Jean; o *usuário admin* está correto como Jean). A cobrança cancelada era de **R$ 77.000,00** — anômala para Diamante (R$ 999/mês). Ver §11 (A1/A2 atualizadas) e §13.

---

## 1. Objetivo e princípio

O Venuxx V2 é uma plataforma real, madura, **brownfield**: os 28 apps já existem em repositórios próprios e **não foram gerados pela fábrica do Genesis**. Este plano **materializa o estado final** ("accepted"/"completed") desses apps dentro do modelo de domínio do Genesis, reproduzindo fielmente o arco de diálogos que a fábrica real teria emitido — usando o vocabulário canônico de `applications/orchestrator/dialogue.py` e os pares `from_agent`/`to_agent` que o runner realmente grava.

Princípios respeitados sem exceção:

1. **Todo App pertence a um Produto.** `projects.product_id` é **NOT NULL** (migração 064). Não existe App avulso.
2. **App terminal NUNCA vive no INBOX "Rascunhos".** O INBOX (`is_inbox=true`, 1 por tenant) só hospeda specs em `PRE_FACTORY_STATUSES`. Como os apps Venuxx nascem já `accepted`/`completed`, vão para um **Produto de entrega** (`is_inbox=false, solo_app=false`).
3. **Fidelidade à fábrica.** Diálogos seguem a sequência real do runner; os pares `from_agent`/`to_agent` derivam dos **dois primeiros argumentos de `_post_dialogue`** no runner (não dos argumentos de `_get_summary_human`). Ver §5.
4. **Best-effort no Deadpool, nunca fatal.** Nenhum passo de Auto Care derruba o seed; o seed (Fases 1–3) é independente do Deadpool.
5. **Semear é idempotente por chave estável e transacional.** Reruns não duplicam — via `SELECT`-first find-or-create (não `ON CONFLICT` sobre coluna sem unique). Ver §8/§9.

### Dois caminhos de "plug" no Auto Care — e qual é viável para brownfield semeado

- **(A) App nascido no Genesis** → registro no accept (`pushProjectToGitHub` → `registerProjectWithDeadpool`) + `POST /api/deadpool/projects/:id/activate`. **Este caminho é inviável para apps semeados** (ver §6): `activate` exige, por query, linha em `project_github_repos` (senão `409 NO_REPOSITORY`), linha em `tenant_github_installations` (senão `409 NO_GITHUB_INSTALLATION`) e `backend_deployments` com status `running` para obter `app_url`/`health_url`/`log_group`. Um seed por `INSERT` não cria nenhuma dessas linhas, e o tenant Venuxx não tem GitHub App instalado nos repos reais.
- **(B) Alvo externo brownfield** → `POST /diagnose` com contratos Connect Tier 1/2 (ADR-015). **Não depende** de repo Genesis, installation ou `backend_deployments`. **É o caminho adotado** para monitorar os apps Venuxx com serviço vivo.

O seed (Fases 1–3) entrega a **topologia nativa** ("como se tivesse nascido no Genesis"): Produto, Apps tipados, `project_tasks`, `project_dialogue` fiéis. O Auto Care é tratado à parte na Fase 4, pela realidade da infra brownfield.

---

## 2. Fase 0 — Pré-requisitos e diagnóstico

> **Dev primeiro, prod nunca direto.** Todo seed/verificação roda no workstation dev (`zentriz-genesis` branch `dev`, api `:3456`, portal `:3010`) antes de `3.220.66.113`.

**0.1 — Confirmar branch e stack local.**
```bash
git -C ~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis branch --show-current   # dev
docker compose -f docker-compose.yml -f docker-compose.override.linux.yml -f docker-compose.override.foundry.yml ps
```

**0.2 — Confirmar migração 064 aplicada.**
```sql
SELECT version FROM schema_migrations WHERE version='064_products_inbox_and_product_id_notnull';
SELECT count(*) FROM projects WHERE product_id IS NULL;                    -- deve ser 0
SELECT tenant_id, count(*) FROM products WHERE is_inbox GROUP BY 1;        -- <=1 por tenant
```

**0.3 — Auditar o schema real ANTES de escrever qualquer INSERT.** A banca encontrou colunas inexistentes no rascunho (`tenants.responsible`) e afirmações incorretas sobre constraints. Regra: `Read` do DDL de cada tabela tocada antes de codar.
```bash
# confirmar colunas reais de tenants (responsible_name/_email, NÃO 'responsible'):
grep -RniE "responsible|CREATE TABLE tenants|ALTER TABLE tenants" \
  applications/services/api-node/src/db/migrations/ | sort
# confirmar ausência de unique em projects(tenant_id,product_id,title) e em tenants(name/email):
grep -RniE "UNIQUE|unique index|uq_" applications/services/api-node/src/db/migrations/ | grep -iE "projects|tenants|products"
```
Achados já conhecidos a respeitar:
- `tenants`: **não** tem coluna `responsible`; usar `responsible_name`/`responsible_email`. **Não** tem unique em `name` nem `email` (só PK `id`).
- `projects`: **não** tem unique em `(tenant_id, product_id, title)` — `ON CONFLICT` sobre essa tripla falha em runtime. Find-or-create por `SELECT`.
- `products`: unique **por-tenant** `uq_products_system_id_per_tenant` em `(tenant_id, lower(system_id))` (064). É a única chave de conflito válida para produto.
- `plans`: PK `id` (conflito válido para `plan_*`).

**0.4 — Verificar env do Deadpool no container api de PROD.** Determina se o caminho B (Fase 4) é viável hoje.
```bash
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 \
  'sudo docker inspect zentriz-genesis-api-1 --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -Ei "DEADPOOL_BASE_URL|DEADPOOL_API_TOKEN"'
```
- **Vazio/ausente** → Fase 4 fica pendente até setar as envs. **Fases 1–3 não dependem disso.**

**0.5 — Idempotência (contrato do script).** Reexecutável sem duplicar: **tenant JÁ existe** (`id=0931c5dc-…b4b2`) → o seed **não cria tenant**; reusa esse `id` (parâmetro fixo `--tenant-id=0931c5dc-…b4b2` ou `SELECT id FROM tenants WHERE lower(email)='jeanolbar@venuxx.com'` — **não** por `lower(name)='venuxx'`, pois o nome real é `VENUXX TECHNOLOGIES LTDA`); produto por `uq_products_system_id_per_tenant`; app por `SELECT (tenant_id, product_id, title)`; diálogos por `DELETE FROM project_dialogue WHERE project_id=$1` antes de reinserir. **Nunca** gerar `id` aleatório de tenant em rerun. Ver §9.

**0.6 — Snapshot de rollback (dev).** `pg_dump` do schema `public` antes do seed.

---

## 3. Fase 1 — Criar o Tenant Venuxx — ✅ CONCLUÍDA (PROD, 2026-08-26)

> **Esta fase já foi executada.** O Jean criou o tenant pelo portal de PROD e a ativação/carência foi aplicada. O que segue passa a ser **registro do estado real** (não mais um passo a fazer). O restante do plano (Fases 2–6) parte deste estado.

**Estado final verificado em PROD (`3.220.66.113`):**

| Campo | Valor |
|-------|-------|
| `tenant_id` | `0931c5dc-46eb-474a-a54a-dad12733b4b2` |
| `name` | **VENUXX TECHNOLOGIES LTDA** |
| `plan_id` | **`plan_diamante`** (50 proj / 100 users / R$ 999) |
| `status` | **`active`** |
| `billing_exempt` | **`true`** (carência — ver §3.2) |
| Admin | `jeanolbar@venuxx.com` · role `tenant_admin` · `status='active'` · nome "Jean Ol'Bar" (user `15eb29fd-…`) |
| INBOX | produto **"Rascunhos"** `016cad3b-…` (`is_inbox=true`) |
| Cobrança inicial | **cancelada** (`Assinatura inicial`, era `open`/vencida) |
| Projetos/apps | **0** (o seed dos 28 apps é a Fase 2–3, ainda não executada) |

**Responsável / admin:** Jean Ol'Bar · **jeanolbar@venuxx.com** · role `tenant_admin` (confirmado no user).
**Senha:** definida na criação pelo Jean; passada por `hashPassword` (bcrypt `SALT_ROUNDS=10`, `auth.ts:123`). Nunca em claro no doc/commit.

> **⚠️ Divergências herdadas da criação (confirmar com o Jean — §13):** `tenants.responsible_name` = **"Diogo Della Gomes"** e `responsible_email` **vazio** (o pedido inicial dizia responsável = Jean; o usuário admin, porém, está correto como Jean). A cobrança cancelada era **R$ 77.000,00** — anômala para Diamante.

### 3.1 — Escolha do plano: RESOLVIDA → Diamante · `max_projects` é DISPLAY-ONLY

**Decidido:** o tenant foi criado em **`plan_diamante`** (50 proj / 100 users / R$ 999) — SKU existente, sem poluir o catálogo público. A barra de uso do portal lerá **`28/50`** ao fim do seed.

A banca verificou que **não existe enforcement de `max_projects` em lugar nenhum** — nem em `projectCreation.ts`, nem em rotas, nem em trigger/constraint de migração, nem no orchestrator. O valor só é **lido e desenhado** como barra de uso no portal (`{activeCount} / {n}` em `tenant/plan/page.tsx`). Consequências (confirmam que Diamante foi a escolha certa e sem risco técnico):

- Os 28 apps **não são bloqueados** por quota alguma, nem no seed nem no portal — o teto de 50 do Diamante é confortável e cosmético.
- A escolha foi **comercial/de estética da barra de uso** — não um gate técnico.

#### 3.1.1 — Por que NÃO foi criado `plan_venuxx` (achado major da banca — mantido como registro)

`GET /api/plans` é **público, sem auth** (`plans.ts:53`) e alimenta a tela pública `/tenant/signup`, que lista todos os planos com preço; o signup aceita **qualquer** `planId` existente (`signup.ts:184`). Não há flag `is_public`/`active` em `plans`. Criar `plan_venuxx` (R$99 / 30 projetos) o tornaria **publicamente selecionável** no cadastro — subcotando Ouro (R$299/10) e Diamante (R$999/50) e abrindo vetor de auto-registro abusivo. Por isso optou-se por **Diamante existente**. Se no futuro o Jean quiser um SKU de preço-Prata com teto alto, isso vira **pré-requisito de schema/rota** (coluna `is_public`/`active` em `plans` + filtro no `GET /api/plans` público + allowlist de `planId` no `signup`) — fora do escopo deste onboarding.

### 3.2 — "6 meses grátis (carência)" — ✅ APLICADA

**Não existe trial nativo** (`schema.sql:25`: status só `active|suspended|inactive`; sem `trial_ends_at`). A carência nativa (`FINANCE_SUSPEND_GRACE_DAYS=3`) é em **dias**. Modelagem adotada (padrão do tenant interno ZFactory, `migration 061`) — **já executada em PROD**:

1. ✅ `status='active'` (com `pg_notify('tenant_status_bust', tid)` invalidando o cache em todas as réplicas).
2. ✅ `billing_exempt=true` → `generate-month` não gera assinatura (`finance.ts:573`); o worker **não** suspende por inadimplência (`financeBillingWorker.ts:45-46`).
3. ✅ Cobrança inicial em aberto/vencida **cancelada** (`UPDATE charges SET status='canceled'`) — sem ela, o worker marcaria `open→overdue` e, se o tenant não fosse isento, re-suspenderia (vencida há >3 dias). Com `billing_exempt=true` a suspensão já não ocorreria, mas a fatura fantasma foi removida por coerência com "grátis".
4. ⏳ **D+180 = 2027-02-26 (manual/job externo):** flipar `billing_exempt=false` e rodar `generate-month`. **Não há expiração automática** — lembrete operacional obrigatório (Riscos/Assunções §11-A2).

> **Nota:** por ter sido criado pela rota do portal (não pelo script de seed), a 1ª cobrança foi gerada e **depois** cancelada — daí o passo 3. Um seed futuro que crie tenant do zero já nasce isento (sem cobrança). O passo 3 é específico deste caso real.

> **Carência = 6 meses de créditos de cortesia (decisão do Jean, 2026-08-26).** A Venuxx recebe **créditos suficientes para cobrir 6 faturas do plano Diamante** (6 × R$ 999,00 = R$ 5.994,00). Enquanto durar o crédito, a fatura mensal é abatida integralmente (R$ 0,00 a pagar). Hoje isso é **modelado** via `billing_exempt=true` (não há saldo/ledger de crédito nativo). **Pendência futura (fora deste onboarding):** construir um **sistema de créditos "extremamente seguro"** (ledger auditável, débito por ciclo, saldo consultável, idempotência de lançamento) para refletir a realidade — hoje o abatimento é apenas a isenção de billing, sem saldo decrescente. Ver §13.

---

## 4. Fase 2 — Criar o Produto `Venuxx V2` e enumerar os 28 apps

**Produto de entrega** (`is_inbox=false`, `solo_app=false`), criado por **`INSERT` direto em `products`** — **não** "equivalente a `POST /api/products`": a rota (`products.ts:240`) só insere `(tenant_id, created_by, name, description)` e **não grava `system_id`**. Como o Deadpool e a verificação 7.1 dependem de `system_id`, o seed o seta explicitamente na linha: `system_id='venuxx-v2'`, respeitando `uq_products_system_id_per_tenant` (064). Nome `Venuxx V2`, `status='active'` ("Rascunhos" é reservado ao INBOX — `409 RESERVED_PRODUCT_NAME` —, sem conflito aqui).

> **Escopo da unicidade:** `uq_products_system_id_per_tenant` garante `system_id` único **por tenant**, não globalmente. O prefixo `venuxx-v2` é **convenção** para evitar colisão cross-tenant no registry do Deadpool (§6) — a verificação 7.1 reforça a convenção, não a impõe no schema.

> **Por que entrega e não homônimo-solo:** o Venuxx V2 é um **grafo de apps relacionados** (`PRODUCT_APP_INBOX_MODEL.md:33,45`). Cada app vira `serviceId=slug(título)` sob `systemId=product.system_id` — topologia limpa. (Homônimo-solo daria `serviceId=null`, só para app que roda sozinho.)

Cada app nasce **já `accepted`** (serviço vivo) ou **`completed`** (libs/CLI/infra/e2e sem runtime), com `product_id`=Venuxx V2 e `extra.project_type` **canônico** (`project_types.yaml`; tipos fora da taxonomia viram `_default`). Como semeamos direto no banco (sem passar por `/accept`, que exige status ∈ {running,completed,stopped,pending_cyborg} — `projects.ts:609`), gravamos o terminal final coerente.

### 4.1 — Mapa de tipos: inventário → taxonomia canônica (`project_types.yaml` v0.5.0)

| Rótulo inventário | `project_type` canônico | Nota |
|---|---|---|
| `backend_api` | `backend_api` | Node/Fastify/Drizzle |
| `backend_worker` | `backend_worker` | consumidores/publishers |
| `backend_api_python` | `backend_api_python` | FastAPI |
| `frontend_dashboard` | `frontend_dashboard` | portal Next |
| `lib_ts` | `lib_ts` | pacotes internos |
| `lib_cli` | `lib_cli` | CLI |
| `bot_chat` | `bot_chat` | Maya |
| `infra_cicd` | `infra_cicd` | terraform/infra |
| `other` (e2e) | `other` | suíte de testes |

### 4.2 — Os 28 apps (nome · project_type · stack · descrição · status terminal)

| # | Nome (App) | `project_type` | Stack | Descrição | status |
|---|---|---|---|---|---|
| 1 | logistics-ingest | `backend_api` | Node 20 · TS · Lambda | `POST /orders/ingest` → grava pedidos RAW no DynamoDB (idempotente). | accepted |
| 2 | logistics-admin-api | `backend_api` | Node 20 · TS · Lambda | API `/auth/*`, `/mgmt/*`, `/public/tracking/*` (Portal + Maya). | accepted |
| 3 | logistics-webhook | `backend_api` | Node 20 · TS · Lambda · RabbitMQ | Webhooks Tookan + workers de bipagem. | accepted |
| 4 | logistics-dlq-admin | `backend_api` | Node 20 · TS · Lambda | API administrativa da DLQ. | accepted |
| 5 | logistics-test-webhook-sink | `backend_api` | Node 20 · TS · Lambda | `GET/POST /logistics/sink` — sink de testes de webhook. | accepted |
| 6 | logistics-normalizer | `backend_worker` | Node 20 · TS · Lambda | Normaliza RAW → MySQL + outbox. | accepted |
| 7 | logistics-dlq-consumer | `backend_worker` | Node 20 · TS · Lambda | Consome mensagens da DLQ. | accepted |
| 8 | logistics-outbox-publisher | `backend_worker` | Node 20 · TS · Lambda | Publica `outbox_events` → RabbitMQ. | accepted |
| 9 | logistics-outbound-dispatcher | `backend_worker` | Node 20 · TS · Lambda · RabbitMQ | RabbitMQ → despacha para webhooks/destinos. | accepted |
| 10 | logistics-dsl-ai-service | `backend_worker` | Node 20 · TS · Lambda · SQS · Bedrock | Gera DSL de normalização via IA (jobs/SQS). | accepted |
| 11 | logistics-infra | `infra_cicd` | Node 20 · TS | Placeholder/noop de infra do pipeline serverless. | completed |
| 12 | core | `lib_ts` | TS | HTTP helpers, logger, respostas Lambda. | completed |
| 13 | database-drizzle | `lib_ts` | TS · Drizzle · MySQL | Cliente Drizzle + pool MySQL. | completed |
| 14 | database-logistics | `lib_ts` | TS | Schema e repositórios de domínio. | completed |
| 15 | dynamodb | `lib_ts` | TS · DynamoDB | Acesso RAW / templates no DynamoDB. | completed |
| 16 | logistics-raw | `lib_ts` | TS | Modelo e operações do RAW. | completed |
| 17 | template-engine | `lib_ts` | TS · JSONPath | DSL de normalização por template. | completed |
| 18 | rabbitmq | `lib_ts` | TS · amqplib | Publicação/consumo AMQP. | completed |
| 19 | infrastructure | `lib_ts` | TS | Utilitários de infra compartilhados. | completed |
| 20 | logistics-seed | `lib_ts` | TS | Scripts de seed MySQL/Dynamo. | completed |
| 21 | portal | `frontend_dashboard` | Next.js 15 · React 18 | Painel de operação (pedidos, tenants, CRMs, DLQ, rastreio público). | accepted |
| 22 | autonomy-cli | `lib_cli` | Node · pnpm | CLI de ciclos de autonomia (analyze/evolve/loop). | completed |
| 23 | identity | `backend_api_python` | Python 3.12 · FastAPI · Postgres · Celery | IdP OIDC próprio do ecossistema Venuxx. | accepted |
| 24 | tax | `backend_api_python` | Python 3.12 · FastAPI · Postgres · Celery · Redis | Documentos fiscais de transporte (CT-e/CT-e OS/MDF-e). | accepted |
| 25 | tms | `backend_api_python` | Python 3.12 · FastAPI · Postgres · Celery · Redis | Gestão de transporte: cotação, seleção, despacho, tracking. | accepted |
| 26 | maya (mayacore) | `bot_chat` | Python 3.12 · FastAPI/Mangum · Lambda · Bedrock | Assistente de IA que cadastra tenants/CRMs e gera DSL por chat. | accepted |
| 27 | infra-terraform | `infra_cicd` | Terraform · AWS ECS/ALB/RDS/Redis | IaC dev/staging/prod. | completed |
| 28 | connect-e2e | `other` | Playwright · TS | Suíte E2E da plataforma Connect. | completed |

> **Critério de status:** deploy/runtime próprio → `accepted` (16 apps: 1–10, 21, 23, 24, 25, 26, e o webhook); libs/CLI/infra/e2e → `completed` (12 apps). Ambos terminais e válidos fora do inbox.

**Colisão de slug:** títulos com prefixo `logistics-` são distintos → `serviceId=slug(título)` único dentro do produto. Sem desambiguação por sufixo de `system_id` (isso só ocorre em homônimos-solo). Fase 4 audita o `systemId` no lado Deadpool.

---

## 5. Fase 3 — "Nascer no Genesis": diálogos, tarefas e spec por app

Para cada app, o seed insere, **numa transação**, o arco que a fábrica teria produzido. Ordem canônica (fonte `runner.py` replay `4387..5201` + `dialogue.py:53-90`):

```
cto.engineer.request → engineer.cto.response → project.created → module.planned
→ task.assigned → task.completed → qa.review → monitor.health → devops.deploy → (step final)
```

### 5.0 — Regra de ouro dos pares `from_agent`/`to_agent` (correção major da banca)

O runner chama `_post_dialogue(from, to, event, summary, req)` — as colunas `from_agent`/`to_agent` recebem os **dois primeiros argumentos**. Os args passados a `_get_summary_human(...)` servem só para montar o **texto** e **não** são o que vai para as colunas. Um diff das colunas contra um projeto Genesis real deve bater. Pares corretos verificados:

| event_type | from_agent | to_agent | fonte |
|---|---|---|---|
| cto.engineer.request | cto | engineer | runner replay |
| engineer.cto.response | engineer | cto | runner replay |
| project.created | cto | pm | runner replay |
| module.planned | pm | cto | runner replay |
| task.assigned | pm | dev | runner replay |
| task.completed | dev | qa | runner replay |
| **qa.review** | **dev** | **qa** | `runner.py:2858, 5121` (corrigido) |
| monitor.health | monitor | pm | runner replay |
| **devops.deploy** | **monitor** | **devops** | `runner.py:3273, 5200` (corrigido) |

> **Implementação:** o gerador `dialogueArc()` deriva `from`/`to` desta tabela (espelho dos dois primeiros args de `_post_dialogue`), **nunca** dos argumentos de `_get_summary_human`. Verificar contra `runner.py` antes de inserir (gap: só qa.review e devops.deploy foram confirmados discrepantes; os demais devem ser conferidos no mesmo `Read`).

### 5.1 — Postura sobre o texto (`summary_human`) — declaração sem contradição

Offline (sem `SUMMARY_LLM_URL`), `build_summary_human()` produz textos **genéricos** ("PM atribuiu uma tarefa ao Dev.", `dialogue.py:75-76`). Os textos ricos deste plano (com ID de tarefa e detalhe de domínio) correspondem à saída **com enriquecimento LLM ligado** (`dialogue.py:96-124`).

> **Postura adotada (explícita):** os `summary_human` são **autorados "como se `SUMMARY_LLM_URL` estivesse ligado"** — feed rico, PT-BR, coerente com um projeto Genesis enriquecido. **Abandonamos** a alegação "1:1 com `build_summary_human` offline" (era contraditória). O que é **inegociável** é o `event_type` canônico e os pares `from`/`to` da §5.0 — é isso que caracteriza autenticidade estrutural do feed. Alternativa, se o Jean preferir indistinguibilidade do offline puro: usar os templates literais genéricos de `build_summary_human` (feed pobre, mas idêntico ao offline real).

### 5.2 — Apps `completed` (libs/CLI/infra/e2e) — coerência do arco

O runner emite `devops.deploy` (from='monitor', to='devops') em **todo** caminho de replay (`runner.py:5199`), independente de o app ter deploy próprio. Para fidelidade ao replay:

- **Mantém-se o arco completo** (incluindo `devops.deploy` como `monitor→devops`) também nos `completed`.
- **O step final NÃO diz "aceito"** para app `completed` (seria auto-contraditório com `status='completed'`). Texto coerente: `✅ Pipeline concluído — <app> incorporado ao produto Venuxx V2.` Para `accepted`: `✅ Projeto <app> aceito e incorporado ao produto Venuxx V2.`

**Tabelas envolvidas** (`migrations/001_initial_schema.sql`):
- `project_spec_files` — `filename`/`file_path` a um `.md` coerente (ex.: `specs/logistics-ingest.md`).
- `project_tasks` — `task_id` (`TSK-BE-001`…), `module` (`backend|web|mobile`), `owner_role` (`DEV_BACKEND/QA_BACKEND/DEVOPS_DOCKER/...`), `status` terminal `DONE`/`QA_PASS`, `evidence`. **Confirmar CHECK de `owner_role` no schema antes de inserir** (gap).
- `project_dialogue` — `from_agent`, `to_agent`, `event_type`, `summary_human` (PT-BR NOT NULL), `created_at` **monotônico minuto-a-minuto**.
- `projects.charter_summary`/`backlog_summary`; `started_at`/`completed_at` coerentes; `extra` JSONB com `project_type` (normalizado) e `accepted_by`.

### 5.3 — Exemplo ponta a ponta: **logistics-ingest** (`backend_api`, accepted), `T0=2026-03-02T09:00:00Z`, +1 min/turno

| # | +min | from → to (colunas) | event_type | summary_human (PT-BR) |
|---|---|---|---|---|
| 1 | 00 | cto → engineer | `cto.engineer.request` | O CTO enviou a especificação de **logistics-ingest** ao Engineer para definir squads técnicas. |
| 2 | 01 | engineer → cto | `engineer.cto.response` | O Engineer respondeu com a composição: 1 squad backend Node/Lambda, 1 de QA e 1 de DevOps serverless. |
| 3 | 02 | cto → pm | `project.created` | O projeto **logistics-ingest** foi criado e entregue ao PM para planejamento. |
| 4 | 03 | pm → cto | `module.planned` | O PM planejou o módulo **backend**: `POST /orders/ingest`, gravação idempotente em DynamoDB, validação de payload RAW. |
| 5 | 04 | pm → dev | `task.assigned` | O PM atribuiu ao Dev a **TSK-BE-001** — handler de ingestão com chave de idempotência SHA-256. |
| 6 | 05 | dev → qa | `task.completed` | O Dev concluiu a **TSK-BE-001**: handler implementado, com testes de idempotência e escrita no DynamoDB RAW. |
| 7 | 06 | **dev → qa** | `qa.review` | O QA revisou a entrega: contrato do endpoint, idempotência e payload malformado — aprovado (QA_PASS). |
| 8 | 07 | monitor → pm | `monitor.health` | O Monitor verificou a saúde: healthcheck OK, métricas de ingestão, sem erro de cold start. |
| 9 | 08 | **monitor → devops** | `devops.deploy` | O DevOps publicou **logistics-ingest** no ambiente serverless (Lambda), rota exposta e observabilidade ativa. |
| 10 | 09 | system → system | `step` | ✅ Projeto **logistics-ingest** aceito e incorporado ao produto **Venuxx V2**. |

> Linhas 7 e 9 usam os pares **corrigidos** (`dev→qa` e `monitor→devops`) — o texto ainda descreve QA e DevOps, mas as **colunas** batem com o que o runner grava.

`project_tasks`: `TSK-BE-001` (`DEV_BACKEND`,`DONE`), `TSK-QA-001` (`QA_BACKEND`,`QA_PASS`), `TSK-DEVOPS-001` (`DEVOPS_DOCKER`,`DONE`). `charter_summary`="API de ingestão idempotente de pedidos logísticos"; `backlog_summary`="1 módulo backend, 3 tarefas". `extra={"project_type":"backend_api","accepted_by":"zentriz-cyborg"}`.

Demais apps: mesmo arco, vocabulário adaptado ao `project_type` (`frontend_dashboard`→`module='web'`; libs→step final "Pipeline concluído"). Textos de domínio (ex.: "emissão de CT-e" no `tax`) autorados à mão mantendo `event_type` e pares canônicos.

---

## 6. Fase 4 — Auto Care (Deadpool): por que `activate` não serve, e o que fazer

> **Correção estrutural (blocker + 3 majors da banca).** O rascunho prometia `activate` "um a um" para os 16 apps `accepted`. Isso é **impossível** para apps semeados.

### 6.1 — Por que o caminho A (`activate`) é inviável para seed

`POST /api/deadpool/projects/:id/activate` (`deadpool.ts:372-441`) exige, **por query**, tudo que o seed não cria:
1. Linha em `project_github_repos` com `repo_url` — senão `409 NO_REPOSITORY`. Seed não cria (o molde `seed-example-projects.ts` tampouco toca essa tabela).
2. Linha em `tenant_github_installations` com `installation_id` — senão `409 NO_GITHUB_INSTALLATION`. O tenant Venuxx é novo, **sem GitHub App instalado** nos repos reais.
3. `backend_deployments` com `status='running'` para derivar `app_url`/`health_url`/`log_group` (`deadpool.ts:435-441`). Seed não cria → mesmo se 1 e 2 existissem, o monitoramento subiria **sem `log_group`/`health_url`** — inerte, nada a observar.

Além disso, **não existe rota Genesis de "registro base"** isolada: as únicas rotas Deadpool são `PUT /entitlement/:tenantId`, `POST /activate`, `POST /deactivate` (`deadpool.ts:296,380,561`). `registerProjectWithDeadpool` é função **interna**, chamada só no push (accept) e no activate — ambos com pré-condições. O rascunho falava em "POST server-side ao gateway" como se existisse; **não existe**.

### 6.2 — Caminho adotado: **B (Connect / `/diagnose`, ADR-015)** para os apps com serviço vivo

Os apps `accepted` do Venuxx **têm serviços reais rodando em AWS**, mas **fora** do Genesis (sem repo Genesis, sem GitHub App instalado, sem `backend_deployments` Genesis). É exatamente o caso **"alvo externo suportado"**. O caminho B:

1. **Entitlement** (só `zentriz_admin`): a licença Deadpool **não vem do plano** (`entitlements.ts:17`) → `setEntitlement(tenant_venuxx,'deadpool',true)` via `PUT /api/deadpool/entitlement/:tenantId`.
2. **Publicar contratos Connect Tier 1 por app** — `ServiceManifest` + `OwnershipManifest` + `IntegrationReadyContract` — enviados via `POST /diagnose`, onde `parse_connect_request`/`build_connect_support_profile` (`connect_contracts.py:397-430`) validam na borda e calculam `effective_tier`. `IncidentEnvelope` exige `systemId` (serviceId opcional); `service-manifest` exige `serviceId+systemId`.
3. **Identidade estável:** `systemId=venuxx-v2` (prefixo por tenant — ver 6.3), `serviceId=slug(título)` por app com runtime. Os manifestos são gerados a partir de `product.system_id` + metadados de cada app (§4.2). **Não** dependem de `backend_deployments` Genesis.
4. **Tier 0 (sem os 3 manifestos) = só observação** — **não vender como cura suportada**.

### 6.3 — Prefixo anti-colisão cross-tenant (risco central mantido)

A chave do registry do Deadpool é **global** (`systemId/serviceId`), **não conhece tenant** (`project_registry.py:38`). Prefixar `product.system_id`=`venuxx-v2` garante que os serviços fiquem `venuxx-v2/logistics-ingest`, `venuxx-v2/tms`, etc., sem colidir com outro tenant. Auditar `.deadpool-state/registry/projects.json`: cada chave deve ser `venuxx-v2/<serviço>`, sem serviço órfão bare-slug (`PRODUCT_APP_INBOX_MODEL.md:183`).

### 6.4 — Caminho A como esforço de provisionamento separado (ASSUNÇÃO/decisão do Jean)

Se o Jean quiser o **caminho A nativo** (git-link + CloudWatch Genesis) em vez de B, é preciso, **fora do seed** e com custo real:
- Instalar o **GitHub App do Genesis** nos repositórios Venuxx reais e gravar `tenant_github_installations.installation_id`.
- Criar `project_github_repos.repo_url` por app apontando aos repos Venuxx.
- Semear `backend_deployments` (`status='running'`, `app_url`/`health_url`/`log_group` reais dos serviços em AWS) por app `accepted`.
- Só então `POST /activate` (um a um; não há bulk) passa nas 4 pré-condições.

> **DECISÃO DO JEAN (marcar):** recomendo **caminho B** (Connect/`/diagnose`) — coerente com "alvo externo", sem instalar GitHub App em repos de terceiros nem forjar deployments. Caminho A fica registrado como opção de "cura nativa plena" para quando os repos Venuxx forem, de fato, git-linkados ao Genesis. **Sem uma das duas rotas provisionada, nenhum app é monitorado — e o seed (Fases 1–3) permanece completo e válido de qualquer forma.**

---

## 7. Fase 5 — Validação e verificação

**7.1 — Invariantes 064:**
```sql
SELECT count(*) FROM projects WHERE product_id IS NULL;                                   -- 0
-- nenhum app terminal no inbox:
SELECT p.title, p.status FROM projects p JOIN products pr ON pr.id=p.product_id
  WHERE pr.is_inbox AND p.status = ANY (ARRAY['accepted','completed','running','stopped']); -- 0 linhas
-- 28 apps no produto Venuxx V2:
SELECT count(*) FROM projects p JOIN products pr ON pr.id=p.product_id
  WHERE pr.name='Venuxx V2' AND pr.tenant_id=:tid;                                          -- 28
-- system_id do produto setado (rota pública NÃO seta; seed seta direto):
SELECT system_id FROM products WHERE name='Venuxx V2' AND tenant_id=:tid;                   -- 'venuxx-v2' (não NULL)
-- system_id único POR TENANT (064 é por-tenant; cross-tenant é convenção):
SELECT tenant_id, lower(system_id), count(*) FROM products
  WHERE system_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1;                               -- 0 linhas
```

**7.2 — Diálogos e tarefas:**
```sql
SELECT p.title, count(d.*) FROM projects p LEFT JOIN project_dialogue d ON d.project_id=p.id
  WHERE p.product_id=(SELECT id FROM products WHERE name='Venuxx V2') GROUP BY 1;           -- 10 (accepted) / 10 (completed, arco completo §5.2)
-- pares from/to canônicos (amostra qa.review e devops.deploy):
SELECT event_type, from_agent, to_agent, count(*) FROM project_dialogue
  WHERE event_type IN ('qa.review','devops.deploy') GROUP BY 1,2,3;
  -- qa.review → dev/qa ; devops.deploy → monitor/devops
-- ordem monotônica:
SELECT project_id, bool_and(created_at >= lag_ca) FROM (
  SELECT project_id, created_at, lag(created_at) OVER (PARTITION BY project_id ORDER BY created_at) lag_ca
  FROM project_dialogue) s WHERE lag_ca IS NOT NULL GROUP BY 1;                             -- todos true
SELECT count(*) FROM project_tasks WHERE status NOT IN ('DONE','QA_PASS')
  AND project_id IN (SELECT id FROM projects WHERE product_id=(SELECT id FROM products WHERE name='Venuxx V2'));  -- 0
-- coerência do step final vs status (completed não diz 'aceito'):
SELECT p.status, d.summary_human FROM project_dialogue d JOIN projects p ON p.id=d.project_id
  WHERE d.event_type='step' AND p.status='completed' AND d.summary_human ILIKE '%aceito%';  -- 0 linhas
```

**7.3 — Tenant/plano/carência:**
```sql
SELECT status, billing_exempt, plan_id FROM tenants WHERE id=:tid;   -- active, true, plan_diamante
SELECT count(*) FROM users WHERE tenant_id=:tid AND role='tenant_admin' AND status='active'; -- 1
SELECT is_inbox, count(*) FROM products WHERE tenant_id=:tid GROUP BY 1;                      -- 1 inbox + 1 Venuxx V2
```

**7.4 — Smoke no portal (dev `:3010`):** login jeanolbar@venuxx.com; **Meus produtos** mostra "Venuxx V2" (INBOX oculto); abrir produto → `/projects?product=<id>` com `🧩 Venuxx V2 · 28 projeto(s)`; abrir app → feed PT-BR renderiza o arco; **barra de uso lê `28/50` (Diamante)** — cosmético, sem bloqueio; INBOX só aparece na Bancada.

**7.5 — Deadpool (só se env setado e caminho B executado):** `POST /diagnose` retorna `effective_tier≥1` para apps com os 3 manifestos; painel do tenant lista `venuxx-v2/*`; degradação graciosa se `DEADPOOL_BASE_URL` ausente (HTTP 200 `available:false`, nunca 500). **Não** validar `activate` (não é o caminho adotado).

---

## 8. Fase 6 — Rollout dev → main → prod

**8.1 — Alvo do seed = PROD (o tenant só existe lá).** O tenant `0931c5dc-…b4b2` foi criado no portal de PROD; **não existe em dev**. Logo o seed dos 28 apps roda contra o Postgres de PROD. Dois caminhos:
- **(recomendado) Ensaio em dev com tenant espelho:** recriar um tenant equivalente em dev (mesmo `system_id` de produto), rodar o seed com `--dry-run` e depois `--commit` em dev, validar 7.1–7.4, ajustar textos/tipos — e só então repetir em PROD apontando ao `tenant_id` real. Evita estrear o script direto em produção.
- **(mínimo) Direto em PROD com `--dry-run` obrigatório:** `--dry-run` primeiro (loga as operações, não commita), conferir contagens, depois `--commit`. Snapshot `pg_dump` do schema `public` de PROD antes (rollback §8.4).

**8.2 — Código.** Commitar **só** o script e docs (branch `dev`), **nunca `git add -A`** (evitar `.next/`, `pnpm-lock.yaml`, `._*`; repo usa **npm**). Merge `dev`→`main` após revisão.

**8.3 — prod (ECR→SSH, manual).**
- **Imagem** (só se o bundle da api mudou): build padrão → `ecr-push.sh 820198199720 us-east-1 api` → no prod: rollback-tag (`rollback-api:pre-venuxx-seed`), login ECR pela instance role, pull, retag, `docker compose up -d --no-build --force-recreate api`. Conferir **digest** (healthy não prova código novo).
- **Dados (seed) — senha NUNCA por argv** (correção major da banca: `-e VAR="senha"` vaza em `ps aux`/`/proc/<pid>/cmdline` e no histórico de shell local e do host). Injeção segura via **stdin**:

```bash
# a senha nunca vira argumento; é lida do stdin pelo script.
# HISTCONTROL=ignorespace + linha iniciada por espaço evita o histórico.
 read -rs VENUXX_ADMIN_PASSWORD    # digitada, não ecoada, não em history
 printf '%s' "$VENUXX_ADMIN_PASSWORD" | \
   ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 \
   'sudo docker exec -i zentriz-genesis-api-1 node dist/db/seed-venuxx-v2.js --commit --password-stdin'
 unset VENUXX_ADMIN_PASSWORD
```
> O script lê a senha de **stdin** (`--password-stdin`), **não** de `-e VENUXX_ADMIN_PASSWORD=valor`. Alternativa: `--env-file` root-only `chmod 600` no host, referenciado no `docker exec`, `shred` após. Rodar antes com `--dry-run` (loga operações, não commita).

**8.4 — Rollback (dados) — `--rollback` faz DELETE real, não `ROLLBACK` de transação** (correção major da banca). O flag executa as sentenças destrutivas escopadas por tenant+produto, dentro de transação com **COMMIT**:
```sql
DELETE FROM projects WHERE product_id=(SELECT id FROM products WHERE name='Venuxx V2' AND tenant_id=:tid); -- cascata dialogue/tasks
DELETE FROM products  WHERE name='Venuxx V2' AND tenant_id=:tid;
-- opcional: DELETE FROM users WHERE tenant_id=:tid; DELETE FROM tenants WHERE id=:tid;
```
**Imagem:** `sudo docker tag rollback-api:pre-venuxx-seed zentriz-genesis-api:latest && docker compose up -d --no-build --force-recreate api`.

**8.5 — Persistir memória (LEI 0).** Antes de fechar: gravar IDs (tenant_id, product_id Venuxx V2, plan escolhido, digests, tags de rollback, `billing_exempt` + **D+180 = 2027-02-26**, caminho de Auto Care escolhido) em `~/.claude/projects/.../memory/` com ponteiro no `MEMORY.md`.

---

## 9. Idempotência e rollback — contrato técnico corrigido

> Correções majors/minors da banca sobre o esqueleto do rascunho.

- **Tenant:** **já criado** (`id=0931c5dc-…b4b2`) — o seed **não insere tenant**; recebe o `id` fixo por parâmetro ou faz `SELECT id FROM tenants WHERE lower(email)='jeanolbar@venuxx.com'`. **Não** buscar por `lower(name)='venuxx'` (o nome real é `VENUXX TECHNOLOGIES LTDA` — não casaria). **Nunca** `INSERT` com UUID novo (duplicaria tudo). `tenants` não tem unique em `name`/`email`, então a segurança é usar o `id` conhecido.
- **Produto:** `INSERT ... ON CONFLICT (tenant_id, lower(system_id))` é válido (existe `uq_products_system_id_per_tenant`).
- **Apps:** **não** há unique em `projects(tenant_id, product_id, title)` → `ON CONFLICT` sobre essa tripla **falha em runtime**. Usar find-or-create: `SELECT id FROM projects WHERE tenant_id=$1 AND product_id=$2 AND title=$3`; inserir só se ausente (padrão de `seed-example-projects.ts:33-42`).
- **Diálogos:** `DELETE FROM project_dialogue WHERE project_id=$1` antes de reinserir o arco.
- **`ON CONFLICT` só onde há unique real:** `plans(id)`, `products(tenant_id, lower(system_id))`, INBOX via `resolveInboxProductId`.
- **Transação:** `try { BEGIN … COMMIT } catch(e){ await client.query('ROLLBACK'); throw e } finally { client.release() }` — sem o `catch`, uma exceção devolve conexão em estado `transaction is aborted` e envenena o pool. Chamar `await pool.end()` no encerramento (como o molde).

### Esqueleto corrigido — `applications/services/api-node/src/db/seed-venuxx-v2.ts`
```ts
// Uso: node dist/db/seed-venuxx-v2.js [--dry-run|--commit|--rollback] [--password-stdin]
// Senha admin: lida de stdin (--password-stdin) ou de process.env.VENUXX_ADMIN_PASSWORD; nunca por argv.
import { pool } from "./pool";
import { hashPassword } from "../auth";
import { resolveInboxProductId } from "../services/inbox";
import { normalizeProjectType } from "../services/typePolicyNormalizer";

const APPS: { title:string; type:string; stack:string; desc:string;
              status:"accepted"|"completed"; module:"backend"|"web"|"mobile" }[] = [
  { title:"logistics-ingest", type:"backend_api", stack:"Node 20 · TS · Lambda",
    desc:"POST /orders/ingest → RAW no DynamoDB (idempotente).", status:"accepted", module:"backend" },
  // ... os 28 apps da §4.2 ...
];

// pares from/to derivados de _post_dialogue (§5.0), NUNCA dos args de _get_summary_human:
const ARC = [
  ["cto","engineer","cto.engineer.request"], ["engineer","cto","engineer.cto.response"],
  ["cto","pm","project.created"], ["pm","cto","module.planned"],
  ["pm","dev","task.assigned"], ["dev","qa","task.completed"],
  ["dev","qa","qa.review"],            // CORRIGIDO
  ["monitor","pm","monitor.health"], ["monitor","devops","devops.deploy"], // CORRIGIDO
] as const;

async function readPassword(): Promise<string> {
  if (process.argv.includes("--password-stdin")) { /* ler stdin até EOF */ }
  const pw = process.env.VENUXX_ADMIN_PASSWORD ?? "<stdin>";
  if (pw.length < 8 || pw.length > 128) throw new Error("senha inválida (8–128)");
  return pw;
}

async function main() {
  const mode = process.argv.includes("--commit") ? "commit"
             : process.argv.includes("--rollback") ? "rollback" : "dry-run";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (mode === "rollback") {
      // DELETEs REAIS de §8.4, escopados por tenant+produto (NÃO é ROLLBACK-de-transação)
      await client.query("COMMIT");
      return;
    }
    // 1) tenant JÁ existe (plan_diamante, active, billing_exempt=true) — NÃO criar.
    //    const tid = argTenantId ?? (SELECT id FROM tenants WHERE lower(email)='jeanolbar@venuxx.com');
    //    if (!tid) throw new Error("tenant Venuxx não encontrado — criar antes");  // seed NÃO cria tenant
    // 2) admin JÁ existe (jeanolbar@venuxx.com, tenant_admin) — NÃO recriar; readPassword() dispensável neste caso.
    // 3) INBOX 'Rascunhos' JÁ existe (resolveInboxProductId apenas confirma; não recebe apps)
    // 5) produto 'Venuxx V2': INSERT direto com system_id='venuxx-v2'
    //    ON CONFLICT (tenant_id, lower(system_id)) DO NOTHING  // unique real
    // 6) por APP: SELECT-first (tenant_id,product_id,title); INSERT se ausente
    //    (status, extra.project_type=normalizeProjectType(type), charter/backlog, started/completed_at);
    //    DELETE project_dialogue WHERE project_id; INSERT ARC (created_at +1min);
    //    step final coerente (accepted→'aceito' / completed→'Pipeline concluído');
    //    INSERT project_tasks terminais; INSERT project_spec_files
    if (mode === "commit") await client.query("COMMIT");
    else await client.query("ROLLBACK"); // dry-run
  } catch (e) {
    await client.query("ROLLBACK"); throw e;   // não envenenar o pool
  } finally {
    client.release();
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```
O Auto Care (Fase 4) fica **fora** do seed (chamadas ao gateway `/api/deadpool/...` / `/diagnose`), preservando idempotência e o princípio "registro nunca fatal".

---

## 10. Riscos

1. **Colisão cross-tenant no registry Deadpool** (chave global `systemId/serviceId`). Mitigação: prefixo `venuxx-v2`. Central.
2. **`billing_exempt` não expira sozinho** — flip manual em D+180 (2027-02-26) + `generate-month`. Sem lembrete, tenant fica grátis indefinidamente.
3. **Escolha de plano é cosmética** — `max_projects` é display-only (sem enforcement). Barra `28/50` (Diamante). **Não** criar `plan_venuxx` público (§3.1.1).
4. **`DEADPOOL_BASE_URL` vazio em prod** → Fase 4 é no-op. Mitigação: 0.4 antes de prometer cura.
5. **Caminho A (`activate`) inviável para seed** — exige GitHub App + repos + `backend_deployments` reais. Mitigação: caminho B (Connect/`/diagnose`) ou provisionamento separado (§6.4).
6. **Seed direto no banco não passa por `/run`/`/accept`** — nenhum invariante de runtime é reavaliado; não há constraint que barre app terminal no inbox. Mitigação: `product_id` sempre no produto de entrega; verificação 7.1.
7. **Autenticidade dos pares from/to** — divergência prova feed sintético. Mitigação: §5.0 (derivar de `_post_dialogue`; conferir runner antes de inserir).
8. **`project_type` fora da taxonomia → `_default`.** Mitigado pelo mapa 4.1 + `normalizeProjectType`.
9. **Manifestos Connect ausentes → Tier 0** (só observação). Mitigação: §6.2 se quiser Tier ≥1.
10. **Schemas não confirmados** (`project_tasks.owner_role` CHECK, campos migrations 052/062/063). Mitigação: 0.3 (`Read`/grep do DDL antes de inserir).
11. **Deploy "healthy" ≠ código novo** — sempre conferir digest.
12. **Vazamento de senha** — nunca por argv/`-e VAR=valor`; stdin/env-file root-only (§8.3).
13. **Falso rollback** — `--rollback` = DELETE real com COMMIT, jamais `ROLLBACK`-de-transação (§8.4/§9).

## 11. Assunções e decisões explícitas (para o Jean)

- **A1 (plano) — ✅ RESOLVIDA.** Tenant criado em **`plan_diamante`** (SKU existente, barra `28/50`). `max_projects` é display-only (sem enforcement). Não foi criado `plan_venuxx` (evitou exposição pública via `GET /api/plans`/signup).
- **A2 (carência) — ✅ APLICADA (com pendência de data).** "6 meses grátis" = `status='active'` + `billing_exempt=true` + cobrança inicial cancelada. **Flip manual D+180 = 2027-02-26** (`billing_exempt=false` + `generate-month`) — não expira sozinho. Não é trial nativo.
- **A3 (senha).** Fornecida na execução via **stdin** (`--password-stdin`) — cobre commit, doc, **histórico de shell e process table** (§8.3). Nunca por argv.
- **A4 (materialização).** Apps por **seed** (não pela pipeline real). Topologia fiel; textos autorados "como se `SUMMARY_LLM_URL` ligado" (§5.1); pares from/to e event_type canônicos.
- **A5 (produto).** Entrega (`solo_app=false`); `system_id='venuxx-v2'` setado por INSERT direto (rota pública não seta).
- **A6 (status).** `accepted`=runtime; `completed`=libs/CLI/infra/e2e. Arco completo em ambos (inclui `devops.deploy` `monitor→devops`), só o step final difere.
- **A7 (Auto Care).** Caminho **B (Connect/`/diagnose`)** para apps com serviço vivo. Caminho A (`activate`) só após provisionar GitHub App + repos + `backend_deployments` reais (§6.4) — **decisão do Jean**.
- **A8.** Módulos mortos do inventário (connect/deadpool só `.md`, `temp/`, `._*`) **não** viram apps.

---

## 12. Validação adversarial — o que foi atacado e resolvido

**Lente: modelo-invariantes**
- **[major] `activate` tem pré-condições que o seed não satisfaz.** → Resolvido em §1 e §6: caminho A declarado inviável para seed; adotado caminho B (Connect/`/diagnose`); caminho A vira provisionamento separado (§6.4, A7).
- **[minor] `tenants.responsible` não existe.** → Corrigido: `responsible_name`/`responsible_email` em §3.2, §9 e no esqueleto. §0.3 obriga auditar o DDL antes de inserir.
- **[nit] `POST /api/products` não grava `system_id`.** → Corrigido em §4: `INSERT` direto com `system_id='venuxx-v2'`; removida a redação "equivalente a POST /api/products"; 7.1 valida `system_id` não-nulo.

**Lente: autenticidade-dialogos**
- **[major] Pares from/to divergem do runner.** → Corrigido: §5.0 (tabela canônica), `qa.review`=`dev→qa`, `devops.deploy`=`monitor→devops`; §5.3 linhas 7/9 ajustadas; esqueleto `ARC` reflete os pares. Verificação 7.2 confere as colunas.
- **[minor] Contradição "1:1 com `build_summary_human`".** → Resolvido em §5.1: postura explícita "como se `SUMMARY_LLM_URL` ligado"; removida a alegação 1:1; event_type canônico mantido.
- **[minor] Apps `completed`: step "aceito" e truncar `devops.deploy`.** → Resolvido em §5.2: arco completo (inclui `devops.deploy`) para todos; step final coerente com `completed` ("Pipeline concluído"). Verificação 7.2 checa ausência de "aceito" em `completed`.

**Lente: deadpool-identidade**
- **[blocker] `activate` retorna 409 para todo app semeado.** → Resolvido em §6.1/§6.2: reconhecido; caminho B adotado; caminho A documentado como provisionamento externo (§6.4).
- **[major] `activate` sem `backend_deployments` → monitoramento inerte.** → §6.1 item 3 + §6.4 (semear `backend_deployments` reais se optar por A); B não depende disso.
- **[major] Não existe "registro base" separado.** → §6.1: corrigido; só há entitlement/activate/deactivate; `registerProjectWithDeadpool` é interna. Removida a promessa de "POST server-side ao gateway".
- **[minor] `system_id` na rota vs. INSERT.** → §4 + §7.1: INSERT direto; unicidade é por-tenant (064), cross-tenant é convenção.

**Lente: plano-carencia-billing**
- **[major] `max_projects` sem enforcement.** → Correção estrutural §3.1: display-only; "tensão central" e o antigo Risco #3 desfeitos; escolha vira comercial/cosmética.
- **[major] `plan_venuxx` fica público via signup.** → §3.1.1: rejeitado; recomendação muda para Diamante (b); alternativas (schema `is_public` / rota master) registradas.
- **[major] Senha inline `-e VAR="senha"` vaza.** → §8.3 + A3: stdin (`--password-stdin`) ou env-file root-only; cobre `ps aux`/`/proc`/histórico.

**Lente: ops-idempotencia-rollback**
- **[major] `--rollback` só fazia `ROLLBACK` da transação (falso rollback).** → §8.4/§9: `--rollback` executa DELETEs reais com COMMIT, escopados por tenant+produto.
- **[major] `tenants` sem unique → rerun duplica tenant.** → §9 (REV.2): tenant já existe; seed reusa `id` fixo ou `SELECT ... WHERE lower(email)='jeanolbar@venuxx.com'` — **nunca** `lower(name)='venuxx'` (nome real é `VENUXX TECHNOLOGIES LTDA`, não casaria) nem UUID novo.
- **[major] `ON CONFLICT` em `projects(tenant_id,product_id,title)` sem unique falha.** → §9: SELECT-first para apps; `ON CONFLICT` só onde há unique real (`plans.id`, `products` uq per-tenant).
- **[minor] Sem `catch`/ROLLBACK → pool envenenado; sem `pool.end()`.** → §9 esqueleto: `catch{ ROLLBACK; throw }` + `await pool.end()`.
- **[minor] `tenants.responsible` inexistente (dup).** → Corrigido junto com o achado de modelo-invariantes.

**Ajustes menores agrupados:** normalização de `project_type` via `normalizeProjectType` (Risco #8); auditoria de DDL antes de inserir em `project_tasks`/`project_spec_files` (§0.3, Risco #10); verificação de monotonicidade e coerência status↔step em 7.2.

---

## 13. Estado atual e pendências (REV. 2 — 2026-08-26)

**✅ Concluído (PROD):** Fase 1 — tenant `0931c5dc-46eb-474a-a54a-dad12733b4b2` (**VENUXX TECHNOLOGIES LTDA**, `plan_diamante`, `active`, `billing_exempt=true`), admin Jean (`tenant_admin`, active), INBOX "Rascunhos" (`016cad3b-…`), cobrança inicial cancelada, cache de status invalidado (`pg_notify`).

**⏳ Pendente (aguarda ok do Jean):**
- **Fase 2–3 — seed dos 28 apps** (produto `Venuxx V2` + apps tipados + diálogos/logs). Roda contra PROD (o tenant só existe lá); `--dry-run` antes do `--commit`; snapshot `pg_dump` antes. **Não** cria tenant/admin/INBOX (já existem).
- **Fase 4 — Auto Care (caminho B):** `setEntitlement(tenant,'deadpool',true)` + contratos Connect `/diagnose`. Verificar `DEADPOOL_BASE_URL` no container api de PROD (§0.4).
- **D+180 = 2027-02-26 — flip da carência:** `billing_exempt=false` + `generate-month`. **Não expira sozinho.**

**✅ Resolvido (2026-08-26, decisão do Jean):**
1. **Responsável do tenant.** Diogo Della Gomes **é** o responsável legal da Venuxx; Jean permanece como *usuário admin*. `responsible_email` estava vazio → **setado para `diogo@venuxx.com`** em PROD (`UPDATE tenants SET responsible_email='diogo@venuxx.com' WHERE id='0931c5dc-…'`). `responsible_name` mantido como "Diogo Della Gomes".
2. **Comunicação ao cliente.** Enviados 3 e-mails Zentriz-branded (dark, responsivos) a `diogo@venuxx.com`, reply-to `jean@zentriz.com.br`: (1) ambiente criado, (2) ambiente ativado, (3) fatura do mês abatida integralmente em créditos de cortesia (6 meses).
3. **Campo no signup.** Adicionado o campo **"E-mail do responsável"** (`responsibleEmail`) ao formulário público `/tenant/signup` (`genesis-web`) — o backend já aceitava/persistia; faltava só o input no form. Commit local, **não** deployado.

**⚠️ Confirmar com o Jean:**
1. **Fatura anômala.** A cobrança inicial cancelada era **R$ 77.000,00** — incompatível com Diamante (R$ 999/mês). Provável erro de entrada no cadastro. Ao fim da carência (D+180), recriar uma cobrança correta (Diamante mensal) via `generate-month`.
2. **Sistema de créditos (futuro).** Hoje "6 meses de crédito" é modelado por `billing_exempt` (isenção binária, sem saldo). Construir ledger de créditos auditável e seguro (ver nota em §3.2) para refletir a realidade — decrementando saldo por ciclo em vez de isenção plana.
