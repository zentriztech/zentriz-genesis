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

**A.1 — Enforcement no backend (o coração desta parte).** Centralizar um guard único e aplicá-lo aos endpoints de criação, negando `zentriz_admin`:

- Novo helper compartilhado (ex.: `middleware/managementGuard.ts`) — `denyCreationForManagement(user, reply)`: se `user.role === "zentriz_admin"` → `403 { code: "MANAGEMENT_ACCOUNT_READONLY_CREATE", message: "Conta de gestão não cria specs/projetos/produtos" }`.
- Aplicar em: `POST /api/specs` (`specs.ts:504`), `POST /api/catalog/:slug` (`catalog.ts:60`), `POST /api/products` (`products.ts:165`), `POST /api/products/propose` (`products.ts:265`), `POST /api/products/ingest` (`products.ts:187`), `POST /api/products/ingest-proposal`, `POST /api/projects/:id/tasks` (`projects.ts:401`), `POST /api/projects/:id/evolve` (`projects.ts:2590`), `POST /api/projects/:id/run` (`pipeline.ts:80`), e o gatilho de criação por Telegram (`telegram.ts:1002`).
- **Remover os fallbacks "primeiro tenant"** (`catalog.ts:80-81`, `products.ts:189`): criação sempre exige tenant explícito do próprio chamador (agora só `tenant_admin`/`user` com tenant criam).
- Endpoints de gestão/leitura permanecem liberados ao `zentriz_admin` (Tenants/Plans CRUD, `?tenantId=` scoping, cleanup, reports, DLQ, watchdog — já mapeados em `tenants.ts`, `plans.ts`, `projects.ts`, `pipeline.ts:400-481`).

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

- Registrar pagamento que quita a 1ª cobrança → tenant `inactive → active` (fecha a promessa do signup, `signup.ts:211`).
- Cobrança vencida além de N dias → `overdue` e (opcional, configurável) tenant `active → suspended`.
- **Gap conhecido a tratar:** `middleware/auth.ts:11-40` só valida o JWT — **não** recheca status do tenant por request; hoje a suspensão só vale no **próximo login** (`auth.ts:79-81`). O spec propõe, na fase de suspensão automática, adicionar recheque leve de status (cache curto) no `authMiddleware` ou reduzir o TTL do token. Decisão fica para a fase F2.

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

**Parte B — faseada:**
- **F1 (MVP):** migration 053 (bank_accounts, charges, payments) + `financeRoutes` (bank-accounts, charges CRUD, payments manual, summary) + telas Financeiro + `financeStore`. Sem gateway, sem NF.
- **F2:** `generate-month` idempotente + hook ativação (pagamento → active) + suspensão por vencimento + recheque de status no `authMiddleware`.
- **F3:** migration de `invoices` + porta `InvoiceProvider` (adapter manual) + telas de NF (emitida/recebida, registro + upload PDF/XML).
- **F4 (opcional):** porta `PaymentGateway` real (Asaas/Mercado Pago) + webhook de baixa; `InvoiceProvider` real (eNotas/NFe.io) homologado.

Cada fase: gates verdes (tsc + vitest + guard de migration + build) e deploy só com OK explícito do Jean.

## Referências

- [RFC-0001](RFC-0001-GRAPH-VIEW-EXECUTIVE_COMMAND_CENTER.md) — Graph View Executivo
- ADR-0001 (Spec-Driven) e ADR-0003 (Cloud-Agnostic / Ports & Adapters) — `project/docs/adr/`
- `project/docs/PORTAL_TENANTS_AND_PLANS.md`, `project/docs/ACTORS_AND_RESPONSIBILITIES.md`, `project/docs/API_CONTRACT.md`
- Reforma de tenant + SES (migrations 051/052) — base de CNPJ/endereço para NF e do fluxo `inactive → active`
