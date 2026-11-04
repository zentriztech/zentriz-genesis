> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto — estado atual (A): como funciona hoje, de ponta a ponta

**Data:** 2026-11-03 · **Escopo:** somente leitura do repositório (branch `dev`), nada executado, nada tocado em produção · **Objetivo:** subsidiar a análise de viabilidade de mover o fluxo "🔄 Evoluir projeto" para a Bancada (cards Evolução/Correção/Recurso novo, anexos opcionais, modo sempre "branch git", só após 1ª fabricação).

Convenção: caminhos relativos a `applications/` salvo indicação. `[não verificado]` = inferido por leitura, sem execução ou sem prova no código. Números de linha são do estado atual do `dev` e podem derivar.

Documentos prévios que já cobrem partes do tema (não repetidos aqui): `project/docs/analysis/ESTUDO-EVOLUCAO-POR-TICKET-2026-09-11.md`, `project/docs/rfc/RFC-0009-EVOLUCAO-POR-TICKET.md` (status "Rascunho" na ficha), `project/docs/plans/EVOLUIR-BLOCO{2,3,4}-*.md`.

---

## 1. Resumo

1. **A premissa "hoje abre na Fábrica" é só meio verdadeira.** O botão e o diálogo ficam na página do projeto (`projects/[id]/page.tsx`), mas ao criar a evolução o usuário já é redirecionado para a **Bancada** (`/spec?editProjectId=<filho>&evolve=1`, page.tsx:1054-1060). Ou seja, o fluxo é **híbrido**: pedido na tela do projeto (Fábrica) → maturação na Bancada → promoção/execução na Fábrica.
2. **Boa parte do que o Jean descreve já existe.** O diálogo já tem os 3 tipos (Evolução/Correção/Recurso novo), anexos opcionais (até 10 × 10 MB), "Modo de trabalho" (cópia/branch) e uma **fila de pedidos por produto** (entidade `tickets`, `TK-NNNN`, migration 128, RFC-0009). Falta a **superfície na Bancada** (cards) e o **vínculo ticket → tasks**.
3. **Evolução = novo projeto filho** (`projects.parent_project_id`, `version_number+1`, `extra.evolution=true`) criado por `POST /api/projects/:id/evolve` (projects.ts:3383-3702), **somente se o pai estiver `accepted`** (projects.ts:3411-3416). Código-base = clone do repo `dev` da raiz da linhagem em branch `evolution/vN` (ou cópia em disco como fallback).
4. **"Modo de trabalho" é praticamente decorativo:** `copy` e `branch` seguem o mesmo caminho no `/evolve` (clone + `evolution/vN` sempre que há repo); o runner só usa `branch` para um `git init` legado quando o clone não existiu (runner.py:6029-6044). O "sempre branch git" já é, de fato, o comportamento padrão quando há GitHub App + repo.
5. **A Fábrica numera TASKs por LLM, não por código:** o PM emite `TSK-EVO-NNN` (prompt `agents/pm/SYSTEM_PROMPT.md:197-223`), o runner faz parse do `BACKLOG.md` (runner.py:3744+) e faz upsert por `(project_id, task_id)` (projects.ts:540). As tasks do pai concluídas entram no filho como `TSK-INH-*` com status `DONE` (runner.py:3894-3926, 7082-7092). **Não existe coluna/ligação ticket → task**; o ticket só chega ao PR/commit pelo `extra.ticket_*` do projeto filho.
6. **Idempotência: boa na camada de tasks e do aceite, frágil na criação da evolução.** Há upsert que preserva status terminal, checkpoint `.runner-state/<id>/checkpoint.json`, `TaskState`, 409 no runner server para run duplicado, `EVOLUTION_IN_FLIGHT`. Mas `/evolve` **não é transacional, não tem lock nem índice único** em `(parent_project_id, version_number)` (race e órfãos possíveis — seção 10).
7. **Risco concreto de anexos:** os anexos do ticket são materializados em `project_spec_files` e o runner concatena **todos** os arquivos da spec lendo `read_text(utf-8)` estrito dentro de um `try/except` que devolve `""` (runner.py:951-965). Um anexo binário (png, xlsx) pode fazer a fábrica **cair silenciosamente para só o arquivo primário** `[não verificado em execução; leitura do código]`.
8. **Cyborg é agnóstico a evolução** (nenhuma referência a `evolution` em `zentriz_cyborg.py`/`cyborg_v2.py`/`cyborg_v3.py`); entra no mesmo ponto do primeiro build (`pending_cyborg`/`blocked_cyborg`).
9. **"Fabricado ao menos 1 vez" já existe como regra**: `parent.status === "accepted"` (UI page.tsx:1376; API projects.ts:3411). Não existe campo `first_factory_run_at`; `accepted` é o único sinal (e `completed` **não** libera evoluir).

---

## 2. Fluxo ponta a ponta (diagrama)

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuário
  participant W as genesis-web (projects/[id])
  participant A as api-node
  participant DB as Postgres
  participant FS as Disco (/shared/uploads, PROJECT_FILES_ROOT)
  participant GH as GitHub App
  participant B as Bancada (spec/page.tsx)
  participant AG as agents (LLM arquiteto)
  participant R as runner (runner.py)
  participant C as Cyborg

  U->>W: Clica "Evoluir" (só se project.status=accepted)
  W->>A: POST /api/products/:pid/tickets (multipart: body, changeKind, projectId, files)
  A->>DB: BEGIN; products.next_ticket_seq++; INSERT tickets; INSERT ticket_attachments; COMMIT
  A->>FS: grava anexos em UPLOAD_DIR/tickets/<ticketId>/
  W->>A: POST /api/projects/:id/evolve {ticketId, workMode}
  A->>DB: valida pai accepted, ticket open, sem filho em voo, pai não superado
  A->>DB: INSERT projects (filho, draft, extra.evolution...)
  A->>FS: copia TODOS os spec files do pai; primário vira spec-evolution-vN.md com cabeçalho do pedido
  A->>DB: filho -> spec_submitted (se herdou arquivos)
  A->>GH: clone repo dev da raiz -> apps/ do filho; checkout -b evolution/vN
  A->>FS: materializa tickets/TK-NNNN/request.md + anexos (rel_dir) e registra em project_spec_files
  A->>DB: tickets.status=promoted, child_project_id
  A-->>W: 201 {childProjectId}
  W->>B: redireciona /spec?editProjectId=<filho>&evolve=1
  U->>B: "Gerar RFC / CHANGELOG" (opcional)
  B->>A: POST /api/projects/:id/evolution-plan (job persistido)
  A->>AG: /invoke/raw (spec vigente, charter pai, repo map, connect.yaml, pedido)
  AG-->>A: RFC(s) Gherkin + files_allowed, ADR, CHANGELOG, connect.yaml
  A->>FS: grava docs/rfc, docs/adr, CHANGELOG.md na árvore de spec do filho
  U->>A: Promove / inicia (POST /run)
  A->>A: gates (dependência, validação, content, EVOLUTION_RFC_*), claimSlotOrQueue
  A->>DB: extra.evolution_scope/compat/rfcs; evolution_request sintetizado dos RFCs
  A->>R: POST runner /run {projectId, specPath|specContent}
  R->>R: detecta extra.evolution; repo map; baseline da suíte; contexto de evolução
  R->>R: Engineer (pulado se não-MAJOR) -> CTO (Charter Delta) -> PM (TSK-EVO-*)
  R->>A: POST /tasks (BACKLOG parseado + TSK-FULL-TEST) e herda TSK-INH-* do pai (DONE)
  loop Monitor Loop por task
    R->>R: Dev (gate de escopo evolution_scope) -> QA -> DevOps condicional
  end
  R->>R: P2P final (não-regressão vs baseline), TSK-FULL-TEST
  R->>C: status pending_cyborg (aceite automático ou blocked_cyborg)
  C->>A: accepted
  A->>A: runEvolutionAcceptFlow: CHANGELOG semver, push evolution/vN, PR -> dev, supersede pai
  A->>GH: (opcional, flag) merge automático do PR
```

---

## 3. UI

| Item | Evidência |
|---|---|
| Estado do diálogo: `evolveOpen`, `evolveRequest`, `evolveWorkMode` (`"copy"\|"branch"`, padrão `copy`), `evolveKind` (`evolution\|fix\|feature`), `evolveFiles`, `evolveTicketId`, `openTickets`, `parkLoading`, `evolveNotice`, `evolveError` | `app/(dashboard)/projects/[id]/page.tsx:415-427` |
| Rótulos dos tipos (`TICKET_KIND_LABEL`) | page.tsx:178 |
| Botão "Evoluir (N pedidos)" — **só com `project.status === "accepted"`** | page.tsx:1375-1382 |
| Diálogo "🔄 Evoluir projeto": texto explicativo (nova versão do mesmo serviço, branch `evolution/vN`, vai à Bancada, só tasks adicionais) | page.tsx:1675-1683 |
| Fila de pedidos abertos (chips "Novo pedido" + tickets) e promoção de pedido existente | page.tsx:1695-1730 |
| Campo de texto (readOnly ao promover pedido existente: texto imutável) | page.tsx:1721-1727 |
| Seletor de tipo (Evolução / Correção / Recurso novo) — desabilitado ao promover ticket | page.tsx:1744-1753 |
| Anexos: `<input type=file multiple>`, `slice(0, 10)`, legenda "Até 10 arquivos, 10 MB cada" (**só se pedido novo**) | page.tsx:1759-1780 |
| Modo de trabalho: "📋 Cópia isolada" × "🌿 Branch git" | page.tsx:1786-1802 |
| Botões: Cancelar / "Só registrar pedido" (cria ticket sem promover) / "Criar evolução" ou "Promover pedido" | page.tsx:1805-1822 |
| `loadOpenTickets()` → `GET /api/products/:pid/tickets?status=open` (contador ao lado de "Evoluir") | page.tsx:980-989 |
| `createTicket()` → `POST /api/products/:pid/tickets` (multipart) | page.tsx:994-1004 |
| `handleEvolve()`: cria ticket **antes** (para não perder texto/anexo no 409), depois `POST /api/projects/:id/evolve` e redireciona à Bancada | page.tsx:1024-1076 |
| Aba "Evolução" (painel só em projeto com `extra.evolution`) | page.tsx:813-817, 1173; `components/EvolutionPanel.tsx` (consome `GET /evolution-state`) |
| Chips de supersessão (substituído por / corrente), botão "Republicar" quando `evolution_push_pending` | page.tsx:1299-1340; `projects/page.tsx:212-218` |
| Bancada reconhece evolução (`isEvolution`) e oferece "Gerar RFC / CHANGELOG" | `app/(dashboard)/spec/page.tsx:2111-2140, 3066-3150, 3757` |
| **Não existe** UI de ticket/card na Bancada nem listagem de `tickets` fora do diálogo | `rg ticket` em `apps/genesis-web`: só `projects/[id]/page.tsx` |

Observação: `isMaster` (conta de gestão) desabilita criar evolução (page.tsx:1010, 1025) e a API também bloqueia (`denyCreationForManagement`).

---

## 4. API

| Rota | Função | Evidência |
|---|---|---|
| `POST /api/products/:productId/tickets` | Cria pedido (multipart `parts()`: `title`,`body`,`changeKind`,`projectId`, arquivos). Números por produto, anexos em disco. Recusa produto arquivado; token de serviço `runner` não cria | `routes/tickets.ts:84-195` |
| `GET /api/products/:productId/tickets?status=` | Lista; hidrata `execution_status` (join em `projects`) e contagem de anexos | tickets.ts:198-215, 47-79 |
| `GET /api/tickets/:id` / `PATCH` / `DELETE` / `GET .../attachments/:id` | Detalhe, edição só enquanto `open`, recusa/entrega manual, exclusão só `open`, download | tickets.ts:218-324 |
| `POST /api/projects/:id/evolve` | Cria o filho de evolução (corpo `{request?, workMode?, ticketId?}`) — **única porta de promoção** | `routes/projects.ts:3383-3702` |
| `POST /api/projects/:id/evolution-plan` + `GET .../:jobId` | Arquiteto da Bancada gera RFC/ADR/CHANGELOG/connect.yaml; job persistido; 202 | `routes/evolutionPlan.ts:31-67`; `services/evolutionPlanner.ts:585-672` |
| `GET /api/projects/:id/evolution-state` | Estado para o painel (checkpoint do runner + `extra`) | evolutionPlan.ts:74-130 |
| `POST /api/projects/:id/evolution/republish` / `.../merge` | Reprocessa push pendente / merge forçado (type-to-confirm) | evolutionPlan.ts:169-264 |
| `POST /api/projects/:id/promote` | Admite spec da Bancada à Fábrica (**exige `status === 'draft'`**) | `routes/pipeline.ts:124-247` (checagem em 139-148) |
| `POST /api/projects/:id/run` | Inicia pipeline; roda gates (dependência, validação, **evolução/RFC**, conteúdo), cost cap, `claimSlotOrQueue`, chama `RUNNER_SERVICE_URL/run` | pipeline.ts:480-805 (gate de evolução 566-581) |
| `POST/PATCH /api/projects/:id/tasks` | Upsert de tasks pelo runner | projects.ts:518-565 |
| `POST /api/projects/:id/accept` (efeito colateral) | `runEvolutionAcceptFlow` em `setImmediate` | projects.ts:793-806 |
| `DELETE /api/projects/:id` | Arquiva (se há artefatos) ou apaga; **reabre o ticket** (`reopenTicketsOfChild`) | projects.ts:3020-3050 |

Guardas do `/evolve` (ordem): acesso → pai existe → `status==='accepted'` (409) → ticket do mesmo produto e `open` (400/409) → `EVOLUTION_IN_FLIGHT` (409; qualquer filho com status fora de `accepted|archived|failed`) → `PARENT_SUPERSEDED` (409) (projects.ts:3411-3467).

Limites no código: multipart global `files: 10`, `fileSize: 10 MB` (`app.ts:81-83`); `body` do ticket ≤ 20.000 chars e título ≤ 300 (tickets.ts:30-31); rate limit de `/run` 5/min por tenant (pipeline.ts:31-32); concorrência de projetos por tenant via `max_concurrent_projects` (`services/tenantLlmConfig.ts:859-897`; valor padrão `DEFAULT_MAX_CONCURRENT_PROJECTS` [não verificado o número]).

---

## 5. Dados

- **`projects`** (filho): `parent_project_id`, `version_number` (migration 009; **sem UNIQUE** em `(parent_project_id, version_number)`), `status` (`draft` → `spec_submitted` → `promoted`/`running` → `completed`/`pending_cyborg`/`blocked_cyborg` → `accepted`/`archived`/`failed`/`stopped`/`queued`), `extra` JSONB. Chaves de evolução gravadas no `/evolve`: `evolution`, `evolution_request`, `ticket_id/number/kind`, `evolution_work_mode`, `evolution_parent_id`, `evolution_root_id`, `evolution_branch`, `evolution_source` (`git-clone|disk-copy|none`), `evolution_inherited_files`, `evolution_inherited_spec[{path,sha}]`, `ticket_files`, `ticket_materialize_error` (projects.ts:3503-3530, 3643-3667). Mais tarde: `evolution_rfcs/scope/compat/compat_explicit/request_original` (evolutionGate.ts:187-205), `evolution_version/branch/repo/pr_url/pr_number/head_sha/push_pending/merge_state` (evolutionAccept.ts).
- **`tickets`** (mig. 128): `number` por produto (índice único `(product_id, number)`), `change_kind` (`evolution|fix|feature`), `status` (`open|promoted|delivered|rejected`), `child_project_id`, `promoted_at`, `delivered_at`; **`ticket_attachments`** (`file_path`, `mime_type`, `size_bytes`, `content_sha256`); **`products.next_ticket_seq`**.
- **`project_spec_files`**: árvore da Bancada (`rel_dir`, `is_primary`, `content_sha256`); recebe `tickets/TK-NNNN/request.md` e `.../anexos/*` do ticket (tickets.ts services 156-215), com `ON CONFLICT (project_id, rel_dir, filename) DO UPDATE`.
- **`project_tasks`**: `UNIQUE(project_id, task_id)`; `status` CHECK `NEW|ASSIGNED|IN_PROGRESS|WAITING_REVIEW|QA_FAIL|QA_PASS|BLOCKED|DONE|CANCELLED` (mig. 001:83-101). **Sem coluna de ticket, de versão ou de origem (herdada/nova).**
- **`evolution_plan_jobs`** (mig. 082): índice único parcial `epj_one_flight` (um job `pending|running` por projeto); `PLAN_JOB_STALE_MS` (10 min, `EVOLUTION_PLAN_JOB_STALE_MS`) para órfãos (evolutionPlanner.ts:613-632).
- **`products.next_rfc_seq/next_adr_seq`** (mig. 080): numeração de RFC/ADR por produto, atômica (evolutionPlanner.ts:311-323).
- **`project_github_repos`**, `tenant_github_installations`: repo e instalação usados no clone e no push (projects.ts:3590-3604).
- **`project_dialogue`**: trilha textual de cada passo (criação, aceite, push, merge).
- Disco: `UPLOAD_DIR/<projectId>/` (spec), `UPLOAD_DIR/tickets/<ticketId>/` (anexos), `PROJECT_FILES_ROOT/<projectId>/{apps,docs,project}`, `PROJECT_FILES_ROOT/<projectId>/.tasks-state.json` (`orchestrator/task_state.py:44-48`), `PROJECT_FILES_ROOT/.runner-state/<projectId>/checkpoint.json` (`services/evolutionState.ts`, `pipeline_context.py:702-754`).

---

## 6. Orquestrador / pipeline

**6.1 Disparo.** `/run` chama o runner server (`orchestrator/runner_server.py` `POST /run`, linha ~308) com `projectId` e `specPath` (caminho do **arquivo `.md` primário**, `getProjectSpecFilePath`) ou `specContent` base64 (pipeline.ts:716-731). O runner server recusa com **409** se já há processo vivo para o projeto (PID em memória e em disco; trata zumbi) (runner_server.py:314-334; 170-200).

**6.2 Carga da spec.** O runner usa `load_spec_all(project_id)` (runner.py:923-965) → `GET /api/projects/:id/spec-files` → concatena **toda a árvore** (inclui `tickets/TK-NNNN/request.md` e anexos). `connect.yaml` e `*.yaml` ficam fora do prompt. Orçamento `SPEC_INPUT_CHARS` (padrão 145.000); corte em fronteira de arquivo com aviso ao humano (runner.py:5568-5595; `fit_spec_to_budget`).

**6.3 Modo evolução (FT-10).** Detecção por `projects.extra.evolution === true` (runner.py:5859-5897): lê `evolution_request`, `evolution_work_mode`, `evolution_parent_id`, `evolution_scope`, `evolution_compat`. Sem `evolution_scope`, o gate de escopo é desativado com warning (5897). Depois (5916-6007): repo map do `apps/` do filho (~20k chars, `EVOLUTION_REPO_MAP_CHARS`), charter e proposta técnica do **pai**, lista das tasks `DONE` do pai (para o PM não repetir), e o bloco "REGRAS ABSOLUTAS DE EVOLUÇÃO" (5970-5984: nunca remover recurso sem pedido explícito; patch cirúrgico; prefixo `TSK-EVO-`; charter com `## Delta`).

**6.4 Papéis numa evolução vs 1ª fabricação** (evidência):

| Papel | Primeira fabricação | Evolução |
|---|---|---|
| Engineer | Proposta técnica completa | **Pulado na rodada 1** se há proposta do pai e compat ≠ `major` (runner.py:6405-6425, "E4/E-D3"); retorna na rodada 2 se o CTO pedir revisão |
| CTO | Charter | **Charter Delta** (`## Delta`: ADICIONA/MANTÉM/REMOVE; gate T-TYPE-COMPLIANCE-EVO) — `agents/cto/SYSTEM_PROMPT.md:1173-1260` |
| PM | `TSK-<MOD>-NNN` | **`TSK-EVO-NNN`**, `complexity_hint` só do delta; trivial → 1 task `TSK-EVO-001` (`agents/pm/SYSTEM_PROMPT.md:197-223`); pré-classificador "trivial" **vetado** em evolução (runner.py:6194-6197) |
| Dev | Gera arquivos | Só dentro de `evolution_scope ∪ tests/** ∪ docs/**`; fora do escopo é **descartado** (runner.py:504-556, 4750-4760); ≥2 rodadas de violação (`EVOLUTION_MAX_SCOPE_VIOLATIONS`, runner.py:395) → bloqueio estrutural; formato `edits` opcional (`EVOLUTION_DEV_EDIT_FORMAT`, `agents/runtime.py:612-716`) |
| QA | Valida ACs | Valida ACs + não-regressão dentro do escopo (runner.py:2516-2540; `agents/qa` regra EVO-05 sobre prefixo `TSK-EVO-`) |
| DevOps | Gera infra | **Condicional**: se nenhum arquivo de infra foi tocado, `TSK-DEVOPS-001` vira `DONE` "inherited-infra" sem LLM (runner.py:4962-4975, `EVOLUTION_DEVOPS_CONDITIONAL`) |
| TSK-FULL-TEST | Sempre (salvo `tsk_full_test: false` no charter) | Igual; `TSK-FULL-TEST` e `TSK-DEVOPS-001` do pai **não** são herdados (`_INHERIT_SKIP_TASKS`, runner.py:3891) |
| Suíte de testes | Executada no fim (GAP-86) | Idem + **baseline antes** e comparação P2P (regressões) no fim (runner.py:6009-6025, 5352-5372; `EVOLUTION_P2P_MODE`) |
| Cyborg | `pending_cyborg` → aceita/bloqueia | **Idêntico** — nenhum código específico de evolução |

**6.5 Cyborg.** Após o Monitor Loop o runner deixa `pending_cyborg`/`blocked_cyborg` protegidos (runner.py:7146-7165); o Cyborg V2/V3 (`zentriz_cyborg.py:1063`) decide. `rg evolution` em `zentriz_cyborg.py`, `cyborg_v2.py`, `cyborg_v3.py` não encontra uso de metadados de evolução [verificado por busca].

---

## 7. Identidade e numeração de TASKs

- **IDs vêm do PM (LLM)** e são extraídos por regex `TSK-[A-Z]+-\d+|TSK-\d+` apenas de cabeçalhos do `BACKLOG.md` (runner.py:3744-3830). Em evolução o prompt manda prefixo `TSK-EVO-` (PM prompt:206), **verificado só por QA/LLM** (EVO-05), sem checagem determinística no parser [não verificado fora de prompt].
- **Escopo do ID = projeto filho** (`UNIQUE(project_id, task_id)`). A numeração **reinicia por versão**: `TSK-EVO-001` existe em v2, em v3, etc., sem colisão porque são projetos distintos.
- **Herança:** tasks `DONE`/`QA_PASS` do pai viram `TSK-INH-<resto>` com `status=DONE`, `requirements="[HERDADA da versão anterior — <id>] …"` (runner.py:3894-3926), chamadas após `_seed_tasks` (7082-7092) e anexadas a `pipeline_ctx.completed_tasks`. Ignora `TSK-DEVOPS-001`, `TSK-FULL-TEST` e **qualquer `TSK-INH-*` do pai** (3911) → a herança é de **um nível**; o histórico de v1 não reaparece como `INH` em v3 (o contexto do PM via `_parent_done_block` inclui `TSK-INH-*` do pai, runner.py:5958-5965, mas o banco do filho não). `[inferido por leitura]`
- **Sem ligação ticket → task.** Decisão explícita do RFC-0009: "sem tocar no ID da task" (projects.ts:3514-3516). O ticket vai para `extra.ticket_*` do filho e daí ao título/corpo do PR e à mensagem de commit (`ticketStamp`, githubPush.ts ~655-665; evolutionAccept.ts:164-168). Rastreio ticket→tasks hoje só por **projeto filho** (1 ticket ↔ 1 filho ↔ N tasks).
- **Numeração de RFC/ADR/TK:** por produto, atômica (`next_rfc_seq`, `next_adr_seq`, `next_ticket_seq`).
- `version_number` do filho = `pai.version_number + 1` (projects.ts:3469), calculado em leitura (ver risco de corrida, seção 10).

---

## 8. Idempotência e resiliência hoje

| Mecanismo | O que garante | Evidência |
|---|---|---|
| Upsert de tasks preserva terminais; `IN_PROGRESS/WAITING_REVIEW` voltam a `ASSIGNED` no restart | Re-seed não refaz `DONE/QA_PASS/QA_FAIL/BLOCKED` | projects.ts:540-555 |
| `TaskState` persistente (`.tasks-state.json`) e `to_seed_tasks` | Terminais sobrevivem a restart do runner; o seed aplica o status preservado | task_state.py:1-60; runner.py `_seed_tasks` (3934+) |
| Checkpoint do `PipelineContext` (LEI 11) — inclui `completed_tasks`, `current_step`, tudo de `evolution_*` | Retomada: `load_checkpoint` e "retomando a partir da próxima fase" | pipeline_context.py:702-815; runner.py:5605-5612 |
| Herança de tasks idempotente | Upsert; mensagem só na 1ª vez | runner.py:7082-7092 |
| Run duplicado | 409 no runner server (PID memória+disco) e `claimSlotOrQueue` com advisory lock por tenant; `ALLOWED_STATUS_FOR_RUN` (`stopped/failed/queued/promoted/draft/...`) | runner_server.py:314-334; tenantLlmConfig.ts:859-897; pipeline.ts:63-77 |
| Falha de dispatch libera slot e reverte graduação | `revertSlotClaim`, `compensateGraduation` | pipeline.ts:~690-805 |
| Negativa do LLM Guard não é falha | `stopped` retomável, sem contar tentativa (`GUARD_DENIAL_GRACEFUL`) | runner.py:4020-4040 |
| 1 evolução em voo por serviço | `EVOLUTION_IN_FLIGHT` | projects.ts:3442-3457 |
| Ticket só promove 1 vez | `TICKET_ALREADY_PROMOTED` (409) | projects.ts:3425-3433 |
| Filho descartado reabre o ticket | `reopenTicketsOfChild` | services/tickets.ts:237-245; projects.ts:3034, 3048 |
| Plano de evolução: 1 job em voo e reaper de órfãos | índice único parcial + `reapOrphanPlanJobs` | mig. 082; evolutionPlanner.ts:625 |
| Aceite idempotente | Reusa `evolution_version` se já fechada (não dobra semver), `republish` | evolutionAccept.ts:225-245 |
| Push com falha não derruba o aceite; supersessão do pai só após push ok | `evolution_push_pending` + botão Republicar | evolutionAccept.ts:247-295 |
| Merge automático: claim atômico `merging`, `sha` do head, backoff | Estados terminais legíveis | evolutionMerge.ts (flags abaixo) |
| Materialização do ticket é best-effort e idempotente | `ON CONFLICT DO UPDATE`; erro vai a `ticket_materialize_error` | services/tickets.ts:156-215; projects.ts:3655-3670 |

**Como evita refazer tasks já processadas numa evolução:** (a) o filho é um **projeto novo** (tasks do pai nunca são reabertas); (b) o delta é contido por RFC + `files_allowed` (gate de escopo) e pelo `evolution_request` sintetizado dos RFCs; (c) o PM recebe a lista de tasks `DONE` do pai ("não repita"); (d) herdadas entram como `DONE`. **Não há verificação determinística** de que uma `TSK-EVO` nova não duplica requisito de uma `TSK-INH` — depende do LLM (prompt) `[não verificado em execução]`.

**`TSK-FULL-TEST`:** semeada ao final do backlog com status `NEW` (runner.py:3977-3989), promovida após o DevOps, executada pelo Claude Code Agent via `scripts/full-test-server.py` (runner.py:5069-5460); em evolução continua sendo gerada pelo filho (não herdada).

---

## 9. Git / branch / PR

1. **Criação do filho (`/evolve`)**: `gitLinkProjectFolder({branch:"dev"})` clona o repo `dev` da raiz da linhagem (via `project_github_repos` + `tenant_github_installations`) em `PROJECT_FILES_ROOT/<filho>/apps` e `checkoutNewBranch("evolution/vN")` (projects.ts:3582-3641). Fallback: copia `apps/` do pai (com conteúdo) e cria o branch só se houver `.git`. Sem `PROJECT_FILES_ROOT` ou sem repo: `evolution_source="none"` e o `apps/` nasce **vazio** (o Dev pode regenerar do zero; só há warning no runner e mensagem no diálogo).
2. **`workMode`**: gravado em `extra.evolution_work_mode`; só o runner lê (6029) para um `git init` legado se `apps/` não tem `.git`. Cria `main/staging/dev/evolution/vN` locais — **sem remote** (código que referencia `_evo_proj_data.get('versionNumber', 2)` e ele vem de `/api/projects/:id`, não de `extra`) `[não verificado]`.
3. **Aceite → publicação**: `runEvolutionAcceptFlow` (evolutionAccept.ts:209-318): fecha CHANGELOG (SemVer pela compat dos RFCs), `pushEvolutionToGitHub` → `createBranchIfNotExists(evolution/vN, base dev)`, `pushProjectFiles` (com `syncDeletes`, `EVOLUTION_SYNC_DELETES`), `openPullRequest` base `dev` com título `TK-NNNN · Evolução vX — …` e corpo com ticket/tipo (githubPush.ts:611-700; evolutionAccept.ts:164-168). Registra PR no `extra` (`evolution_pr_url/number/head_sha`), re-registra no Deadpool com a mesma chave (identidade da raiz).
4. **Supersessão**: pai → `archived` + `extra.superseded_by`, apenas após push ok ou tenant sem GitHub (evolutionAccept.ts:276-295).
5. **Merge**: opcional, atrás de `EVOLUTION_AUTO_MERGE` (padrão off), com políticas `..._MAX_COMPAT` (nunca `major`), `..._ALLOW_NO_TESTS`, `..._ALLOW_HAS_HOOKS`, gate P2P, observador `EVOLUTION_MERGE_WATCH` (5 min), rota manual forçada com confirmação (evolutionMerge.ts; evolutionMergeWorker.ts; evolutionPlan.ts:206-264). Pós-merge: `EVOLUTION_POST_MERGE_REALIGN`, `EVOLUTION_AUTO_REDEPLOY` (`services/postMerge/*`, `provision/cloudDeploy.ts:86`).
6. **`GENESIS_GITHUB_PUSH=off`** desliga a publicação (ambiente dev): sem branch/PR, mas a supersessão segue (githubPush.ts ~628-635).

**O que NÃO existe:** um branch por ticket (é por versão, `evolution/vN`); PR por card; vários cards/branches paralelos no mesmo serviço (bloqueado por `EVOLUTION_IN_FLIGHT`); branch criado em remoto no momento do `/evolve` (só local; o remoto nasce no aceite).

---

## 10. Anexos

- **Entrada:** UI até 10 arquivos × 10 MB (`slice(0,10)`; page.tsx:1766) → multipart `POST /tickets`; limite global do `@fastify/multipart` `files:10, fileSize:10 MB` (app.ts:81-83). Estouro de `fileSize` no fastify multipart normalmente **trunca** o stream e marca `part.file.truncated` — o código **não verifica `truncated`** (tickets.ts:117-120) `[não verificado em execução; comportamento depende da versão do plugin]`.
- **Armazenamento:** `UPLOAD_DIR/tickets/<ticketId>/<filename>` sem subpastas, `safeFilename` sem tradução de colisão (dois anexos com o mesmo nome **sobrescrevem** o arquivo no disco e geram 2 linhas em `ticket_attachments` apontando para o mesmo `file_path`) `[inferido]`; sem validação de MIME/extensão/antivírus.
- **Promoção:** copiados para `UPLOAD_DIR/<filho>/tickets/TK-NNNN/anexos/` e registrados em `project_spec_files` (rel_dir `tickets/TK-NNNN/anexos`), com `request.md` linkando-os (services/tickets.ts:130-215).
- **Consumo pela IA:** 
  - **Planner da Bancada** (`evolutionPlanner.ts`): não lê tickets nem anexos (nenhuma ocorrência de `ticket`/`attachment` no arquivo); usa `extra.evolution_request_original|evolution_request` (texto).
  - **Fábrica:** os anexos entram em `load_spec_all` como texto (`read_text(utf-8)`, runner.py:960). Binários **quebram a leitura inteira**: a exceção cai no `except Exception` e a função retorna `""` (runner.py:963-965), levando ao fallback `load_spec(spec_path)` (somente o primário). **Risco alto** para o caso "print/planilha" que a própria UI promove. `[não verificado em execução]`
  - Nada converte imagem/planilha em contexto (sem OCR/visão/extração) — o estudo de 09/2026 já apontava que "anexo precisa ser lido e amarrado ao texto".
- **Teto da árvore da spec:** 200 arquivos, 256 KB por arquivo e 2 MB totais (`lib/specTreeHash.ts:26-28`) — a materialização de anexos de ticket via `INSERT` direto **não passa por essa validação** (tickets service grava direto no banco/disco) `[inferido]`.

---

## 11. Lacunas e riscos

**Lacunas (o que não existe hoje):**
1. Card/ticket na **Bancada** (nenhuma tela lista `tickets`; só o diálogo na página do projeto).
2. **Vínculo ticket → especificações → tasks**: não há `ticket_id` em `project_spec_files`-derivados nem em `project_tasks`; o ticket só vira o `request.md` e o `extra` do filho.
3. **Mais de um card ativo por serviço**: `EVOLUTION_IN_FLIGHT` limita a 1 filho vivo; fila existe mas é "primeiro pedido, depois o próximo".
4. **Fechamento automático do ciclo do ticket**: `delivered` só é setado por `PATCH` manual (tickets.ts:268-273); nada move `promoted → delivered` no aceite/merge.
5. **Marcador de "fabricado ao menos 1 vez"** próprio: usa-se `status === 'accepted'` do pai; `completed`, `pending_cyborg` e `blocked_cyborg` não habilitam evoluir; produto sem projeto aceito (ou aceito só por supersessão `archived`) não tem como evoluir.
6. **Tipo (`fix`/`feature`/`evolution`) sem efeito no pipeline**: só aparece no cabeçalho `# EVOLUTION REQUEST — vN (TK-… · correção)`, no `request.md`, no corpo do PR; o runner Python não lê `ticket_*` (nenhuma ocorrência em `orchestrator/`), CTO/PM não diferenciam correção de recurso.
7. **Anexos sem pipeline de leitura** (seção 10).
8. **`workMode` sem função real** (seção 9) — "sempre branch" é remoção de UI + garantir clone, não nova capacidade.
9. **Numeração de tasks sem sufixo/identificador de origem** (ticket, versão): `TSK-EVO-001` repete por versão; a unicidade é só por projeto.
10. **Testes de ponta a ponta com LLM real** para evolução: não localizados (somente unitários/mocks) `[não verificado: ver 12]`.

**Riscos de idempotência/resiliência:**
- **R1 — `/evolve` não é transacional.** Há ~6 efeitos sequenciais sem `BEGIN/COMMIT` (INSERT do projeto, herança de arquivos, UPDATE de status, clone, materialização, UPDATE do ticket, herança de triagens) usando um único `client` (projects.ts:3503-3670). Falha no meio deixa filho órfão em `draft`/`spec_submitted`, e este **bloqueia novos pedidos** via `EVOLUTION_IN_FLIGHT` até ser excluído manualmente.
- **R2 — Corrida de versão/duplicidade.** `inFlight` é `SELECT` seguido de `INSERT` sem lock; não há `UNIQUE(parent_project_id, version_number)` nem `FOR UPDATE` (busca em migrations e projects.ts: sem `FOR UPDATE`). Dois cliques/abas concorrentes podem criar 2 filhos `vN` e 2 branches `evolution/vN`. A checagem `ticket.status !== 'open'` também não é atômica (o `UPDATE tickets` do passo final não tem `WHERE status='open'`).
- **R3 — Duplo envio na UI.** `handleEvolve` desabilita o botão só via estado (`evolveLoading`); não há `Idempotency-Key`.
- **R4 — Ticket criado antes do `/evolve`** (page.tsx:1041-1045): se `/evolve` falha, o ticket fica `open` (por desenho, intencional); mas se o `/evolve` cria o filho e a resposta se perde, um retry cria o ticket **de novo** (novo `TK-`), pois a UI recria ticket em cada tentativa sem `ticketId`.
- **R5 — Ordem de status do filho vs. promoção.** `/evolve` põe o filho em `spec_submitted` (projects.ts:3575) enquanto `POST /api/projects/:id/promote` exige `draft` (pipeline.ts:139-148) e a promoção de produto exige `lifecycle_status='draft'` (products.ts:1333-1340) e só atualiza projetos `status='draft'` (products.ts:1453-1456). O caminho `/run` aceita `spec_submitted` (pipeline.ts:63-77). Como o filho de evolução entra na Fábrica a partir da Bancada (botão "Promover à Fábrica") é um ponto a **testar** `[não verificado em execução; possível 409 NOT_ON_WORKBENCH]`.
- **R6 — Checkpoint não-atômico.** `save_checkpoint` grava com `open("w")` direto (pipeline_context.py:753), sem arquivo temporário + rename; a API já trata JSON parcial relendo após 150 ms (evolutionState.ts). Um kill no meio da escrita pode corromper o checkpoint e `load_checkpoint` precisa tratar `JSONDecodeError` `[não verificado se trata]`.
- **R7 — Herança de um nível** (seção 7) e `TSK-INH` fora da contagem de progresso/Dev/QA (por desenho).
- **R8 — `apps/` vazio silencioso** quando falta `PROJECT_FILES_ROOT`/repo/instalação: o `/evolve` responde 201 mesmo assim (`evolutionSource: "none"`); o Dev pode regenerar o produto do zero (runner.py:5946-5949). O diálogo da Bancada não bloqueia.
- **R9 — `claimSlotOrQueue` enfileira** evoluções quando o tenant atinge `max_concurrent_projects`; a evolução compete com projetos novos.
- **R10 — Anexos binários** (seção 10), colisão de nomes, sem verificação de `truncated`.
- **R11 — Dependência do LLM para o prefixo e para "não repetir"**: sem validação determinística no parser do backlog.
- **R12 — Planner (LLM do arquiteto) só roda sob pedido humano** ("Gerar RFC"): sem RFC válido o `/run` retorna `EVOLUTION_RFC_REQUIRED/INVALID` (pipeline.ts:566-581) — gate forte de qualidade, mas é um passo manual extra para o fluxo "card → tasks".

**Flags / feature toggles encontrados** (env, no `api-node` e `orchestrator`): `EVOLUTION_AUTO_MERGE` (+`_METHOD`, `_MAX_COMPAT`, `_ALLOW_NO_TESTS`, `_ALLOW_HAS_HOOKS`), `EVOLUTION_MERGE_WATCH` (+`_MS`), `EVOLUTION_POST_MERGE_REALIGN`, `EVOLUTION_AUTO_REDEPLOY`, `EVOLUTION_SYNC_DELETES`, `EVOLUTION_PLAN_JOB_STALE_MS`, `EVOLUTION_RECONCILE_DISK`, `EVOLUTION_P2P_MODE`, `EVOLUTION_P2P_TIMEOUT`, `EVOLUTION_P2P_BASELINE_TIMEOUT`, `EVOLUTION_DEVOPS_CONDITIONAL`, `EVOLUTION_DEV_EDIT_FORMAT`, `EVOLUTION_DEV_EDIT_METRICS`, `EVOLUTION_DEV_SCOPE_FULL_CHARS`, `EVOLUTION_MAX_SCOPE_VIOLATIONS`, `EVOLUTION_REPO_MAP_CHARS`, `GENESIS_GITHUB_PUSH`, além de `RUN_RATE_LIMIT_*`, `SPEC_INPUT_CHARS`, `GUARD_DENIAL_GRACEFUL`. **Não há flag que desligue o botão "Evoluir" nem o fluxo de tickets** (nenhuma chave `TICKETS_*`/`EVOLVE_*` encontrada).

---

## 12. Testes existentes (onde estão)

- API (vitest): `services/api-node/src/routes/projects.evolve-ticket.test.ts` (promoção de ticket via `/evolve`), `routes/tickets.test.ts`, `services/tickets.test.ts`, `services/evolutionGate.test.ts`, `evolutionPlanner.test.ts`, `evolutionAccept.test.ts`, `evolutionMerge.test.ts`, `evolutionMergeWorker.test.ts`, `routes/evolutionPlan.test.ts`, `services/lineage.test.ts`, `db/linkProjectLineage.test.ts`, `services/githubPush.test.ts`, `services/gitLinkProjectFolder.test.ts`, `routes/pipeline.promote.test.ts`.
- Orquestrador (pytest): `orchestrator/tests/test_runner_evolution_e1.py`, `test_runner_evolution_e4.py`, `test_evolution_bloco3.py`, `test_runner_evolution_edits.py`.
- UI: sem teste localizado para o diálogo "Evoluir" `[não verificado: busca por nome apenas]`.
- E2E reais citados em comentários do código ("E2E 2026-09-04") — evidência documental em `project/docs/plans/EVOLUIR-BLOCO*.md`; não reexecutados aqui.

---

## 13. Perguntas abertas

1. **Cardinalidade card → execução:** 1 card = 1 filho (`vN`) como hoje, ou N cards acumulados em um mesmo filho/branch/PR? A primeira mantém `EVOLUTION_IN_FLIGHT` (1 em voo); a segunda exige reabrir o desenho do guard e da numeração de versão.
2. **"Branch git" por card ou por versão?** Hoje é `evolution/vN` (por versão). Branch por card (`evolution/TK-0012`) muda PR, merge, supersessão do pai e `realignWorkingTree` (`postMerge/realignWorkingTree.ts:93`).
3. **Quem gera as especificações do card?** Hoje o arquiteto (LLM) só roda sob "Gerar RFC". O requisito "todo card deve gerar especificações ligadas a ele" implica rodar o planner automaticamente na criação? Qual o custo/orçamento (cost cap por tenant/projeto) e quem aprova antes de promover?
4. **Como representar a ligação card ↔ spec ↔ TASK?** Prefixo no ID (o RFC-0009 rejeitou: o regex trunca `TSK-BE-001-TK12`), coluna nova em `project_tasks`, tabela de ligação, ou rótulo no `requirements`? Impacta o parser (`task_id_pattern`) e `TaskState`.
5. **Definição de "fabricado ao menos 1 vez":** `accepted` do pai (hoje) ou também `completed`/`pending_cyborg`? Em produto multi-serviço, vale por serviço ou por produto? E produtos cujo único projeto foi `archived` por supersessão?
6. **Anexos:** quais tipos serão suportados e como entram no contexto da IA (texto, OCR, visão, planilha→CSV)? Qual o teto na Bancada (hoje 256 KB/arquivo na árvore vs 10 MB no ticket)? Binários devem ficar fora de `project_spec_files` (guardados só como link)?
7. **Compatibilidade com o fluxo atual:** manter o diálogo da página do projeto durante a transição (flag de ambiente nova) ou migrar e aposentar? Os tickets existentes (`open/promoted`) precisam de migração de dados?
8. **Mapeamento de tipos:** Correção e Recurso novo devem alterar o comportamento do pipeline (ex.: Correção → compat `patch`, QA exige teste de regressão do bug; Recurso novo → `minor`)? Hoje o tipo é só rótulo.
9. **Idempotência desejada:** chave de idempotência por card (hash do corpo+anexos?) para impedir duplicidade em retry? Transação ou saga com compensação para `/evolve`?
10. **Retomada:** em caso de falha no meio do pipeline de um card, a retomada deve reaproveitar o filho/branch (como hoje via checkpoint) ou recriar?
11. **Qualidade "igual à 1ª versão":** o que será o critério mensurável (RFC Gherkin válido, P2P sem regressões, cobertura, `TSK-FULL-TEST` aprovado)? O Engineer pulado e o DevOps condicional são aceitos como equivalentes?
12. **Valor de `DEFAULT_MAX_CONCURRENT_PROJECTS`** e política de fila quando vários cards forem promovidos juntos `[não verificado]`.
13. **Produção:** o comportamento de `EVOLUTION_AUTO_MERGE`/`MERGE_WATCH`/`POST_MERGE_*` em PROD (3.220.66.113) não foi inspecionado — apenas o código.

---

## 14. Arquivos-chave (índice)

- UI: `applications/apps/genesis-web/app/(dashboard)/projects/[id]/page.tsx`, `.../spec/page.tsx`, `.../components/EvolutionPanel.tsx`
- API: `applications/services/api-node/src/routes/{projects,tickets,evolutionPlan,pipeline}.ts`; `services/{tickets,evolutionPlanner,evolutionGate,evolutionAccept,evolutionMerge,evolutionMergeWorker,evolutionState,githubPush,lineage}.ts`; `assets/EVOLVE_PLAN_PROMPT.md`, `assets/RFC_TEMPLATE.md`; migrations `009`, `080`, `082`, `128`
- Orquestrador: `applications/orchestrator/{runner.py,runner_server.py,pipeline_context.py,task_state.py}`; prompts `applications/agents/{pm,cto,dev,qa,engineer}/SYSTEM_PROMPT.md`
