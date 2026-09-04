> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Épico Spec/Bancada — Ondas 4 e 5: decompor no upload + ideia em texto livre; dashboard de KPIs (plano v1, 2026-09-04)

| Campo | Valor |
|---|---|
| Status | **v1 — pesquisa (§2) → desenho (§3, §4) → adversarial do próprio desenho (§5, 14 GAPs fechados) → plano ordenado (§6). Aguarda OK do Jean para execução; nada implementado, nada commitado.** |
| Base | Ondas 1–3 + Pivô do épico em PROD (`e86861b`); RFC-0004 F5 (`dashboard.ts`) e T1.6b (`product_proposals`, migration 076) em PROD; RFC-0005 em `dev`. Última migration: **084** (`084_cloud_slots_partial_unique.sql`, bloco 5, commit `a390e2f` — ocupada em paralelo em 2026-09-04) → próximas **085** (Onda 4) e **086** (Onda 5). **Reconferir `ls MIG/ | tail -1` antes de criar o arquivo** — há mais de uma frente aberta no repo. |
| Fora | **Onda 6 (extrair financeiro) — decisão do Jean 2026-09-03: "NÃO mexer no financeiro atual".** Este plano não toca `finance.ts`, `charges`, `payments`, `plans` nem `/zentriz/finance`; o dashboard admin apenas **lê** contagens já derivadas em `dashboard.ts:117-134`. Também fora: gráficos/série temporal (sem lib de charts no portal), materialização do summary (só se p95 > 300 ms — D5), i18n (portal é PT-BR hard-coded). |
| Regras | Código em inglês, prosa PT-BR; flags **OFF por padrão**; migrations sem `;` em literal e sem `DO/$$`; revalidar ANTES e DEPOIS ([[feedback-revalidar-antes-e-depois]]); adversarial antes de codar ([[feedback-pesquisa-adversarial-antes-de-implementar]]). |

Prefixos: `API` = `applications/services/api-node/src` · `WEB` = `applications/apps/genesis-web` · `ORCH` = `applications/orchestrator` · `MIG` = `API/db/migrations`.

---

## 1. Fatos (código lido em 2026-09-04 — o plano parte daqui, não de memória)

### 1.1 Upload de spec e decomposição (Onda 4)
- **Upload** = `POST /api/specs` multipart (`API/routes/specs.ts:620`). Extensões por allowlist `ALLOWED_EXT = .md .txt .doc .docx .pdf` (`:20`) + `.zip` (`isAllowed`, `:40-43`); validação **por extensão, não por magic bytes**; rejeição 400 em `:780-785`. Plugin multipart `files: 10, fileSize: 10 MiB` (`API/app.ts:73-75`); `bodyLimit` JSON = default 1 MiB. Campos: `title, projectType, productId, intakeMode, draft, freeDescription, delivery*` (`:673-767`). Gates: `validateIntake` (`API/services/intakeGate.ts:131-184`; texto ≥ 500 letras OU ≥ 1 anexo), `SPEC_ATTACHMENT_UNREADABLE` se < 30 letras extraíveis (`specs.ts:877-893`, fail-closed), gate semântico LLM fail-open (`:895-906`). Extratores **privados** do módulo: `.docx` (`:63-82`, OOXML via adm-zip) e `.pdf` best-effort (`:90-107`, regex `Tj/TJ` só em streams não comprimidos); `.doc` não tem extrator. Criação em `createProjectFromSpec` (`API/services/projectCreation.ts:92-95`); `draft=true` mantém `draft` mesmo com `.pdf` (`:245-256`). Resposta `{ projectId, status, message }` (`specs.ts:975-979`).
- **Decompor spec salva** = `POST /api/projects/:id/decompose` (`API/routes/products.ts:484-574`): `SPEC_DECOMPOSABLE_STATUSES = draft|spec_submitted|pending_conversion` (`:62`); **lê só `.md`** (`LOWER(filename) LIKE '%.md'`, `:520-522`) → spec `.pdf/.docx/.txt` responde 422 `NO_SPEC_FILES`; one-flight por origem (índice `pp_one_flight_origin`, 23505 → 202 `reused:true`); marca origem `pending_conversion`; custo debitado no projeto de origem (`usage_project_id`).
- **Ideia em texto livre JÁ EXISTE** (parcial): Bancada `/specs` → botão "Decompor uma ideia" (`WEB/app/(dashboard)/specs/page.tsx:423-430`, oculto para master) → `DecomposeDialog` modo idea (`WEB/components/DecomposeDialog.tsx:252-257`, `MIN_DOC_CHARS = 40`) → `POST /api/products/propose { document, modelId? }` (`products.ts:264-299`; JSON, ≥ 40 chars, `denyCreationForManagement`, tenant obrigatório, **rate-limit inline SQL 4/h por tenant onde `origin_project_id IS NULL`** `:284-290` → 429). Poll `GET /api/products/propose/:jobId` (`:302-343`; tenant binding → 404). Aceite = `POST /api/products/ingest-proposal { proposalId, … }` (`:349-475`; `dispatch:false` = só salva na Bancada; idempotente por `consumed_product_id`). Job persistido em `product_proposals` (076) processado in-process por `runProposeJob` (`API/services/productProposals.ts:107-175`; poll 8 s no agents, teto 18 min, `PROPOSAL_DEADLINE_MIN = 22`), reaper de boot + watchdog step 0f.
- **Custo da proposta**: `ORCH/agents/server.py:525-545` `_run_splitter` chama `call_bedrock_direct(..., usage_project_id=originProjectId, usage_agent="splitter")`; **comentário explícito `:536-538`: proposta de texto avulso "segue invisível até existir linha de projeto"**. `product_proposals` não tem colunas de tokens/modelo efetivo (só `model_id` pedido). `call_bedrock_direct` devolve só a string (`ORCH/agents/runtime.py:1241-1244`); usage vai por `_report_direct_usage` fire-and-forget (`:1201`).
- **Nenhuma rota de proposta chama `checkTenantBudget`** (`rg` em `products.ts`, `productProposals.ts` = 0 ocorrências). O teto mensal (`API/services/tenantCostCap.ts:114`) só protege a fábrica.
- Portal `/spec` (`WEB/app/(dashboard)/spec/page.tsx`, 2481 linhas): `ACCEPT = ".md,.txt,.doc,.docx,.pdf,.zip"` (`:88`); Tab upload: `handleUploadSubmit` (`:1851-1903`) → `apiPostMultipart("/api/specs")` (`:1894`) → `router.push(/projects/:id)` (`:1900`); único botão "Salvar rascunho" (`:2459-2468`); sem checagem de tamanho no cliente; dropzone sem drag&drop real (`:2422-2435`). **Não há "Decompor" no `/spec` nem em `/products`.** `DecomposeDialog` não recebe arquivo e **não exibe custo/tokens/modelo** (contrato `ProposePoll`, `:45-57`); `onSaved()` sem argumentos (`:198-222`).
- Rate limiter genérico existe e não é usado aqui: `API/services/rateLimit.ts:56-90` `createRateLimiter` (memória, fixed-window, `Retry-After`).
- Testes: `products.propose-persist.test.ts` (12), `products.decompose.test.ts`, `products.ingest-origin.test.ts`; padrão = `vi.mock` de `auth.js` + `db/client.js` roteando SQL por substring; app `Fastify()` + `inject`.

### 1.2 Dashboard (Onda 5)
- **Já existe** `GET /api/dashboard/summary?tenantId=` (`API/routes/dashboard.ts:40-137`, registrado em `app.ts:92`): UMA query com LATERAIS por projeto (tasks done/total + tarefa atual, custo `SUM(priceCaseSql)` de `project_agent_metrics`, run aberta, agente atual gateado por `status='running'`, 3 mensagens importantes via `severity` 075), `WHERE p.status <> 'archived'`, `LIMIT 100`; bloco `admin` (tenants: `new_30d`, `awaiting_payment` = `inactive` COM `charges` aberta, `inactive_manual`, `suspended`, `active`). **Sem teste.** **Bug latente `:76`: filtra `pt2.status IN ('IN_PROGRESS','IN_REVIEW')` — `IN_REVIEW` não existe no CHECK de `project_tasks` (`MIG/001:94` = `WAITING_REVIEW`)** → "tarefa atual" nunca mostra tarefa em revisão.
- Home autenticada = `WEB/app/(dashboard)/dashboard/page.tsx` (446 l.): `StatCard` **local, não exportado** (`:191-213`); 4 cards Total/Em execução/Concluídos/Com falha **contados no cliente** sobre `GET /api/projects` inteiro (`:246-251`, `:320-341`); `<DashboardLiveOps/>` (`:294`) consome o summary a cada 30 s (`WEB/components/DashboardLiveOps.tsx:51-59`) **sem passar `tenantScopeStore.effectiveTenantId`** → master com tenant selecionado vê global.
- Custo: fonte única `project_agent_metrics` (003; **sem `tenant_id`, sem índice em `created_at` isolado**); preços em `API/lib/modelPricing.ts` (`priceCaseSql`); `pipeline_cost_ledger` **já dropada** (073 — D4 feito); mês do tenant `getTenantMonthSpendUsd` + orçamento `resolveTenantMonthlyBudgetUsd` (`tenantCostCap.ts:44-60`, `:82-101`). Tempo: `pipeline_runs.started_at/finished_at/duration_sec` (012), `projects.started_at/finished_at/total_duration_sec`. Valor: `value_events` (068; `project_delivered`…) + `GET /api/reports/value` (`reports.ts:85-110`, `costPerDelivery`).
- Tenants: `status CHECK (active|suspended|inactive)` (001:22) + `email_confirmed` (052:11) + `monthly_llm_budget_usd` (068). **Não existe conceito "bloqueado"/"pendente de desbloqueio" no schema** — só derivações. Aprovações Deadpool pendentes: `deadpool_promotion_approvals.decision='pending'` (047).
- Cache: **sem Redis na API**; padrão de cache em memória com TTL + `pg_notify` em `API/services/tenantStatusCache.ts:28-69`. `projects.status` sem índice; `(tenant_id)` sim.
- Portal: MUI 7 Grid v2 (`size={{xs,md}}`), framer-motion, sem lib de gráficos, sem vitest (só `next lint` + `npx tsc --noEmit`); `authStore.isZentrizAdmin/isTenantAdmin` (`WEB/stores/authStore.ts:31-37`); `tenantScopeStore.effectiveTenantId` (`:38`); `apiGet/withQuery` (`WEB/lib/api.ts:39-48`).

---

## 2. Pesquisa — estado da arte (2026-09-04) e o que muda no desenho

Fontes consultadas (WebFetch): DORA — *Four Keys* + 5ª métrica *rework rate* (dora.dev/guides/dora-metrics-four-keys); FinOps Foundation — *FinOps for AI* (cost per inference/token, unit economics, showback, budget vs actual, anomalias); DX Core 4 (getdx.com — "focused set of metrics", 4 dimensões, não se perder nos dados); NN/g — *Dashboards: preattentive attributes* (posição/comprimento > área/ângulo, sem gauges/3D, "at-a-glance", só o essencial) e *Progress indicators* (percent-done acima de 10 s, texto do que está acontecendo, cancelar, tolerância 3× maior); OWASP *File Upload Cheat Sheet* (allowlist + magic bytes, nome aleatório, limite pós-descompressão, fora do webroot, rate limit); Langfuse *Analytics* (custo/latência por usuário-sessão-modelo-feature, p50/p95); Anthropic *Token counting* (estimativa livre de custo antes da chamada; Claude ≥ 4.7/Fable tokenizador ~30 % maior — não reaproveitar contagens entre modelos); GitHub Copilot coding agent (ideia → plano → PR em rascunho, 1 tarefa = 1 PR, limite duro de tempo, revisão humana obrigatória); Linear *Initiatives* (Proposed → Planned → Active; saúde on/at-risk/off-track; rollup) e Jira Product Discovery (ideias → impact/effort → épico de entrega). SPACE (ACM Queue) não carregou (403) — usado por conhecimento prévio apenas como aviso "nunca uma métrica só de atividade".

| Lição | Aplicação neste plano |
|---|---|
| DORA: poucas métricas de fluxo (frequência, lead time, taxa de falha, recuperação) | KPIs da fábrica = **entregues 30 d**, **lead time mediano**, **taxa de falha 30 d**, **bloqueados agora**; nada de "linhas de código"/"tokens por dia" como métrica de topo |
| FinOps for AI: unit economics + budget vs actual + showback por dimensão | **Custo MTD × orçamento** (barra), **custo por entrega** (MTD ÷ aceitos), custo por modelo (top 3) só como detalhe; admin: top tenants por custo (showback, sem cobrar) |
| DX Core 4 / NN/g: 6–8 números, hierarquia visual, comparação com período anterior, sem gauges | Grid de **8 cards** tenant e **+6** admin; delta "vs 30 d anteriores" só onde a fonte permite (contagens); barras lineares (MUI `LinearProgress`), zero donut/gauge |
| NN/g progress: > 10 s → percent/tempo estimado + texto do passo + cancelar | `DecomposeDialog`: fase visível ("lendo o documento… / desenhando o produto… / gerando spec 3 de 7"), tempo decorrido e **estimado** (mediana histórica das propostas `done` do tenant), botão **Cancelar** que interrompe o job (não só fecha) |
| Anthropic token counting: estimativa antes de gastar; tokenizador difere por modelo | Estimativa **local determinística** (chars/3,6 ± 30 %) exibida antes de "Decompor" — sem chamada extra; custo REAL após o job vem do usage do agents |
| OWASP upload: allowlist já existe; faltam magic bytes, limite pós-descompressão e nome aleatório | v1: checar assinatura para `.pdf` (`%PDF-`), `.docx/.zip` (`PK\x03\x04`) e rejeitar disfarces; ZIP: cap de bytes descomprimidos (já há `extractZip`, adicionar teto explícito); nomes já são sanitizados (T1.3) |
| Copilot/Linear/JPD: ideia é um **estado** (Proposed), nunca se perde; 1 ideia → 1 proposta; revisão humana antes de virar trabalho | Ideia crua vira **linha visível na Bancada** ("Propostas: em análise / pronta para revisão / interrompida") em vez de existir só enquanto o diálogo está aberto; ingest continua exigindo revisão humana (`needsHuman`) |
| Langfuse: agrupar custo por feature | `product_proposals` passa a guardar `input_tokens/output_tokens/model_used/source` → custo da **feature "split"** aparece no dashboard e no diálogo |

---

## 3. Desenho — Onda 4: decompor no upload + ideia em texto livre

Princípio: **reaproveitar o job persistido e o fluxo existente**; a Onda 4 é majoritariamente orquestração de UI + 3 fechamentos de backend (leitura de não-`.md`, custo/orçamento da proposta, visibilidade da proposta). Nenhum endpoint novo de decomposição por upload: **upload → rascunho (já existe) → decompose (já existe)** encadeados no cliente.

### 3.1 Fluxo 4(a) — "Decompor em produto" no upload (`/spec`, aba Upload)

1. Switch **"Decompor em produto após salvar"** (default OFF, lembrado em `localStorage.genesis.spec.decomposeOnUpload`). Sob o switch: estimativa "≈ N mil tokens · ≈ US$ X–Y (modelo padrão do tenant)" calculada no cliente (`bytes/3,6`, faixa ±30 %), e aviso "a spec fica salva como rascunho; a decomposição gera N specs para sua revisão".
2. Submit: `POST /api/specs` com `draft=true` (como hoje) → `projectId`. Em seguida o cliente **abre `DecomposeDialog` com `spec={id,title}`** (o diálogo já dispara `POST /api/projects/:id/decompose` em `startFlow`, `:155-157`) em vez de `router.push(/projects/:id)`.
3. Backend `decompose` passa a montar o documento a partir de **todos** os `project_spec_files`, usando extrator compartilhado: `.md/.txt/.yaml` texto puro; `.docx` → `extractDocxText`; `.pdf` → `extractPdfTextBestEffort`; `.doc` → ignorado com warning na proposta. Módulo novo `API/services/specTextExtract.ts` exportando o que hoje é privado em `specs.ts:63-139` (`specs.ts` passa a importar dali — zero mudança de comportamento no upload). Se o texto legível < 40 chars → 422 `SPEC_TOO_SHORT` com mensagem específica "PDF sem texto selecionável — envie .md/.docx ou cole o texto".
4. `DecomposeDialog` em revisão → "Salvar na Bancada" → `ingest-proposal` (como hoje; origem é consumida → `archived`). `onSaved({ productId })` → `router.push(/products/:productId)` (hoje `onSaved()` não devolve nada — estender). Fechar sem salvar → `router.push(/projects/:id)`; a spec continua rascunho no INBOX e o botão "Decompor" da Bancada (`specs/page.tsx:358-363`) cobre a retomada.
5. Erros mapeados na UI: 400 formato · 422 `SPEC_INTAKE_INCOMPLETE`/`SPEC_ATTACHMENT_UNREADABLE`/`SPEC_TOO_SHORT` · 409 `ALREADY_IN_PRODUCT`/`NOT_A_SPEC` · 429 `RATE_LIMITED`/`BUDGET_EXCEEDED` (novo) · 503 agents · `interrupted` (reinício) com "Refazer".

### 3.2 Fluxo 4(b) — ideia em texto livre (o que falta)

Já existe: botão na Bancada + diálogo + `propose` + rate-limit 4/h. Faltas e fechamentos:

| Falta | Fechamento |
|---|---|
| Custo invisível (`usage_project_id=None`) e ausente do teto mensal | **Agents**: `_run_splitter` acumula usage das N chamadas (contextvar `usage_sink` em `runtime.py`, preenchido onde já lê `response.usage`, `:1105`) e devolve `result.usage = {input_tokens, output_tokens, model_used}`. **API** `finishProposal` grava em `product_proposals` (colunas novas, migration 085). `GET /propose/:jobId` ecoa `usage` + `costUsd` (via `costUsd()` de `modelPricing.ts` — fonte única). No `ingest-proposal` de proposta **sem origem**, insere 1 linha em `project_agent_metrics` (`agent='splitter'`, `task_id='proposal:<id>'`) no primeiro projeto criado → entra no mês do tenant. Com origem, nada muda (já debitado ao vivo). |
| Sem gate de orçamento | `propose` e `decompose` chamam `checkTenantBudget(pool, tenantId)` antes do INSERT → 429 `BUDGET_EXCEEDED` com `budgetExceededMessage` (mesma família de erro da fábrica). |
| Rate-limit só por tenant, contagem em SQL | Manter o SQL (fonte de verdade, sobrevive a restart) **e** adicionar `createRateLimiter({ windowMs: 60_000, max: 6, keyFn: user.id })` como preHandler anti-rajada por usuário (o helper já existe). Parametrizar `IDEA_PROPOSALS_PER_HOUR` (default 4). |
| Ideia só vive enquanto o diálogo está aberto | Bancada ganha seção **"Propostas de produto"** (lista `GET /api/products/proposals?status=running|done|error&limit=20` — rota nova, tenant-scoped, master via `?tenantId`): em análise (com tempo decorrido), **pronta para revisão** (reabre o `DecomposeDialog` em fase `review` com `jobId`), interrompida/erro ("Refazer"). Prop nova `resumeJobId` no diálogo. |
| Não se sabe o que a IA está fazendo por até 18 min | `DecomposeDialog`: fase textual + decorrido + **estimado** (mediana de `updated_at - created_at` das últimas 20 propostas `done` do tenant, devolvida pelo `GET` de listagem como `etaSeconds`) + **Cancelar** → `POST /api/products/propose/:jobId/cancel` (marca `interrupted`, reverte origem via `revertTerminatedOrigins`; a thread do agents termina sozinha — custo já incorrido é registrado se o usage chegar). |
| Tamanho da ideia sem teto | `document` ≤ 200 000 chars (≈ 55 k tokens; 413 `DOCUMENT_TOO_LARGE`); `bodyLimit: 1 MiB` explícito na rota. |
| Upload sem magic bytes | `specTextExtract.ts` ganha `sniffKind(buffer)`: `.pdf` exige `%PDF-`; `.docx`/`.zip` exigem `PK\x03\x04`; divergência → 400 `FILE_SIGNATURE_MISMATCH`. `.md/.txt`: rejeitar se > 5 % de bytes NUL/controle (binário disfarçado). |

### 3.3 Modelo de dados — migration **085** `085_product_proposals_usage_source.sql`

```sql
-- 085 — Onda 4: custo/telemetria e origem da proposta (RFC-0004 T1.6b + Onda 4 do epico Spec/Bancada).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'idea';
UPDATE product_proposals SET source = 'spec' WHERE origin_project_id IS NOT NULL AND source = 'idea';
ALTER TABLE product_proposals DROP CONSTRAINT IF EXISTS pp_source_check;
ALTER TABLE product_proposals ADD CONSTRAINT pp_source_check CHECK (source IN ('idea', 'spec', 'upload'));
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS model_used TEXT;
ALTER TABLE product_proposals ADD COLUMN IF NOT EXISTS cancelled_by UUID;
CREATE INDEX IF NOT EXISTS pp_review_pending ON product_proposals (tenant_id, updated_at DESC)
  WHERE status = 'done' AND consumed_at IS NULL;
```
`source='upload'` é gravado pelo `decompose` quando o body traz `{ source: "upload" }` (cliente do `/spec` envia; default `spec`). Custo **não** é coluna — derivado por `costUsd(model_used, …)` (F6: preço em um só lugar).

### 3.4 API (Onda 4) — resumo

```
POST /api/projects/:id/decompose         body { modelId?, source?: 'spec'|'upload' }   (extrator multi-formato; budget gate)
POST /api/products/propose               body { document, modelId? }                    (budget gate; teto 200k; rate-limit user)
GET  /api/products/propose/:jobId        + usage {input_tokens, output_tokens, model_used}, costUsd, source, etaSeconds?
POST /api/products/propose/:jobId/cancel → 200 { status:'interrupted' } | 409 se terminal      (novo; tenant binding 404)
GET  /api/products/proposals?status=&limit= → { items[], etaSeconds }                            (novo; tenant-scoped)
```
Flags: `SPEC_UPLOAD_DECOMPOSE=off` (esconde o switch no `/spec` via `GET /api/features` **se** existir; senão env pública `NEXT_PUBLIC_SPEC_UPLOAD_DECOMPOSE` lida no build — decisão D-4.3), `PROPOSAL_BUDGET_GATE=off` (gate de orçamento nas propostas; ligar após provar em dev), `PROPOSAL_MAX_CHARS=200000`, `IDEA_PROPOSALS_PER_HOUR=4`.

---

## 4. Desenho — Onda 5: dashboard de KPIs (tenant + admin)

### 4.1 Decisão de arquitetura
- **Não** quebrar `GET /api/dashboard/summary` (consumido por `DashboardLiveOps`). Adicionar no mesmo arquivo **`GET /api/dashboard/kpis?scope=tenant|admin&tenantId=`** (agregados, sem lista por projeto). Query-on-read (D5) + **cache em memória 15 s por chave** (`lib/ttlCache.ts`, molde de `tenantStatusCache.ts`) + headers `X-Cache: HIT|MISS` e `X-Elapsed-Ms` para medir p95 em prod (gatilho da materialização = p95 > 300 ms, D5).
- **RBAC fail-closed**: `scope=tenant` → `resolveScopedTenantId`; não-admin sem tenant → 200 com `{ enabled, tenant: null }`; `scope=admin` → só `zentriz_admin`, senão **403** (não 404: a rota é conhecida); `svc:"runner"` → 403. Nenhuma query do escopo tenant sem `p.tenant_id = $1`.
- Flag `DASHBOARD_KPIS=off` → rota responde `{ enabled: false }` e o portal mantém os 4 cards atuais.

### 4.2 KPIs mínimos — escopo **tenant** (8 cards + faixa de custo + mensagens)

| # | Card | Fonte (SQL sobre tabelas existentes; sempre `p.tenant_id = $1`) | Observação |
|---|---|---|---|
| T1 | **Na Bancada** | `count(*) FILTER (WHERE p.status IN ('draft','spec_submitted','pending_conversion','spec_validation_failed','needs_spec_input'))` | link `/specs` |
| T2 | **Na fábrica agora** | `status IN ('queued','running','cto_charter','pm_backlog','dev_qa','devops','pending_cyborg')` | link `/projects?status=running` |
| T3 | **Bloqueados / atenção** | `status LIKE 'blocked_%' OR status IN ('failed','stopped')` | cor `error` se > 0 |
| T4 | **Entregues 30 d** (freq. de entrega) | `status IN ('accepted','completed') AND COALESCE(p.finished_at, p.completed_at, p.updated_at) > now() - interval '30 days'` + mesmo cálculo para 30–60 d → delta | DORA deployment frequency |
| T5 | **Lead time mediano 30 d** | `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.finished_at - p.started_at)))` nos mesmos aceitos com ambos os timestamps | DORA lead time; "—" se < 3 amostras |
| T6 | **Taxa de falha 30 d** | `failed_30d / NULLIF(accepted_30d + failed_30d, 0)` (`status='failed'` com `updated_at` em 30 d) | DORA CFR análogo |
| T7 | **Tarefas (ativos)** | `SUM(done) / SUM(total)` de `project_tasks` dos projetos T2, excluindo `TSK-DEVOPS-001`, `TSK-FULL-TEST`, `TSK-INH-%` (regra de `projects.ts:113-119`) | barra linear |
| T8 | **Propostas de produto** | `product_proposals`: `running` / `done AND consumed_at IS NULL` (pronta p/ revisão) | link Bancada §3.2 |
| C | **Custo do mês × orçamento** | `getTenantMonthSpendUsd` + `resolveTenantMonthlyBudgetUsd` (reuso); **custo por entrega** = MTD ÷ `accepted_mtd` (`NULLIF`); top 3 modelos MTD: `SUM(priceCaseSql) … GROUP BY m.model ORDER BY 2 DESC LIMIT 3` com `JOIN projects` | FinOps budget vs actual + unit economics; sem orçamento → só o valor |
| M | **Mensagens importantes (tenant)** | `project_dialogue d JOIN projects p … WHERE severity IN ('notice','warning','critical') ORDER BY d.created_at DESC LIMIT 5` (índice `idx_project_dialogue_important` 075) | com título do projeto |

Tudo em **uma** query de contagens (`FILTER`) + 1 query de custo por modelo + 1 de mensagens + reuso de 2 funções → ≤ 5 round-trips, sem N+1.

### 4.3 KPIs — escopo **admin** (faixa gerencial; só leitura, sem tocar financeiro)

| # | Card | Fonte |
|---|---|---|
| A1 | Tenants ativos / novos 30 d | bloco atual de `dashboard.ts:117-134` (reuso literal) |
| A2 | **Pendentes de desbloqueio** | `inactive` COM `charges` aberta (= `awaiting_payment`, já derivado) **+** `email_confirmed = false` (cadastro não confirmado) — dois números, rótulos separados |
| A3 | **Bloqueados** | `suspended` (tenants) + projetos `blocked_%` de todos os tenants |
| A4 | Fábrica global | `running`/`queued` de todos os tenants + propostas em voo |
| A5 | Custo MTD da plataforma + **top 5 tenants por custo** | `project_agent_metrics m JOIN projects p … WHERE m.created_at >= date_trunc('month', now()) GROUP BY p.tenant_id` (showback) |
| A6 | Pendências operacionais | `deadpool_promotion_approvals.decision='pending'`; `product_proposals` `interrupted|error` 24 h; `spec_validation_runs` `error|interrupted` 24 h |

> Assunção explícita: "pendentes de desbloqueio" e "bloqueados" **não existem como estado de tenant** no schema; o plano mapeia para as derivações acima e **não cria coluna nova** (criar exigiria decisão de produto — D-5.2).

### 4.4 Portal
- `WEB/components/KpiCard.tsx` (novo): extrai o `StatCard` de `dashboard/page.tsx:191-213`, exporta e adiciona `hint`, `delta` (↑↓ vs período anterior, cor neutra), `progress` (0–1 → `LinearProgress`), `loading` (`Skeleton`), `href` (clique navega), `tone` (`default|warning|error`). Grid `size={{ xs: 6, sm: 4, md: 3 }}`; em `xs` valores `h5`, rótulo 1 linha `noWrap`.
- `WEB/components/DashboardKpis.tsx` (novo): 1 `apiGet(withQuery("/api/dashboard/kpis", { scope, tenantId }))`, refresh 30 s alinhado ao `DashboardLiveOps`, erro silencioso com "atualizado há Xs"; faixa de custo (`LinearProgress` + "US$ a de b · US$ c por entrega"); lista compacta de mensagens; bloco admin (`scope=admin`) só se `authStore.isZentrizAdmin`.
- `dashboard/page.tsx`: quando `kpis.enabled`, **substitui** os 4 cards cliente-side (`:320-341`) pelos server-side e para de carregar `GET /api/products` só para contar; senão mantém tudo como hoje.
- `DashboardLiveOps.tsx:52`: passar `tenantScopeStore.effectiveTenantId` (`withQuery`) — correção independente da flag.
- Acessibilidade/mobile: cor nunca é o único sinal (ícone + texto), contraste AA, sem gauges; `prefers-reduced-motion` desliga o `framer-motion` do card.

### 4.5 Migration **086** `086_dashboard_kpis_indexes.sql`
```sql
-- 086 — Onda 5: indices para agregacoes do dashboard (query-on-read, D5). Sem ';' em literais, sem DO/$$.
CREATE INDEX IF NOT EXISTS idx_agent_metrics_created ON project_agent_metrics (created_at);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_status ON projects (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_finished ON projects (tenant_id, finished_at)
  WHERE finished_at IS NOT NULL;
```
Sem `CONCURRENTLY` (o runner roda em transação no boot; tabelas são pequenas — 23 projetos em prod; medir tempo do boot no PÓS).

---

## 5. Adversarial do próprio desenho (2026-09-04) — GAPs e fechamentos

| # | Achado | Fechamento na v1 |
|---|---|---|
| G1 (P1) | **RBAC cross-tenant no `kpis`**: `scope=admin` acessível por `tenant_admin`; `?tenantId` honrado para não-admin | `scope=admin` → 403 salvo `zentriz_admin`; `tenantId` **sempre** via `resolveScopedTenantId` (ignora query para não-admin); teste negativo obrigatório (tenant A pede tenant B → só A); listagem de propostas com `tenant_id = $1` fail-closed e 404 (não 403) no `cancel` de outro tenant |
| G2 (P1) | **Orçamento contornável**: proposta em modo ideia nunca passou por `checkTenantBudget`; 4/h × ~US$ 0,13–0,50 por proposta é pequeno hoje, mas Fable 10/50 e specs de 200 k chars mudam a escala | gate `PROPOSAL_BUDGET_GATE` no `propose` e no `decompose` + custo da proposta idea gravado em `project_agent_metrics` no ingest (entra no MTD); teto `PROPOSAL_MAX_CHARS` |
| G3 (P1) | **Cache em memória vaza escopo**: chave sem tenant devolveria KPIs de outro tenant | chave = `kpis:<scope>:<tenantId|global>`; nunca cachear resposta de erro; TTL 15 s; `MAX_KEYS` 2 000 com evicção LRU simples (mesma defesa do `rateLimit.ts`); admin `global` só existe para `zentriz_admin` |
| G4 (P1) | **Fábrica double-count**: gravar usage da proposta em `project_agent_metrics` quando a origem já reportou ao vivo | só quando `origin_project_id IS NULL`; `task_id='proposal:<id>'` + guarda `NOT EXISTS` da mesma `task_id` (idempotente no re-ingest, que já é 200 idempotente) |
| G5 (P2) | **Custo de query**: `percentile_cont` e `FILTER` por tenant sem índice em `status`/`finished_at`; admin top-5 varre `project_agent_metrics` inteira | migration 086 (3 índices); janela MTD/30 d sempre no `WHERE`; cache 15 s; `X-Elapsed-Ms` medido em prod — se p95 > 300 ms, materializar (D5) |
| G6 (P2) | **N+1 disfarçado**: `DashboardKpis` + `DashboardLiveOps` + `projectsStore.loadProjects` + `GET /api/products` na mesma home a cada 30 s | com flag ON a home deixa de buscar `/api/products` para contar; `loadProjects` continua (lista de produtos precisa); 2 chamadas de dashboard com o mesmo período → aceitável; v2: `summary` e `kpis` num só payload |
| G7 (P2) | **Dados inconsistentes**: `IN_REVIEW` não existe (bug real em `dashboard.ts:76`); `finished_at` nem sempre é preenchido (só no `stop` do run — `projects.ts:2780-2787`); `completed_at` legado | corrigir para `WAITING_REVIEW`; T4/T5 usam `COALESCE(finished_at, completed_at, updated_at)` e T5 exige `started_at` e `finished_at` não nulos, "—" com < 3 amostras (sem inventar lead time) |
| G8 (P2) | **Extrator PDF best-effort**: streams comprimidos (`FlateDecode`) → 0 letras → falso "spec vazia"; `.doc` sem extrator | mensagem específica no 422; `.doc` vira warning na proposta ("arquivo ignorado"); **não** adicionar `pdf-parse` nesta onda (lockfile da api fora de sincronia — memória Wave A); decisão D-4.2 |
| G9 (P2) | **Upload malicioso**: allowlist só por extensão; ZIP sem teto pós-descompressão; multipart 10 × 10 MiB por request sem rate | `sniffKind` (magic bytes); teto 20 MiB descomprimidos no `extractZip` (409 `ZIP_TOO_LARGE`); `createRateLimiter` 10 uploads/min por usuário no `POST /api/specs`; arquivos continuam fora do webroot (`UPLOAD_DIR`) |
| G10 (P2) | **Estado da proposta órfão na UI**: usuário fecha o diálogo, job continua 18 min, resultado "pronto" nunca é visto; ou clica 2× em "Decompor" | seção "Propostas de produto" na Bancada (§3.2) + `resumeJobId`; one-flight por origem já cobre o duplo clique em spec; para ideia, rate-limit por usuário anti-rajada |
| G11 (P2) | **Cancelar não para o LLM**: agents roda em thread; API só marca `interrupted` | aceito e **documentado na UI** ("o processamento em curso será descartado; o custo já consumido é registrado"); v2: agents ganha `POST /invoke/product_architect/cancel/:id` com `threading.Event` |
| G12 (P3) | **Mobile/i18n**: 8 cards em `xs` viram coluna longa; PT-BR com acentos em `label` já é o padrão; `Intl.NumberFormat("pt-BR")` para US$/tempo | `xs: 6` (2 por linha), rótulos curtos, `hint` só ≥ `sm`; formatador único `WEB/lib/format.ts` (`fmtUsd`, `fmtDuration`) reusado por `DashboardLiveOps` |
| G13 (P3) | **Flag no portal**: `NEXT_PUBLIC_*` é congelada no build (mesma imagem serve dev e prod) | flag de UI **derivada da resposta da API** (`enabled:false`), nunca de env pública — vale para `DASHBOARD_KPIS` e para o switch de upload (`GET /api/dashboard/kpis` e `GET /api/products/proposals` devolvem `features`) |
| G14 (P3) | **Estimativa de tokens enganosa** (tokenizador Fable ~30 % maior; chars/3,6 é heurística) | rótulo "≈" + faixa (±30 %) + texto "estimativa; o custo real aparece ao fim"; custo real vem do usage |

---

## 6. Plano de execução (ordem = menor risco / maior valor; 1 PR por linha; adversarial ANTES e DEPOIS de cada)

### PR-0 — correções independentes de flag (api + web, deploy junto com o próximo)
- `API/routes/dashboard.ts:76` `'IN_REVIEW'` → `'WAITING_REVIEW'`; **criar `dashboard.test.ts`** (padrão `dialogue.test.ts`: tenant vê só o seu; admin global; `?tenantId` ignorado para não-admin; runner 403).
- `WEB/components/DashboardLiveOps.tsx:52`: `apiGet(withQuery("/api/dashboard/summary", { tenantId: tenantScopeStore.effectiveTenantId }))`.
- **PÓS**: tarefa em `WAITING_REVIEW` aparece como "tarefa atual" no card; master com tenant selecionado vê só aquele tenant.

### PR-1 — Onda 4 backend: extrator compartilhado + decompose multi-formato + guardas
- Novo `API/services/specTextExtract.ts` (mover `extractDocxText`, `extractPdfTextBestEffort`, `buildGateContent`, `extractZip` de `specs.ts:63-219`; `specs.ts` importa). `sniffKind()` + teto de descompressão.
- `API/routes/products.ts:520-522`: SELECT sem filtro `.md`; montar documento via extrator (`.md/.txt/.yaml` puro, `.docx/.pdf` extraídos, `.doc` → warning). Body `{ modelId?, source? }`; gravar `source`.
- `products.ts:264-299` e `:484-574`: `checkTenantBudget` (flag `PROPOSAL_BUDGET_GATE`), `PROPOSAL_MAX_CHARS`, `IDEA_PROPOSALS_PER_HOUR`, preHandler `createRateLimiter` por usuário; `bodyLimit` explícito 1 MiB no `propose`.
- `POST /api/specs`: `sniffKind` antes de `part.toBuffer()` (`specs.ts:786`); rate-limit 10/min por usuário.
- Migration **085**. Testes: `products.decompose.test.ts` (+ `.docx` extraído, `.pdf` sem texto → 422 específico, `source='upload'`), `products.propose-persist.test.ts` (+ budget 429, teto 413, rate por usuário), `specTextExtract.test.ts` (fixtures: docx mínimo, pdf sem compressão, pdf `%PDF-` falso, zip bomb pequena), `migrations.test.ts` verde.
- **PÓS (dev)**: spec `.docx` no INBOX → "Decompor" → proposta `done` com N projetos; PDF só-imagem → 422 legível; propose com tenant `monthly_llm_budget_usd = 0,01` e flag ON → 429.

### PR-2 — Onda 4 usage/custo da proposta (agents + api)
- `ORCH/agents/runtime.py`: contextvar `_usage_sink` acumulado onde já se lê `response.usage` (`:1105` e ramo Foundry); `ORCH/agents/server.py:525-545` `_run_splitter` instala o sink e anexa `result["usage"]`. Teste Python (fake client) em `tests/python`.
- `API/services/productProposals.ts:67-101` `finishProposal` grava `input_tokens/output_tokens/model_used`; `GET /propose/:jobId` ecoa `usage` + `costUsd` + `source`; `ingest-proposal` (`products.ts:423-450`) insere `project_agent_metrics` para proposta sem origem (guarda `NOT EXISTS`).
- **PÓS (dev)**: ideia → `done` → `costUsd > 0` no poll; ingest → linha `agent='splitter'` no primeiro projeto; `GET /api/projects/:id/cost` do tenant sobe pelo mesmo valor; re-ingest não duplica.

### PR-3 — Onda 4 rotas de visibilidade/cancelamento
- `products.ts`: `GET /api/products/proposals` (tenant-scoped, `etaSeconds` = mediana das últimas 20 `done`), `POST /api/products/propose/:jobId/cancel` (→ `interruptProposal` + `cancelled_by`; 404 tenant binding; 409 terminal). Testes de rota (binding, estados).
- **PÓS**: cancelar em `running` → `interrupted` em < 1 s e origem volta a `spec_submitted`; lista mostra a proposta `done` não consumida.

### PR-4 — Onda 4 portal
- `DecomposeDialog.tsx`: props `resumeJobId?`, `source?`, `onSaved(result: { productId })`; fases textuais + decorrido/estimado + Cancelar; bloco "Custo desta proposta" (`usage`, `costUsd`, modelo) na revisão; estimativa local antes de iniciar (modo idea/upload).
- `spec/page.tsx`: switch "Decompor em produto após salvar" (visível só se `features.specUploadDecompose`), estimativa, `handleUploadSubmit` → abre diálogo em vez de `router.push` (`:1900`); mapa de erros.
- `specs/page.tsx`: seção "Propostas de produto" (consome `GET /api/products/proposals`), reabertura por `resumeJobId`; chip "proposta pronta" no card da spec de origem.
- Validação: `npx tsc --noEmit`, `next lint`, `next build` (sem warnings novos); revisão manual dos 4 pontos de montagem do diálogo (2 hoje: `:568-580`).
- **PÓS (dev, ao vivo)**: upload `.docx` com switch ON → diálogo abre → revisão com custo → salvar → `/products/:id` com N specs; fechar sem salvar → spec no INBOX com "Decompor" disponível; reabrir proposta pronta pela Bancada.

### PR-5 — Onda 5 backend
- `API/lib/ttlCache.ts` (novo, molde `tenantStatusCache.ts`); `API/routes/dashboard.ts` `GET /api/dashboard/kpis` (§4.1–4.3; flag `DASHBOARD_KPIS`); `features` no payload; migration **086**.
- Testes `dashboard.kpis.test.ts`: RBAC (G1), cache por chave (G3), SQL contém `tenant_id = $1` em toda query de escopo tenant (grep-guard, como `projectAccess.test.ts`), `enabled:false` com flag OFF, "—" com < 3 amostras de lead time.
- **PÓS (dev)**: `X-Elapsed-Ms` do primeiro hit e `X-Cache: HIT` no segundo; valores conferidos contra SQL manual em 1 tenant (T1–T8, C); admin com `?tenantId` → escopo; tenant pedindo `scope=admin` → 403.

### PR-6 — Onda 5 portal
- `KpiCard.tsx`, `DashboardKpis.tsx`, `lib/format.ts`; `dashboard/page.tsx` troca os cards (`:320-341`) quando `enabled`; `StatCard` local removido em favor do exportado.
- **PÓS**: `next build` ok; mobile (375 px) 2 cards por linha sem overflow; contraste AA; admin vê faixa A1–A6 e tenant não vê; refresh 30 s sem flicker (`Skeleton` só no 1º load).

### Deploy (após OK do Jean; fluxo canônico ECR do CLAUDE.md, api PRIMEIRO)
- Janela 1: PR-0 + PR-1 + PR-2 + PR-3 (api + agents) — `.env` prod **sem** ligar `PROPOSAL_BUDGET_GATE`/`SPEC_UPLOAD_DECOMPOSE`; migration 085 no boot (a 084 do bloco 5 vai na mesma janela ou já estará aplicada — conferir `schema_migrations` no PRÉ); smoke `GET /api/products/proposals` → 401 sem token. Rollback tags `rollback-<svc>:pre-onda4`.
- Janela 2: PR-4 (web). Janela 3: PR-5 + PR-6 (api + web), `DASHBOARD_KPIS=off` → medir p95 em prod com flag ON só para o tenant Zentriz (via `?tenantId` do master) antes de ligar geral.
- Persistir memória por janela (LEI 0): commits, digests, rollbacks, GOTCHAs.

### Estimativa de esforço
PR-0 0,5 d · PR-1 1,5 d · PR-2 1 d · PR-3 0,5 d · PR-4 1,5 d · PR-5 1 d · PR-6 1 d → **~7 dias** de execução autônoma com adversarial por PR.

---

## 7. Decisões abertas (com recomendação)

- **D-4.1** Ideia crua deve virar **projeto-origem** (rascunho "Ideia — …" no INBOX, unificando custo/one-flight/arquivamento com o fluxo de spec)? **Recomendação: não na v1** — polui o INBOX com ideias abandonadas e muda semântica; a seção "Propostas de produto" resolve a visibilidade sem criar projeto.
- **D-4.2** Adicionar `pdf-parse` para PDFs comprimidos? **Recomendação: não agora** (lockfile da api fora de sincronia; dependência nativa zero hoje). Tarefa própria: regenerar lock + `npm ci` + `pdf-parse`.
- **D-4.3** Flags de UI: **sempre derivadas da API** (`features` no payload), nunca `NEXT_PUBLIC_*` (G13). Recomendado.
- **D-5.1** Endpoint novo `/kpis` × estender `/summary`? **Recomendação: novo** (cache/TTL e RBAC distintos; `summary` continua estável para o `DashboardLiveOps`).
- **D-5.2** Criar estado de tenant "bloqueado/pendente de desbloqueio"? **Recomendação: não** — usar derivações (§4.3) e registrar a necessidade como RFC se o Jean quiser um estado real (tocaria `tenants.status` CHECK e o financeiro, que está congelado).
- **D-5.3** Materializar KPIs? **Só se p95 medido > 300 ms** (D5 do RFC-0004) — o header `X-Elapsed-Ms` existe para isso.

---

## 8. Resumo (≤ 25 linhas)

1. Onda 4 **não** cria um novo motor: upload → rascunho (`POST /api/specs`, já existe) → `decompose` (já existe) encadeados no cliente; a Bancada já tem "Decompor uma ideia" + `propose` persistido (076).
2. Fechamentos de backend Onda 4: `decompose` lê `.docx/.pdf/.txt` (hoje só `.md`, `products.ts:520-522`) via `specTextExtract.ts` compartilhado; **gate de orçamento** em `propose`/`decompose` (hoje inexistente — G2); teto 200 k chars; rate-limit por usuário além do 4/h por tenant; magic bytes no upload; teto de descompressão de ZIP.
3. Custo da proposta em modo ideia deixa de ser invisível: agents devolve `usage`; api grava (migration **085**: `source`, `input/output_tokens`, `model_used`, `cancelled_by`, índice `pp_review_pending`) e exibe `costUsd` no diálogo; no ingest sem origem, entra em `project_agent_metrics` (sem double-count — G4).
4. Visibilidade/controle: `GET /api/products/proposals`, `POST /api/products/propose/:jobId/cancel`; Bancada mostra propostas em análise/prontas/interrompidas; diálogo com fases, decorrido/estimado e Cancelar (NN/g).
5. UX do `/spec`: switch "Decompor em produto após salvar" (flag via API), estimativa "≈ tokens/US$" antes, custo real depois; erros 400/409/413/422/429/503 mapeados.
6. Onda 5: **novo** `GET /api/dashboard/kpis?scope=tenant|admin` (flag `DASHBOARD_KPIS=off`), query-on-read + cache 15 s por chave com tenant + `X-Elapsed-Ms`; `summary` intacto.
7. KPIs tenant (8 + custo + mensagens): Bancada, Fábrica agora, Bloqueados, Entregues 30 d (delta), Lead time mediano, Taxa de falha, Tarefas, Propostas; custo MTD × orçamento, custo por entrega, top 3 modelos; 5 mensagens importantes — todos com SQL sobre tabelas existentes e `tenant_id = $1`.
8. KPIs admin: tenants (reuso), pendentes de desbloqueio = aguardando pagamento + e-mail não confirmado, bloqueados = suspensos + projetos `blocked_%`, fábrica global, custo MTD + top 5 tenants (showback), pendências operacionais. Sem tocar no financeiro.
9. Migration **086**: 3 índices (`project_agent_metrics(created_at)`, `projects(tenant_id,status)`, `projects(tenant_id,finished_at)`).
10. Portal: `KpiCard` (extraído do `StatCard` local), `DashboardKpis`, `lib/format.ts`; substitui os 4 cards contados no cliente; mobile 2 por linha; sem gauges/3D.
11. Bugs reais achados no mapeamento e corrigidos no PR-0: `IN_REVIEW` inexistente em `dashboard.ts:76`; `DashboardLiveOps` sem `?tenantId` do seletor do master; `dashboard.ts` sem teste.
12. Adversarial: 14 GAPs fechados (RBAC cross-tenant e cache por escopo, orçamento contornável, double-count, custo de query/índices, N+1 na home, dados inconsistentes de `finished_at`, PDF comprimido, upload malicioso, proposta órfã, cancelar não mata thread, mobile/formatação, flag de UI congelada no build, estimativa de tokens).
13. Ordem: PR-0 → PR-1 → PR-2 → PR-3 → PR-4 → PR-5 → PR-6 (~7 dias); flags OFF em prod; deploy em 3 janelas pelo fluxo ECR; PÓS ao vivo definido por PR.
14. Decisões pendentes do Jean: D-4.1 (ideia vira projeto-origem? rec. não), D-4.2 (`pdf-parse`? rec. depois), D-5.1 (endpoint novo — rec. sim), D-5.2 (estado de tenant "bloqueado"? rec. não), D-5.3 (materializar só se p95 > 300 ms).
