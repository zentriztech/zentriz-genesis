> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0002: Genesis Admin (conta de gestão) e Módulo Financeiro

## Status

Rascunho

## Data

2026-08-17

## Resumo

Refinar o papel `zentriz_admin` para uma **conta de gestão pura** (governa Tenants, usuários e projetos de tenants — nunca cria/envia specs, projetos ou produtos) e introduzir um **Módulo Financeiro simples e completo** (cobranças, pagamentos, notas fiscais e contas bancárias da empresa) acoplado ao modelo Tenant/Plano já existente.

## Contexto

O Genesis já opera em produção como control plane multi-tenant com três papéis (`user`, `tenant_admin`, `zentriz_admin`) — ver `routes/auth.ts:5`, `middleware/auth.ts:4-9`. Dois problemas motivam esta RFC:

### A. A "conta de gestão" hoje é apenas cosmética (só UI)

A intenção de que o `zentriz_admin` seja uma **conta de gestão** (não um operador que cria specs/projetos) já está expressa no portal, mas **não há enforcement no backend**:

- O menu esconde itens de criação **apenas** quando nenhum tenant está selecionado — `components/AppLayout.tsx:125-127` + `HIDE_WHEN_NO_TENANT` (`AppLayout.tsx:101-114`). Assim que o master seleciona um tenant, o menu de criação **reaparece**.
- No backend, os endpoints de criação **permitem explicitamente** o `zentriz_admin`:
  - `POST /api/specs` — `routes/specs.ts:504-506` permite se `user.tenantId` **OU** `role === "zentriz_admin"`.
  - `POST /api/catalog/:slug` — `routes/catalog.ts:60-64` idem, e faz **fallback para o primeiro tenant** (`catalog.ts:80-81`).
  - `POST /api/products/ingest` — `routes/products.ts:187-189` faz fallback para o primeiro tenant quando o chamador não tem tenant.

Ou seja: um `zentriz_admin` sem tenant **consegue** criar specs/projetos hoje, contrariando a decisão do Jean ("a conta de gerenciamento também não cria ou envia specs"). A governança precisa descer para o backend.

### B. Não existe nenhuma camada financeira

O produto nasce com a promessa de cobrança — o signup cria o tenant com `status = 'inactive'` e mostra *"Seu tenant será ativado após a confirmação do pagamento"* (`routes/signup.ts:176`, `:211`) — mas **nada implementa isso**. Não há tabelas nem código de billing/invoice/payment/subscription em lugar nenhum do repositório (confirmado por varredura ampla; todos os hits de "cobrança/nota fiscal" são textos de templates do catálogo de specs, não schema). Hoje só o `PATCH /api/tenants/:id` (`routes/tenants.ts:235+`) muda `inactive → active`, manualmente.

O preço já é modelado: `plans.monthly_price_cents` (migration `050_plan_monthly_price.sql`) — `plan_prata` R$99,00 / `plan_ouro` R$299,00 / `plan_diamante` R$999,00. O tenant já carrega CNPJ + endereço completo (migration `052`) — dados de emitente/tomador necessários para nota fiscal. Falta a camada que transforma "plano × tenant ativo" em cobrança, recebimento, ativação e NF.

## Proposta

Duas frentes independentes, entregues em fases. **Dinheiro sempre em inteiro de centavos** (`*_cents INTEGER`), reaprovando a convenção de `monthly_price_cents`.

---

### Parte A — Genesis Admin: conta de gestão pura

Não é um novo tier de conta. É o `zentriz_admin` **refinado**: reusa RBAC, login e JWT atuais. A conta de gestão **pode**: gerenciar Tenants (CRUD, ativar/suspender), usuários, planos, e **operar o ciclo de vida** de projetos de tenants (ver, mudar status, cancelar, limpar, relatórios, DLQ, watchdog) + o novo Módulo Financeiro. A conta de gestão **não pode**: criar/enviar spec, criar projeto, criar produto, adicionar tasks, evoluir versão, disparar pipeline (`/run`).

**A.1 — Enforcement no backend (o coração desta parte).** Centralizar um guard único e aplicá-lo **apenas aos endpoints de AUTORIA** (não aos de operação de ciclo de vida), negando `zentriz_admin`:

- Novo helper compartilhado (ex.: `middleware/managementGuard.ts`) — `denyCreationForManagement(user, reply)`: se `user.role === "zentriz_admin"` → `403 { code: "MANAGEMENT_ACCOUNT_READONLY_CREATE", message: "Conta de gestão não cria specs/projetos/produtos" }`.
- Aplicar SOMENTE em endpoints de autoria: `POST /api/specs` (`specs.ts:504`), `POST /api/catalog/:slug/use` (`catalog.ts:60`), `POST /api/products` (`products.ts:165`), `POST /api/products/propose` (`products.ts:265`), `POST /api/products/ingest` (`products.ts:187`), `POST /api/products/ingest-proposal` (`products.ts:~300`), `POST /api/projects/:id/evolve` (`projects.ts:2590` — evolve cria projeto-filho = autoria), e o gatilho de criação por Telegram (`telegram.ts:1002`).
- **⚠️ NÃO aplicar o guard em `POST /api/projects/:id/run` (`pipeline.ts:80`) nem `POST /api/projects/:id/tasks` (`projects.ts:401`)** — descoberta da revisão adversarial (H1): esses são endpoints de **ciclo de vida/operação**, exercitados por chamadores INTERNOS com token `zentriz_admin`/derivado-do-dono: o watchdog cunha `signToken({sub:"watchdog", role:"zentriz_admin"})` e chama `/run` (`watchdog.ts:473`), e o runner semeia tasks via `/tasks` (`runner.py`). Um 403 cego aqui **mataria a promoção da fila e o seed de tasks do pipeline**. A conta de gestão MAY operar o ciclo de vida (o próprio A diz isso). Se um dia for preciso separar identidade de máquina da gestão humana, fazer via **role de serviço dedicada** (`sub:"runner"/"watchdog"` → `role:"service"`), nunca por `role:"zentriz_admin"` sozinho.
- **Remover TODOS os fallbacks "primeiro tenant"** — a revisão (M6) encontrou três, não dois: `catalog.ts:80-81`, `products.ts:189` (ingest) **e `products.ts:310` (ingest-proposal)**; conferir também `specs.ts:655`. `/ingest` e `/ingest-proposal` hoje não têm guard de papel algum — qualquer token com `tenantId=null` cria produto+N projetos num tenant arbitrário. Os quatro handlers de criação passam a EXIGIR tenant explícito do chamador e rejeitar chamador sem tenant (400/403), nunca escolher o primeiro silenciosamente.
- Endpoints de gestão/leitura permanecem liberados ao `zentriz_admin` (Tenants/Plans CRUD, `?tenantId=` scoping, cleanup, reports, DLQ, watchdog, **`/run` e `/tasks` como alavancas operacionais de suporte** — já mapeados em `tenants.ts`, `plans.ts`, `projects.ts`, `pipeline.ts:400-481`).
- **Nota (L5):** `POST /api/products` (`products.ts:165`) já retorna 403 para chamador sem tenant, e `zentriz_admin` tem `tenantId=null` → o guard ali é redundante (inócuo). O nome real da rota de catálogo é `POST /api/catalog/:slug/use`.

**A.2 — Nav sempre em modo gestão para `zentriz_admin`.** Hoje `HIDE_WHEN_NO_TENANT` só filtra quando não há tenant selecionado (`AppLayout.tsx:125-127`). Refinar: para `zentriz_admin`, os itens de criação (`/spec`, `/specs`, `/splitter`, `/projects` de criação) ficam **sempre** ocultos — mesmo com tenant selecionado. Mantêm-se Dashboard, Notificações, Tenants, Usuários, Projetos (gestão `/zentriz/projects`), Planos, **Financeiro** (novo) e os painéis operacionais (Deadpool, LLM/IA, GitHub, Cloud, Deployments, Runtime Config, Skill Store) — que são gestão/observação, não criação de produto.

**A.3 — Sem migration.** Parte A é guard + UI. Nenhuma mudança de schema.

---

### Parte B — Módulo Financeiro

Sistema de gestão financeira **simples e completo** para o negócio SaaS da Zentriz: cobrar tenants pelo plano, registrar recebimentos, ativar/suspender por pagamento, emitir/registrar notas fiscais e manter as contas bancárias da empresa. Integrações externas (gateway de pagamento, NF-e) ficam **atrás de portas** (padrão já usado em `EmailSender`/`CnpjLookup`) e começam em modo **manual** (registro), sem "ligar já" — pluggáveis depois.

#### B.1 — Modelo de dados (migrations 053+)

Seguir as convenções do runner (`db/init.ts:23-45`, guard `migrations.test.ts`): sem `;` dentro de literal, aspas simples balanceadas por statement, `E'...'` single-line, DDL idempotente (`CREATE TABLE IF NOT EXISTS`).

**`company_bank_accounts`** — contas bancárias da Zentriz (emitente/recebedor):
```
id UUID PK, label TEXT, bank_name TEXT, bank_code TEXT,
agency TEXT, account TEXT, account_type TEXT CHECK IN ('checking','savings'),
pix_key TEXT, pix_key_type TEXT, holder_name TEXT, holder_document TEXT,
is_default BOOLEAN DEFAULT false, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ
```

**`charges`** — cobranças por tenant (uma por competência):
```
id UUID PK, tenant_id UUID FK→tenants(id), plan_id TEXT FK→plans(id),
amount_cents INTEGER NOT NULL, currency TEXT DEFAULT 'BRL',
description TEXT, competence_month TEXT,           -- 'YYYY-MM'
due_date DATE, status TEXT DEFAULT 'open'
  CHECK IN ('draft','open','paid','partially_paid','overdue','canceled','refunded'),
issued_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
payment_method TEXT, external_id TEXT,             -- id no gateway (futuro)
created_by UUID FK→users(id), created_at TIMESTAMPTZ,
UNIQUE (tenant_id, competence_month)               -- idempotência da geração mensal
```
Valor origina de `plans.monthly_price_cents` via `tenants.plan_id` (snapshot em `amount_cents`/`plan_id` no momento da geração, para preservar histórico se o plano mudar de preço).

**`payments`** — recebimentos (uma cobrança pode ter pagamentos parciais):
```
id UUID PK, charge_id UUID FK→charges(id), tenant_id UUID FK→tenants(id),
amount_cents INTEGER NOT NULL,
method TEXT CHECK IN ('pix','boleto','card','transfer','cash','manual'),
received_at TIMESTAMPTZ, bank_account_id UUID FK→company_bank_accounts(id),
reference TEXT, notes TEXT, created_by UUID FK→users(id), created_at TIMESTAMPTZ
```
`charges.status` é **derivado** da soma de `payments` (>= amount → `paid`; 0<soma<amount → `partially_paid`; vencida e não paga → `overdue`).

**`invoices`** — notas fiscais (emitidas ao cliente e recebidas de fornecedores):
```
id UUID PK, tenant_id UUID FK→tenants(id) NULL, charge_id UUID FK→charges(id) NULL,
direction TEXT CHECK IN ('issued','received'),     -- emitida / recebida
number TEXT, series TEXT, nfe_key TEXT,            -- chave de 44 dígitos
amount_cents INTEGER, tax_cents INTEGER,
issue_date DATE, status TEXT DEFAULT 'draft'
  CHECK IN ('draft','issued','authorized','canceled','error'),
provider TEXT DEFAULT 'manual', external_id TEXT,
pdf_url TEXT, xml_url TEXT,
counterparty_name TEXT, counterparty_document TEXT, -- snapshot emitente/tomador
created_by UUID FK→users(id), created_at TIMESTAMPTZ
```
Dados de tomador (para NF emitida) vêm do tenant: `cnpj` + `address_*` (migration `052`). Dados de emitente (Zentriz) ficam em configuração.

#### B.2 — Portas (Ports & Adapters)

- **`PaymentGateway`** (opcional, futuro): `createCharge`, `getStatus`, webhook de baixa. Adapters candidatos: **Asaas** ou **Mercado Pago** (boleto+PIX+cartão, mercado BR). Default: `ManualGateway` (só registra).
- **`InvoiceProvider`**: `issueInvoice(input) → {number, key, pdfUrl, xmlUrl, status}`. Adapters candidatos: **eNotas**, **NFe.io**, **Focus NFe**. Default: `ManualInvoiceProvider` (registro sem emissão real).

#### B.3 — API (todas sob `authMiddleware`, `zentriz_admin`-only — é gestão)

Seguir o padrão de `routes/plans.ts`: plugin `financeRoutes(app)`, `pool` parametrizado, `mapRow`, envelope `{code,message}`, registrado em `app.ts`.

- `GET/POST/PATCH/DELETE /api/finance/bank-accounts`
- `GET /api/finance/charges` (filtros `?tenantId=&status=&competence=`), `GET /api/finance/charges/:id`, `POST /api/finance/charges` (avulsa), `POST /api/finance/charges/generate-month` (gera do mês p/ tenants ativos, idempotente), `PATCH /api/finance/charges/:id` (cancelar/ajustar)
- `GET /api/finance/payments`, `POST /api/finance/payments` (registra recebimento → recalcula status da charge → **hook de ativação**)
- `GET /api/finance/invoices`, `GET /api/finance/invoices/:id`, `POST /api/finance/invoices` (emitir/registrar), `POST /api/finance/invoices/:id/cancel`
- `GET /api/finance/summary` — KPIs: MRR (soma de `monthly_price_cents` de tenants ativos), em aberto, vencido, recebido no mês.

#### B.4 — Ciclo de ativação/suspensão

- **A PRIMEIRA cobrança precisa nascer para tenant `inactive`/recém-criado** (revisão H2): o gerador `generate-month` mira tenants `ativos`, mas o signup cria `inactive` e promete ativar *após pagamento* — sem primeira cobrança, o tenant nunca paga e nunca ativa (o loop de ativação seria inalcançável justamente para o caso que existe para servir). Solução (movida para **F1**): (a) a criação/signup do tenant emite uma cobrança de onboarding imediata, OU (b) `generate-month` inclui `('inactive','active')` na primeira competência. Ativação: quando uma cobrança **de assinatura** (`kind='subscription'`) vira `paid` e o tenant está `inactive`/`suspended` **e** não resta assinatura vencida → `active` (F2, entregue; pagamento de cobrança avulsa não ativa, para não reverter suspensão manual do master). Competências seguintes miram só `active` (e opcionalmente `suspended`).
- Registrar pagamento que quita a 1ª cobrança → tenant `inactive → active` (fecha a promessa do signup, `signup.ts:211`).
- Cobrança vencida além de N dias → `overdue` e (opcional, configurável) tenant `active → suspended`.
- **⚠️ Requisito DURO de F2 (não "opcional") — recheque de status por request (revisão H3):** `signToken` tem TTL **de 7 dias** (`auth.ts:35`, `expiresIn:"7d"`) e o status do tenant só é checado **no login** e **só para usuários com `tenant_id`** (`auth.ts:79-81`). Logo, marcar `tenant.status='suspended'` tem **efeito ZERO por até 7 dias** em qualquer sessão já autenticada — suspender seria um no-op. Reduzir só o TTL é insuficiente (deixa janela + piora UX). F2 **DEVE** adicionar no `authMiddleware`, após `verifyToken`: se `user.tenantId` setado, consultar `tenants.status` via cache curto em memória (30–60s por `tenantId`); se `suspended`/`inactive` → `403 { code:"TENANT_INACTIVE" }`. **Bypass (lista exaustiva):** `zentriz_admin` (`tenantId=null`); tokens `deploy-callback`; e **tokens de MÁQUINA do runner** (claim `svc:"runner"`, cunhados só no servidor em `pipeline.ts`/`watchdog.ts`/`runnerDispatch.ts` ao despachar o pipeline). Este último é **inegociável (RFC H1)**: o orquestrador/runner usa um token **escopado no tenant** para MUITOS callbacks (`/run`, `/tasks`, `/dialogue`, `/accept`, `/deploy`, `PATCH /projects/:id`, `/agent-metrics`, …), não só `/run` e `/tasks`; se o gate barrasse esses callbacks, um pipeline em voo de um tenant que fosse suspenso no meio quebraria. A isenção é pela **IDENTIDADE do token** (`svc`), não por caminho — assim um usuário real suspenso é barrado em TODAS as rotas e não há bypass por querystring. Isso também fecha o gap pré-existente da suspensão manual (`PATCH /api/tenants/:id`) que hoje só vale no próximo login. Por ser transversal (toca toda request), é um **passo próprio, gated e deployado isoladamente** dentro de F2 — com kill-switch de emergência `H3_TENANT_STATUS_GATE=off` e invalidação de cache cross-instância via `LISTEN/NOTIFY`.

#### B.5 — Frontend

Novo grupo **"Financeiro"** no nav do `zentriz_admin` (é gestão, permitido). Páginas em `app/(dashboard)/zentriz/finance/`: `dashboard` (KPIs + gráfico), `charges`, `payments`, `invoices`, `bank-accounts`. MobX `financeStore` seguindo `plansStore`/`tenantsStore` (`makeAutoObservable` + `runInAction` + `apiGet/Post/Patch/Delete`, singleton exportado). Páginas `observer(...)`, MUI 7 (`size={{xs,md}}`), gating in-page `authStore.user?.role === "zentriz_admin"`.

## Alternativas Consideradas

1. **Novo tier de conta "Genesis Admin" separado do `zentriz_admin`** — rejeitado por decisão do Jean: reusar o `zentriz_admin` (menos RBAC, menos migração, menos superfície). A distinção é comportamental (não cria), não estrutural.
2. **Billing via Stripe Billing (SaaS pronto)** — inadequado ao mercado BR (boleto/PIX/NF-e). Se um gateway for ligado, Asaas/Mercado Pago cobrem melhor. Mantido atrás de porta para não travar a decisão.
3. **Emissão de NF-e real desde o MVP ("ligar já")** — adiado: NF-e exige certificado A1/A3, inscrição, homologação SEFAZ e é irreversível. Começar em modo manual (registro) e ligar provider depois reduz risco. Diferente do SES (baixo risco, ligado já na reforma de tenant).
4. **Preço por-tenant (override do plano)** — fora de escopo agora; `amount_cents` fica como snapshot na charge, o que já permite descontos pontuais sem coluna nova em `tenants`.

## Impacto

- **Agentes afetados**: nenhum agente do pipeline (CTO/PM/Dev/QA/DevOps) muda. É control-plane/portal.
- **Contratos afetados**: novos endpoints `/api/finance/*`; endurecimento (403 novo) nos endpoints de criação para `zentriz_admin` — **atenção**: qualquer automação/smoke que hoje crie spec como `zentriz_admin` quebra e deve migrar para um usuário com tenant. Atualizar `project/docs/API_CONTRACT.md`.
- **Documentação**: atualizar `project/docs/ACTORS_AND_RESPONSIBILITIES.md` (papel de gestão), `project/docs/PORTAL_TENANTS_AND_PLANS.md` (fluxo de cobrança/ativação) e o índice de RFCs.
- **PII/segurança**: CNPJ/endereço do tenant e documentos bancários são sensíveis — restringir a `zentriz_admin`, nunca logar; segredos de gateway/NF em env dedicada (padrão `AWS_SES_*`), nunca no código. Valores em centavos (sem float). Idempotência na geração mensal via `UNIQUE(tenant_id, competence_month)`.
- **Riscos**: (a) endurecer criação pode quebrar fluxos internos que assumem `zentriz_admin` criador → mitigar com varredura + testes antes do deploy; (b) suspensão automática sem recheque por-request é fraca → tratar explicitamente na F2; (c) NF-e real é irreversível → só via provider homologado, fora do MVP.

## Plano de Implementação

**Parte A (independente, sem migration):**
1. `middleware/managementGuard.ts` + aplicar 403 nos endpoints de criação; remover fallbacks "primeiro tenant".
2. Ajustar `AppLayout.tsx` para ocultar criação sempre que `zentriz_admin`.
3. Testes: garantir que `zentriz_admin` recebe 403 em criação e 200 em gestão; `tenant_admin` inalterado.

**Parte B — faseada (revisada após revisão adversarial):**
- **F1 (MVP):** migration 053 (bank_accounts, charges [com `kind` + índice único parcial], payments) + `financeRoutes` (bank-accounts, charges CRUD, payments manual, summary) + **geração/emissão da PRIMEIRA cobrança para tenant recém-criado** (H2) + telas Financeiro + `financeStore`. Sem gateway, sem NF.
- **F2:** `generate-month` idempotente (competências seguintes) + hook ativação (pagamento quita → active) + suspensão por vencimento + **[passo próprio, gated] recheque de status no `authMiddleware`** (H3).
- **F3:** migration de `invoices` **modeladas como NFS-e** (M1) + porta `InvoiceProvider` (adapter manual) + telas de NF (emitida/recebida, registro + upload PDF/XML).
  - **Entregue como MVP interno (decisão do Jean, 2026-08-17):** migration `056_finance_f3.sql` (tabela `invoices` com numeração sequencial própria `invoice_number_seq`; FKs `tenant_id`→RESTRICT, `charge_id`→SET NULL, M5) + porta **`InvoiceProvider`** (Ports & Adapters) com adaptador **stub interno** (`provider='internal'`, `providerRef='INT-<nº 6 dígitos>'`) + rotas `GET/POST /api/finance/invoices`, `GET /:id`, `POST /:id/cancel` (emissão só de cobrança `paid`; uma nota `issued` por cobrança via índice único parcial; cancelar libera reemissão; auditado `entity_type='invoice'`) + aba **"Notas fiscais"** no portal (`financeStore` + `zentriz/finance`). **SEM** integração NFS-e municipal, **sem** certificado A1 e **sem** as colunas fiscais completas (ISS/retenções/`service_code` de M1) — esses ficam para F4, que apenas troca o adaptador do provedor por um real, sem tocar nas rotas. Entregável 100% autônomo, sem depender de credenciais/certificado.
- **F4 (opcional):** porta `PaymentGateway` real (Asaas/Mercado Pago) + webhook de baixa (idempotente, L2); `InvoiceProvider` real (eNotas/NFe.io/Focus) homologado + modelagem fiscal NFS-e completa (M1: ISS/retenções/`service_code`/emitente).

Cada fase: gates verdes (tsc + vitest + guard de migration + build) e deploy só com OK explícito do Jean.

## Revisão Adversarial (3 lentes) — Ajustes Incorporados

Esta RFC passou por **3 revisões adversariais** independentes (2026-08-17): (1) correção de código do fluxo já em produção — signup/OTP/SES/CNPJ; (2) infraestrutura SES/credenciais; (3) design desta RFC contra o código real. As premissas centrais foram **confirmadas no código** (`specs.ts:506` e `catalog.ts:64` liberam `zentriz_admin` sem tenant; os fallbacks "primeiro tenant" existem). Os achados de design abaixo já foram refletidos acima (A.1, B.4, faseamento) e/ou ficam registrados como requisito de implementação:

- **H1 — não bloquear `/run` e `/tasks`** (corrigido em A.1): são operação de ciclo de vida usada por watchdog/runner com token `zentriz_admin`; guard só em endpoints de autoria.
- **H2 — primeira cobrança para tenant `inactive`** (movido para F1 em B.4): sem ela a ativação é inalcançável.
- **H3 — recheque de status no `authMiddleware`** (requisito duro de F2 em B.4): TTL de token = 7 dias; suspender sem recheque é no-op.
- **M1 — documento fiscal correto = NFS-e, não NF-e.** SaaS é **serviço** (ISS municipal), não mercadoria. `invoices` deve carregar `service_code TEXT` (LC-116), `municipal_code TEXT`, `iss_rate NUMERIC`, `iss_cents INTEGER` e colunas de retenção (`pis_cents, cofins_cents, csll_cents, irrf_cents, inss_cents`), com `tax_cents` agregado derivado. `nfe_key` (44 dígitos) passa a anulável, só para o caso NF-e/mercadoria. Emitente (Zentriz) em config explícita: tabela `company_profile` de linha única OU env dedicadas (CNPJ, inscrição municipal, regime, código de serviço, código do município). A porta `InvoiceProvider` fala NFS-e.
- **M2 — `UNIQUE(tenant_id, competence_month)` bloqueia cobrança avulsa legítima.** Adicionar `kind TEXT CHECK IN ('subscription','one_off','proration')` e trocar por índice único **parcial**: `... ON charges (tenant_id, competence_month) WHERE kind='subscription' AND status <> 'canceled'`. Avulsas/proration isentas; cancelar+reemitir na mesma competência funciona.
- **M3 — `status` da charge com dois donos; `overdue` sem escritor; `refunded` inalcançável.** Escritor único `recalcChargeStatus(chargeId)` em toda mudança de payment + job agendado `open/partially_paid → overdue` após `due_date`. Reembolso via payment negativo (`method='refund'`) ou tabela `refunds`; reembolsar pagamento ativador reavalia status do tenant. Ativação só quando charge atinge `paid`.
- **M4 — numeração/série de NF sem autoridade.** Sequência é do `InvoiceProvider` real; em manual, declarar que entrada manual NÃO garante sequência legal. `UNIQUE (direction, series, number) WHERE direction='issued' AND number IS NOT NULL`; sem unicidade em `received` (número é do fornecedor).
- **M5 — FKs sem `ON DELETE`, sem auditoria, `PATCH` mutando charge emitida.** `charges.tenant_id`/`payments.charge_id`/`payments.tenant_id`/`invoices.charge_id` → `ON DELETE RESTRICT`; `invoices.tenant_id` e `*.created_by` → `ON DELETE SET NULL`. **Nunca CASCADE em dinheiro/fisco.** Charge imutável após `status <> 'draft'` (PATCH só cancela ou edita rascunho; valor muda só por cancelar+reemitir). Tabela append-only `finance_audit`.
- **M6 — remoção de fallback incompleta** (corrigido em A.1): incluir `products.ts:310` (ingest-proposal) e `specs.ts:655`.
- **L1** — `CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`; competência em `America/Sao_Paulo`.
- **L2** — `payments.external_id` + `UNIQUE(method, external_id) WHERE external_id IS NOT NULL` (webhook cria `payments`).
- **L3** — `UNIQUE INDEX ON company_bank_accounts (is_default) WHERE is_default`; DELETE vira soft-delete (`active=false`).
- **L4** — A.2 descreve mal o nav: hoje `HIDE_WHEN_NO_TENANT` esconde `/deadpool` e `/settings/*` em gestão; torná-los sempre visíveis é mudança, não preservação. Enumerar o conjunto novo escondido (só autoria) e declarar painéis operacionais visíveis sem tenant.
- **L5** — rota real `POST /api/catalog/:slug/use`; guard em `products.ts:165` redundante (inócuo); `GET /finance/summary` assume moeda única (BRL).

## Referências

- [RFC-0001](RFC-0001-GRAPH-VIEW-EXECUTIVE_COMMAND_CENTER.md) — Graph View Executivo
- ADR-0001 (Spec-Driven) e ADR-0003 (Cloud-Agnostic / Ports & Adapters) — `project/docs/adr/`
- `project/docs/PORTAL_TENANTS_AND_PLANS.md`, `project/docs/ACTORS_AND_RESPONSIBILITIES.md`, `project/docs/API_CONTRACT.md`
- Reforma de tenant + SES (migrations 051/052) — base de CNPJ/endereço para NF e do fluxo `inactive → active`
