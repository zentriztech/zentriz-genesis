> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (P) — Fase 2: modelo de dados do card (tarefas 2.1 a 2.5)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/h1` (a partir da `dev` em `fb96fa8`) · **Worktree:** `.worktrees/g-h1` · **Papel:** executor. Sem produção, sem push, sem deploy, Guard intocado, sem PII.
**Desenho:** [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) §4 (máquina de estados), §5 (`card_draft`), §6 (orçamento), §8 (flag); Fase 1' em [I](EVOLUIR-PROJETO-I-fase1-claim-indices-orcamento.md), [K](EVOLUIR-PROJETO-K-fase1-transicoes-e-promocao.md), [L](EVOLUIR-PROJETO-L-fase1-reconciliador.md), [N](EVOLUIR-PROJETO-N-correcoes-fase1-motor.md), [O](EVOLUIR-PROJETO-O-correcoes-fase1-seguranca-flags.md).
**Convenção:** caminhos relativos a `applications/services/api-node/src/`. **Estado:** preparado e validado em Postgres efêmero; **não funcional em produção** (nada implantado, `CARDS_BANCADA` desligada em todo lugar).

## 1. Commits (locais, em `evo/h1`)

| Commit | Conteúdo |
|---|---|
| `775bb87` | `CARDS_BANCADA` em `FLAG_DEFS` (entra em `CONFIG_KEYS` com `adminOnly` automaticamente) |
| `dcf5374` | Migrations 148, 149, 150; `card_draft` em `projectStatus.ts`; filtros nos leitores; leitura task→card; índice de boot `uq_tickets_draft`; testes de contrato (2.1, 2.2 esquema, 2.3) |
| `de24770` | `cardState.ts` (máquina de estados) e testes (2.4) |
| `18c322c` | `cardsBackfill.ts` + hook em `routes/runtimeConfig.ts` (2.2 backfill, 2.5) |
| (este relatório) | documentação |

## 2. Mudanças (arquivo:linha)

### 2.1 — migração *expand* e status `card_draft`
| Onde | O que |
|---|---|
| `db/migrations/148_cards_expand.sql` | `tickets.card_state` (CHECK dos 8 estados, nulo = legado), `blocked_reason` (CHECK: obrigatório quando `blocked`), `origin` (`manual`/`import`, default `manual`; **sem Deadpool**), `external_ref`, `draft_project_id` (FK `ON DELETE SET NULL`), `card_contract_version`; tabela `ticket_card_events` (+ `idx_tce_ticket`, `uq_tce_dedupe` parcial); `projects_status_check` com `card_draft` (superconjunto da 141) e `projects_card_draft_shape_check` (`card_draft` ⇒ `version_number = 0` e sem pai). **Não toca `tickets.status`** (nenhuma CHECK de status criada) |
| `services/evolutionUniqueness.ts` (índice novo ao fim de `UNIQUENESS_INDEXES`) | `uq_tickets_draft` (um rascunho por ticket) pelo passo de boot com pré-checagem, como manda H §4.3/§3.3 (nunca em `.sql`) |
| `services/projectStatus.ts:40` e `:50-60` | `card_draft` em `SPEC_EDITABLE_STATUSES`, fora de `PRE_FACTORY_STATUSES` e de `FACTORY_OR_TERMINAL_STATUSES`; `HIDDEN_FROM_PRODUCT_STATUSES` e `notHiddenProjectSql(alias)` (fonte única do filtro) |
| Leitores (inventário no §4) | `notHiddenProjectSql` aplicado aos 17 pontos que filtram por exclusão ou não filtram |

### 2.2 — `spec_origin` e execução
| Onde | O que |
|---|---|
| `db/migrations/149_project_spec_files_origin.sql` | `project_spec_files.spec_origin` (NULL ou `initial` ou `card:<código>`, CHECK por regex), `executed_in_project` (FK `SET NULL`), `executed_at`; índice parcial |
| `services/cardsBackfill.ts:83` `backfillSpecOrigin` | só linhas `spec_origin IS NULL`. Projeto que não é filho de evolução ⇒ `initial`. Filho de evolução: caminho listado em `extra.evolution_inherited_spec` ⇒ a origem que **o mesmo caminho tem no pai** (`initial` se o pai não tem); o restante (`spec-evolution-vN.md`, `tickets/TK-…/request.md`) ⇒ `card:legacy`. Pais antes dos filhos (ordem de versão), então v3 herda `card:legacy` de v2. `card_draft` fica de fora. **Decisão (H manda "função idempotente separada ou ao ligar"):** roda **quando a flag liga** (hook abaixo) e pode ser chamada direto (`backfillSpecOrigin(db, tenantId)`); nunca com a flag off |

### 2.3 — `project_tasks.card_id` / `origin_spec_file`
| Onde | O que |
|---|---|
| `db/migrations/150_project_tasks_card.sql` | `card_id` (FK `tickets` `ON DELETE SET NULL`), `origin_spec_file`, índice parcial. Regex de ID não alterado |
| `services/taskCardLinks.ts` + `routes/projects.ts` (GET `/api/projects/:id/tasks`, bloco `cardLinks`) | **leitura** só com a flag ligada para o tenant do projeto (`cardId`, `originSpecFile` por task). Flag off: as colunas nem são consultadas e as chaves não aparecem na resposta |

### 2.4 — máquina de estados (`services/cardState.ts`)
`transitionCard(db, {ticketId, to, actorKind, actorId?, reason?, childProjectId?, dedupeKey?})` (`:148`): numa transação (Pool abre a própria; cliente usa a do chamador), `SELECT … FOR UPDATE` serializa o card, valida contra `CARD_TRANSITIONS` (`:68`), e faz `UPDATE … WHERE id AND card_state = <lido> AND status = <legado esperado>` escrevendo `card_state`, `tickets.status` derivado, `blocked_reason` e as colunas legadas que acompanham o destino (promoted: `child_project_id`/`promoted_at`; descarte: limpa o vínculo; delivered: `delivered_at`), mais o evento em `ticket_card_events` na mesma transação. Resultados: `applied | noop | invalid | not_a_card | not_found | reason_required | child_required | diverged`. `enterCardMachine` (`:235`) é o `∅ → draft` (exige a flag do tenant do ticket, só ticket `open`). `findCardStatusDivergences` (`:273`) é a detecção Q6 (só leitura).

**Tabela de transições (H §4.1; atores permitidos):**

| De → Para | Atores | Status legado escrito |
|---|---|---|
| `draft → refining` | user, system | `open` |
| `draft`, `refining → ready` | system | `open` |
| `ready → refining` | user, system | `open` |
| `ready → promoted` (exige filho) | user, system | `promoted` |
| `promoted → in_factory` | system | `promoted` |
| `promoted`, `in_factory → blocked` (motivo obrigatório) | system, guard, reconciler | `promoted` |
| `blocked → in_factory` | user, system | `promoted` |
| `promoted`, `in_factory`, `blocked → ready` (filho descartado) | system | `open` (vínculo limpo) |
| `in_factory → delivered` | system | `delivered` |
| `draft`, `refining`, `ready`, `blocked → rejected` | user | `rejected` |
| `delivered`, `rejected` | terminais | — |

`∅ → draft`: `enterCardMachine` (user/system) ou backfill. Mesmo destino já atingido ⇒ `noop` sem evento; mesma `dedupeKey` já registrada para o destino ⇒ `noop`.

### 2.5 — flag e backfill
| Onde | O que |
|---|---|
| `services/featureFlags.ts:34` | `CARDS_BANCADA` (bool). Precedência tenant > global > env > off (igual às demais). `routes/runtimeConfig.ts` monta `CONFIG_KEYS` a partir de `FLAG_NAMES` ⇒ entra com `adminOnly: true` (tenant_admin recebe 403 no PUT e no DELETE) |
| `routes/runtimeConfig.ts` `cardsFlagBackfillFor` + PUT/DELETE | após gravar/remover `CARDS_BANCADA`, `runCardsFlagBackfill(pool, tenantId)` roda os dois backfills para o tenant (ou, se mudou o padrão global, para todo tenant em que a flag resolve ligada), cada um em transação; o resultado volta em `cardsBackfill` na resposta; falha do backfill não desfaz a flag e pode ser repetida. Outras chaves: resposta inalterada |
| `services/cardsBackfill.ts:37` `backfillCardState` | só `card_state IS NULL`; **não toca `status` nem `updated_at`**; um evento por ticket (ator `backfill`, chave `backfill:v1`). `open→draft`; `rejected→rejected`; `delivered→delivered`; `promoted` conforme o filho: ausente/`failed`/`archived` ⇒ `blocked` (`backfill:child_missing|failed|archived`); pré-fábrica (`draft, spec_submitted, pending_conversion, spec_validation_failed, materializing, promoted`) ⇒ `promoted`; demais ⇒ `in_factory` |

## 3. Desvios de H e decisões

1. **Sem semente em `genesis_runtime_config`** (H §8 propunha semear `CARDS_BANCADA=0`): as seis flags da Fase 1' não têm semente; seguir o mesmo padrão mantém o env como default de plataforma (um `0` global semeado o anularia). Ausência = desligada.
2. **`origin` sem `deadpool_incident`** (H §4.3 listava): decisão do Jean (Auto Care fora de escopo). CHECK é `manual | import`.
3. **`promoted` legado com filho `accepted` ⇒ `in_factory`, não `delivered`** (o plano diz "`in_factory|delivered` conforme o filho"): `delivered` exige PR mergeado comprovado (tarefa 4.3) e, no mapeamento de status de H §4.4, `delivered` escreveria `status='delivered'`, o que o backfill não faz (não toca `status`). `delivered` legado (humano) ⇒ `delivered`.
4. **`card_draft` com CHECK de forma** (`version_number = 0` e `parent_project_id IS NULL`): H §5.1 recomendava só a CHECK de versão; a de pai materializa a regra "nunca dar pai ao rascunho" (H §9, item 7).
5. **Status legado divergente bloqueia a transição** (`diverged`): H sugere `[AND status = $expectedLegacy]` opcional; tornei obrigatório para a máquina nunca compor uma divergência.
6. **Dual-write dos caminhos antigos NÃO implementado** (H §4.4, "flag desligada depois de ligada: quem escreve status também escreve `card_state`"). Contradiz a instrução desta tarefa ("colunas novas não lidas nem escritas por nenhum caminho antigo"), que prevaleceu. Mitigação entregue: `findCardStatusDivergences` (Q6) e o `diverged` da máquina. Ver riscos.
7. **`uq_tce_dedupe` e demais índices de `ticket_card_events`/`tickets` na `.sql`**: tabela nova/índices sobre colunas novas nulas (sem dado que possa violar) — o risco de F1 (crash-loop) não existe. O único índice que pode violar com dados existentes (`uq_tickets_draft`) vai pelo passo de boot.
8. **Testes que fixavam "5 índices"** (`evolutionUniqueness.pg.integration.test.ts`) e "seis flags" (`featureFlags.test.ts`) foram ajustados para derivar de `UNIQUENESS_INDEXES.length` / incluir `CARDS_BANCADA`.

## 4. Inventário das consultas por status (H §5.2, F14)

Método: `rg` de `FROM|JOIN projects` com `product_id|tenant_id|created_by`, leitura de cada ocorrência (≈ 70 locais) e classificação. Conferido por teste estático (§5): nenhum `status <> 'archived'`/`NOT IN (… 'archived' …)` novo sem filtro ou exceção documentada.

**Filtradas com `notHiddenProjectSql` (17 pontos):**

| Arquivo:linha | Leitor |
|---|---|
| `routes/projects.ts:160, :190, :220` | lista de projetos (3 escopos: admin, tenant, usuário) |
| `routes/dashboard.ts:143, :285, :410` | resumo, KPIs do tenant e KPIs globais (bloqueados/rodando/fila) |
| `routes/telegram.ts:448, :792, :1391` | lista resumida, lista por produto, `resolveProject` por prefixo |
| `routes/products.ts:226` | `project_count` e `HAVING` do produto solo |
| `routes/products.ts:1065, :1078` | `spec-tree` do produto (arquivos e total) |
| `routes/products.ts:1603` | `/unpromote` (conta "fábrica iniciada"; um `card_draft` não pode contar como iniciado) |
| `services/productNormalizer.ts:202, :1462` | projetos normalizáveis e contagem de arquivos da trava do `/promote` |
| `services/productContext.ts:169` | mapa do produto injetado no prompt |
| `services/productLifecycle.ts:102` | agregado do produto (sem o filtro, `accepted + card_draft` cairia no fallback `running`, F15) |
| `services/productDecomposer.ts:97` | projetos do produto por título |
| `services/productTraceability.ts:264` | relatório de rastreabilidade |

**Não alteradas, com motivo:** lista de permissão (já excluem `card_draft`): `routes/specs.ts` "Minhas SPECs" (`SPEC_LISTING_STATUSES`) e `:492-510`, `/run` e `/promote` (`routes/pipeline.ts` `ALLOWED_STATUS_FOR_RUN` e listas do `/promote`), `services/promotionPlanner.ts:169` (`draft|promoted`), `services/evolutionPromote.ts:66`, `products.ts:277` (`SPEC_DECOMPOSABLE_STATUSES`). Por pai/ticket/linhagem (`card_draft` não tem pai): `evolutionUniqueness.ts`, `evolveClaim.ts`, `evolveReconciler.ts`, `lineage.ts`. Execução: `watchdog.ts` (marcos de fábrica; `:496` fecha `pipeline_runs`), `stallEscalation.ts` (só `blocked*`/`failed`/`pending_cyborg`). Devem **contar** o rascunho: `routes/users.ts:246` (FK de usuário dono), `products.ts:1735` (contagem do DELETE do produto), `services/inbox.ts:156` (produto solo só some sem nenhum projeto), `routes/tenants.ts:144` (`projects_count` administrativo; ver riscos). Custo/telemetria (`tenantCostCap`, `costReconcile`, `dashboard` modelos/mensagens): somam por `project_id` de métricas, que o rascunho passa a ter quando o Guard debitar o chat (Fase 3). Python: **não inventariado** (fora do escopo desta fase; ver riscos).

## 5. Testes e saídas reais

Postgres efêmero `pgvector/pgvector:pg16`: **55432** (suíte completa) e **55440** (suítes novas), derrubados ao final.

```
BASELINE (dev fb96fa8, PG 55432 limpo, DATABASE_URL não definida):
  Test Files 215 passed (215) · Tests 3781 passed | 1 skipped (3782)
DEPOIS (evo/h1, mesma instrução):
  Test Files 221 passed (221) · Tests 3829 passed | 1 skipped (3830)   (+6 arquivos, +48 testes; 0 falhas)
tsc --noEmit: EXIT 0
Suítes novas/alteradas na 55440: Test Files 8 passed (8) · Tests 64 passed (64)
```
Nota: com `DATABASE_URL` definida, `src/integration.test.ts` deixa de ser vacuamente verde e falha 6 testes de login (401) — também na `dev` sem minhas mudanças. A base "215/3781" vale com `DATABASE_URL` indefinida.

| Suíte (nova) | Cobre |
|---|---|
| `services/cardState.test.ts` (5) | matriz 8×8×5 atores contra uma tabela escrita à mão (não derivada do código), terminais, `legacyStatusFor` |
| `services/cardState.pg.integration.test.ts` (9) | matriz **8×8×4 atores no banco** (`applied 25 · noop 32 · invalid 199`, total 256; inválido e repetição não escrevem nem deixam evento), ciclo completo com auditoria, filho descartado, pré-condições (`reason_required`, `child_required`, `diverged`, legado, inexistente), repetição e `dedupeKey`, corrida (8× a mesma ⇒ `applied,noop×7`; promoção × recusa ⇒ exatamente 1 vence, 1 evento), CHECKs do banco, `enterCardMachine` (flag off/on/outro tenant), rollback da transação do chamador |
| `services/cardsBackfill.pg.integration.test.ts` (8, banco descartável) | flag off não faz nada e `tenant_admin` leva 403; liga pela rota real; todos os casos de ticket/filho; `status` e `updated_at` intactos; spec_origin da linhagem v1→v2→v3; idempotência (2ª rodada = 0 alterações); leitura task→card; on→off→on; padrão global com override 0 de outro tenant |
| `services/cardDraft.readers.pg.integration.test.ts` (12, banco descartável) | controle de que o rascunho existe; CHECKs; lista de projetos, "Minhas SPECs", produtos (`project_count`), `spec-tree`, dashboard, normalizador, mapa, rastreabilidade, agregado `accepted`, `/run`/`/promote` não adotam, `/unpromote`; conjuntos de status; **guarda estática** do inventário. Verificado por mutação: removendo dois filtros, 3 testes falham |
| `db/cardsExpand.migration.pg.integration.test.ts` (6, banco descartável) | regras do runner nos 3 `.sql`, reaplicar 148–150 duas vezes sem perda de dados, esquema esperado e CHECKs, `tickets.status` sem constraint nova, `uq_tickets_draft` (sujo não cria, limpo cria, 23505), **regex de ID do `runner.py` inalterado** |
| `routes/cardsOff.regression.pg.integration.test.ts` (2) | `off`: PATCH, `/evolve` legado, tarefas e `reopenTicketsOfChild` deixam todas as colunas novas NULL/default, sem evento e sem chaves novas no GET de tasks; guarda estática de que só o código novo menciona as colunas |

Evidências `[F2-…]` impressas pelos testes: `matriz {"applied":25,"noop":32,"invalid":199,"total":256}`; `corrida-mesma ["applied","noop"×7]`; `corrida-conflito ["applied","invalid"×5,"noop"×4]`; `backfill-card-state byState {"draft":1,"rejected":1,"delivered":1,"blocked":3,"in_factory":2,"promoted":2} total 10`; `spec-origin v2 {"spec-evolution-v2.md":"card:legacy","docs/a.md":"initial","tickets/TK-0001/request.md":"card:legacy"}`.

## 6. Riscos

- **Divergência `card_state` × `status` por escritor antigo (H §4.4):** PATCH de ticket, `evolveClaim.ts`, `reopenTicketsOfChild` e DELETE de ticket continuam escrevendo só `status`. Com a flag ligada e tickets já migrados, esses caminhos podem divergir (a máquina então responde `diverged`; Q6 detecta). Não há UI de card ainda (Fase 3), mas **antes de ligar a flag em qualquer tenant com tickets** é preciso a 2.6/3.5: roteamento do PATCH pela máquina e `USE_CARD_PROMOTE` no `/evolve`.
- **Q6 não está no reconciliador:** só a função de detecção existe (`findCardStatusDivergences`).
- **Backfill é síncrono dentro do PUT da flag:** aceitável com 0 tickets em produção; com milhares, mover para job.
- **Chave `dedupeKey` em `ticket_card_events`:** vale por (ticket, destino, chave); reutilizar a mesma chave em ciclos legítimos diferentes seria tratado como replay.
- **`projects_count` administrativo (`routes/tenants.ts:144`)** conta rascunhos; ajustar se virar métrica de plano.
- **Leitores Python de `projects.status`** por lista de negação **não foram inventariados** (lacuna de H §12 continua).
- **Migrations 148–150 não foram aplicadas em produção**; antes do deploy, repetir a pré-checagem de H (runbook 6.2). 146 segue reservada à outra frente.

## 7. Fora de escopo (próximas tarefas)

2.6 (API de cards/aliases) e 3.x: criação do rascunho `card_draft` e do vínculo `draft_project_id`, escrita de `spec_origin` nos arquivos novos, rotas e portal, `GET /api/products/:id/cards/capabilities`, trava `CARD_SPEC_LOCKED`, gate/promoção do card, `USE_CARD_PROMOTE`. 4.2/4.3: preenchimento de `card_id`/`origin_spec_file` pelo runner e das colunas `executed_*`. Q6 no reconciliador. Contract (remoção do legado).
