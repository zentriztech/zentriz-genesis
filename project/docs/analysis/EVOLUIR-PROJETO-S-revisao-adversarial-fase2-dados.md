> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (S) — Revisão adversarial da Fase 2 (dados do card) e da conversão de anexos

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `dev` em `31298ad` · **Intervalo:** `git diff fb96fa8..31298ad` (44 arquivos, +3865/−28) · **Papel:** Advisor, revisor adversarial independente (tarefa 2.1 [ADV]). Só leitura no repositório. A única escrita é este arquivo.
**Base de comparação:** desenho [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) §4, §5, §6 e §8, relatório [P](EVOLUIR-PROJETO-P-fase2-dados-do-card.md) e relatório [Q](EVOLUIR-PROJETO-Q-conversao-de-anexos.md). Nada foi aceito só porque os relatórios afirmam. Cada achado traz a evidência que rodei ou a linha de código que li.
**Convenção:** os caminhos são relativos a `applications/services/api-node/src/`, salvo indicação.

---

## 1. Veredito

**APROVADO COM CORREÇÕES.**

- **O *expand* (148, 149, 150, 160) pode ir para `dev` e ser implantado com `CARDS_BANCADA` desligada.** As migrations são aditivas e idempotentes, e não encontrei comando que falhe com dados plausíveis de produção. Duas ressalvas operacionais ficam para o runbook: S-07 (fila de locks) e S-14 (pré-checagem do índice da 160).
- **A flag NÃO pode ser ligada para nenhum tenant com tickets** enquanto S-01 estiver aberto, e essa trava tem de existir **antes do deploy em produção**. Hoje um `zentriz_admin` liga a flag pelo PUT, o backfill roda, e os escritores legados passam a produzir divergência `card_state × status` no uso normal. Reproduzi isso em Postgres real.
- Antes da Fase 3 é preciso corrigir S-02 e S-03, que são falhas de desenho e de inventário: o rascunho `card_draft`, nascido como H §5.1 prescreve, quebra o `/evolve` com 500 e aparece no detalhe do produto.
- A conversão de anexos (padrão desligado) **não deve ser ligada** antes de corrigir S-04: o teto de memória da worker não cobre `Buffer`/`ArrayBuffer`.

## 2. Achados

Severidades: **BLOQUEANTE** (impede ligar a flag ou a funcionalidade), **ALTA** (defeito real que precisa de correção antes da próxima fase), **MÉDIA**, **BAIXA**.

| ID | Sev. | Arquivo:linha | Cenário de falha | Correção concreta |
|---|---|---|---|---|
| **S-01** | **BLOQUEANTE** (para ligar a flag) | `routes/runtimeConfig.ts:66, :206, :254` · `routes/tickets.ts:316-394` · `routes/projects.ts:3482` · `services/evolveClaim.ts:453` · `services/tickets.ts:319-320` | Nada impede o PUT de `CARDS_BANCADA=1` hoje. Depois do backfill, os caminhos antigos escrevem só `status`. **Reproduzido** (sonda P2, §4.3): o PATCH `rejected` deixa `[rejected, draft]`; o `/evolve` legado com o ticket do card devolve **201** e deixa `[promoted, draft]`, contornando prontidão e base do card (H §4.4 manda 409 `USE_CARD_PROMOTE`); `reopenTicketsOfChild` deixa `{status: open, card_state: in_factory}`. A partir daí a máquina responde `diverged` para sempre (`{"kind":"diverged","cardState":"draft","status":"rejected"}`), sem ferramenta de reparo, e Q6 não roda em lugar nenhum. Desligar a flag depois de ligada tem o mesmo efeito: o desvio 6 de P recusou o dual-write que H §4.4 exige | (a) **Agora, antes do deploy:** o PUT/DELETE de `CARDS_BANCADA` recusa o valor 1 com 409 `CARDS_NOT_READY` até existir a 2.6 (mesma trava para `tenant_id IS NULL`). Teste: PUT=1 ⇒ 409 e nenhum `card_state` escrito. (b) **Na 2.6:** se `card_state IS NOT NULL`, o PATCH passa pela máquina, o `/evolve` responde `USE_CARD_PROMOTE` e `reopenTicketsOfChild` grava `card_state='ready'` na mesma instrução. Isso vale **independentemente da flag**, que governa as portas de entrada e não a consistência (H §4.4, §8). (c) Q6 entra no reconciliador antes de ligar a flag em qualquer tenant |
| **S-02** | **ALTA** | `services/evolutionUniqueness.ts:59-67` (`uq_projects_ticket_live`) · `services/evolveClaim.ts:148-158` (`findExisting`) · `services/evolveReconciler.ts:213-221` · exceções em `services/cardDraft.readers.pg.integration.test.ts:184-187` | H §5.1 prescreve `extra = {card:true, ticket_id, evolution:true, …}` para o rascunho. O índice `uq_projects_ticket_live` e o `findExisting` usam `extra->>'ticket_id'` com `status NOT IN ('failed','archived')`, um filtro que **não exclui `card_draft`**. Logo o rascunho e o filho promovido disputam a mesma chave. **Reproduzido** (sonda P3): com um `card_draft` que segue H §5.1, o `/evolve` daquele ticket dá **500 `23505 uq_projects_ticket_live`**. O detector (a) do reconciliador também marcaria o rascunho como "filho órfão de ticket" (ele tem `evolution` e `ticket_id`, mas `tickets.child_project_id` não aponta para ele). A justificativa de P ("card_draft não tem pai") vale para U1/U2 e é **falsa** para as chaves por ticket | Decidir antes da 3.3. Opção A (preferida, não mexe em índice de produção): o rascunho grava `extra.card_ticket_id` e **não** `ticket_id`/`evolution`; ajustar H §5.1 (e conferir o planner de RFC, que H diz depender de `evolution:true`, F18). Opção B: recriar `uq_projects_ticket_live` com `AND status <> 'card_draft'` (nome novo, pelo passo de boot) e aplicar o mesmo filtro em `findExisting` e no reconciliador. Nas duas opções: teste de contrato "rascunho + promoção do mesmo ticket ⇒ 201" e tirar esses três arquivos da lista de exceções |
| **S-03** | **ALTA** | `routes/products.ts:961-1010` (`GET /api/products/:id`, campo `projects`) | É o leitor principal do produto (a Bancada e o detalhe do produto no portal). Ele não filtra status e **traz o `card_draft`**. **Reproduzido** (sonda P3): `["accepted","card_draft"]`. Não entrou no inventário de P nem foi pego pela guarda estática, que só procura exclusões de `'archived'` | Aplicar `notHiddenProjectSql("p")` no CTE `topo` (nível 0 e N, e na subconsulta) e no `WHERE` final. Teste em `cardDraft.readers` para `GET /api/products/:id`. Fortalecer a guarda (S-16) |
| **S-04** | **ALTA** (bloqueia ligar `ATTACHMENT_CONVERSION`) | `services/attachmentConversionRunner.ts:51` (`resourceLimits`) · `services/attachmentConverters.ts:175, :222-279` | `resourceLimits` limita o heap do V8 e **não** a memória externa (`Buffer`, `ArrayBuffer`, saída de `inflateRawSync`, buffers de streams do pdf.js). **Medido:** uma worker com `maxOldGenerationSizeMb: 64` alocou **2048 MiB** de `Buffer` sem erro (`rss=2103` MiB, §4.4). A worker divide o processo com a API, então um PDF com stream Flate "bomba" (poucos MB que inflam para GB) pode, nos 30 s do timeout, levar o container da API ao OOM-kill. Com vários tickets ao mesmo tempo, cada um ganha uma worker (teto teórico de 512 MiB de heap + externa sem limite). A bomba específica do pdf.js é **[não verificado]**; a falta de teto de memória externa foi verificada | Rodar a conversão em **processo filho** (`child_process.fork`) com teto real de memória do SO (`prlimit --as`/`ulimit -v`, ou um container/cgroup próprio) e matar o processo no timeout. Semáforo global de 1 a 2 conversões simultâneas por instância. Teste: PDF com stream Flate de razão ≥ 1000:1 ⇒ `RESOURCE_LIMIT` e API viva |
| **S-05** | **MÉDIA** | `routes/tickets.ts:64-88` (`hydrate` espalha `...r`), `:201`, `:258-259`, `:357`, `:394` (`SELECT *`/`RETURNING *`) | Contradiz P ("flag off: nenhum caminho antigo lê as colunas novas") e a regressão. Com a flag **desligada**, `GET /api/tickets/:id`, a lista, o POST e o PATCH passam a devolver `card_state, blocked_reason, origin, external_ref, draft_project_id, card_contract_version`. **Reproduzido** (sonda P1). Isso muda o contrato público, expõe códigos internos (`blocked_reason`) e cria ambiguidade com `attachments[].origin`. A guarda `routes/cardsOff.regression…:76` só olha os nomes das colunas no texto do código e por isso não vê `SELECT *` | `hydrate` monta o DTO com lista explícita de campos, ou remove as 6 chaves quando a flag está off. Na regressão: comparar as chaves de `GET /api/tickets/:id` e da lista com o conjunto anterior (o mesmo que já se faz para as tasks) |
| **S-06** | **MÉDIA** | `services/featureFlags.ts:73-110` · `services/cardsBackfill.ts:148-175` | A precedência inclui o env (`CARDS_BANCADA=1` no compose). Ligada por env, a flag vale para todo tenant sem linha de config e **o backfill nunca roda**, porque só o PUT/DELETE o dispara. O resultado é um tenant com a flag ligada e tickets `card_state NULL`, que `enterCardMachine` aceita um a um, e um estado misto | `CARDS_BANCADA` ignora o env (só config) ou o backfill roda no boot/reconciliador para todo tenant cuja flag resolve ligada. Teste com `envRaw='1'` |
| **S-07** | **MÉDIA** | `db/init.ts:39-41` (um comando por vez, sem `lock_timeout`) · `148_cards_expand.sql` | `ALTER TABLE projects DROP/ADD CONSTRAINT` e `ALTER TABLE tickets …` pedem `ACCESS EXCLUSIVE`, e a FK nova pede lock em `projects`. Se houver uma transação longa aberta (runner/agentes/psql manual), o `ALTER` espera **sem prazo**, e toda leitura de `projects` entra na fila atrás dele. A API fica sem subir e ainda trava o resto. **Medido** (§4.5): um `SELECT count(*) FROM projects` comum só terminou pelo timeout, enfileirado atrás do `ALTER`. Não há estado parcial irreparável (todo passo é `IF NOT EXISTS`/`DROP IF EXISTS` + `ADD`, e a reexecução converge). Há só a janela entre `DROP` e `ADD` do `projects_status_check`, em que um escritor externo poderia gravar um status fora da lista e fazer o `ADD` falhar na volta | `SET lock_timeout = '5s'` (e `statement_timeout`) na sessão do `initDb`, como já faz `ensureEvolutionUniqueness`. Retentar na subida em vez de travar. No runbook: conferir `pg_stat_activity` (sem `idle in transaction`) antes de recriar a api |
| **S-08** | **MÉDIA** | `db/init.ts:58` (ordem lexicográfica, só pendentes) · 146 "reservada" (P §6, O §6) | A 146 não existe em nenhuma branch local (conferido com `git ls-tree` em todas). Se chegar depois de 148/160 terem sido aplicadas em produção, roda **depois** delas em produção e **antes** delas num banco novo (dev/CI), e os esquemas finais divergem. Se a 146 redefinir `projects_status_check` com base na 141, ela **remove `card_draft`** em produção | Abandonar a reserva: a outra frente usa número ≥ 161. Teste de contrato: depois de todas as migrations, `projects_status_check` contém `card_draft` e `materializing` |
| **S-09** | **MÉDIA** | `services/cardState.ts:68-79, :170-177` · H §6 linha "ready → blocked" | (a) `ready → promoted` aceita qualquer `childProjectId`: não confere existência, tenant ou produto (`tickets.child_project_id` não tem FK, `128_tickets.sql`). (b) `blocked → in_factory` não confere "filho vivo" e `in_factory → delivered` não confere "accepted + PR"; as pré-condições de H §4.1 ficam a cargo de chamadores que ainda não existem. (c) H §6 manda `ready → blocked` (`CARD_BUDGET_BLOCKED`), mas H §4.1 e a tabela não têm essa aresta, e a máquina responderá `invalid` quando a 3.x a usar. (d) `blocked → rejected` (permitido por H) não descarta nem arquiva o filho, que segue vivo e prende `EVOLUTION_IN_FLIGHT` | (a) Validar `SELECT 1 FROM projects WHERE id=$child AND tenant_id=<do ticket> AND product_id=<do ticket>` dentro da transação. (b) Documentar no contrato da função que as pré-condições do filho são do chamador, ou aceitar um `precondition` SQL opcional. (c) Resolver a contradição em H (incluir `ready → blocked`, com ator `system`/`guard`, ou trocar §6 para "fica `ready` com 409"). (d) Definir o que acontece com o filho na recusa de um `blocked` |
| **S-10** | **MÉDIA** | `services/tickets.ts:240` → `services/attachmentConversionQueue.ts:211-219` | `drainTicketConversions` roda **inline** na materialização (`/evolve` legado e claim), em série, com até 20 conversões × 30 s, o que dá até 10 min dentro da requisição/claim. A lease do claim e os timeouts HTTP podem vencer antes | Limitar a drenagem inline a N=2 ou a um orçamento total de tempo (ex.: 20 s). O restante segue como `pending` para o worker e a spec ganha o derivado na próxima materialização ou reconciliação |
| **S-11** | **MÉDIA** | `services/cardsBackfill.ts:37-79, :148-175` · `routes/runtimeConfig.ts:206` | O backfill é síncrono dentro do PUT. No modo global, percorre **todos** os tenants, sem `statement_timeout`. Corrida: o CTE calcula `new_state` a partir do snapshot, e o `UPDATE … WHERE card_state IS NULL` só reconfere `card_state`. Um PATCH concorrente `open → rejected` no meio grava `card_state='draft'` com `status='rejected'`, ou seja, divergência nascida no backfill | `SELECT … FOR UPDATE` dos tickets do tenant no CTE ou condição `AND t.status = <status lido>` no `UPDATE` (o `status` do snapshot entra em `target`). Mover o modo global para job assíncrono com relatório |
| **S-12** | **BAIXA** | `services/cardsBackfill.ts:109-119` | Filhos de evolução anteriores a `3958bdc` (2026-09-04, quando `extra.evolution_inherited_spec` passou a ser gravado) caem no ramo "sem lista": todo não primário vira herdado/`initial`, **inclusive `tickets/TK-NNNN/request.md`**, que é do pedido. `card:legacy` também descarta o código do ticket, que existe em `extra.ticket_number` | No ramo sem lista, `rel_dir LIKE 'tickets/%'` ⇒ `card:legacy`. Avaliar `card:TK-NNNN` quando `extra.ticket_number` existir (o CHECK aceita) |
| **S-13** | **BAIXA** | `services/cardState.ts:97-119, :158` | `withTx` trata qualquer objeto com `release()` como "transação do chamador". Um `PoolClient` sem `BEGIN` faz o `FOR UPDATE` valer só para o próprio comando, e `UPDATE` e evento deixam de ser atômicos. `to === from` é `noop` mesmo se o motivo de `blocked` mudou | Exigir do chamador um parâmetro explícito (`inTransaction: true`) ou abrir sempre um `SAVEPOINT` (que falha fora de transação e, assim, denuncia o uso indevido). Atualizar `blocked_reason` num `blocked → blocked` com outro motivo (ou documentar que é ignorado) |
| **S-14** | **BAIXA** | `160_attachment_conversions.sql` (`uq_ticket_attachments_derived_name`) | Índice único sobre tabela **existente** dentro do `.sql`, o padrão que H §3.3 proíbe (F1, crash-loop). É seguro hoje porque o único conversor em produção é o nulo, que não grava derivado. Mas o caminho antigo `runAttachmentConversions` (`services/tickets.ts:205-207`) usa `WHERE NOT EXISTS`, que tem corrida, e geraria duplicatas se um conversor real fosse registrado | No runbook antes do deploy: `SELECT derived_from_attachment_id, filename, count(*) FROM ticket_attachments WHERE derived_from_attachment_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1` ⇒ 0. Remover o caminho antigo ou trocá-lo por `ON CONFLICT` |
| **S-15** | **BAIXA** | `package.json` (`pdfjs-dist ~5.5.207`, `word-extractor ^1.0.4`, `mammoth ^1.13.0`) · `Dockerfile` | (a) **GHSA-hq66-cqwq-w95j** (alta, execução de JS ao abrir PDF): faixa `>= 5.6.83, < 6.2.108`, corrigida em 6.2.108 (consulta `gh api /advisories/…`). **5.5.207 está fora da faixa**, e o `~` impede subir para 5.6. Qualquer atualização futura tem de pular direto para ≥ 6.2.108. (b) `word-extractor` sem publicação desde **2022-06-29** (`npm view time.modified`): ele analisa OLE2 não confiável em JS, e o risco fica contido só se S-04 estiver resolvido. (c) O lock tem `@napi-rs/canvas` com binário opcional. Num `node:20-alpine` limpo, `npm install pdfjs-dist@5.5.207` instalou `canvas-linux-x64-musl` e extraiu texto com sucesso (§4.6), então o impacto no Dockerfile é só tamanho. (d) `pdfjs-dist` exige `node >= 20.19`, e o `node:20-alpine` atual é 20.20.2, mas o Node 20 está fora de suporte. (e) O Dockerfile usa `npm install`, não `npm ci`: o lock não é imposto de forma estrita. Nenhum aviso encontrado para as versões fixadas de pdfjs-dist, mammoth, word-extractor, jszip, xmldom, underscore e @napi-rs/canvas (consulta `gh api /advisories?affects=…`) | Comentário no `package.json` sobre a faixa do GHSA. `npm ci` no Dockerfile. Plano de saída para o `word-extractor` (ou desligar `.doc` por padrão). Migrar para `node:22-alpine` em frente própria |
| **S-16** | **BAIXA** (qualidade dos testes) | `services/cardDraft.readers.pg.integration.test.ts:184-219` · `routes/cardsOff.regression.pg.integration.test.ts:74-78` | As guardas passam sem provar. (1) A de leitores só procura exclusões de `'archived'`, então consulta **sem filtro** de status escapa (S-03). (2) As exceções valem para o **arquivo inteiro** (`routes/projects.ts`, `routes/telegram.ts` e outros), então qualquer `<> 'archived'` novo nesses arquivos passa. (3) A janela de ±4 linhas aceita um `notHiddenProjectSql` de outra consulta próxima. (4) A de colunas não cobre `blocked_reason`, `external_ref`, `origin`, `executed_at`, nem `SELECT *` (S-05) | Inventário por **consulta**: cada `FROM/JOIN projects` com `product_id`/`tenant_id`/`created_by` vira lista explícita "filtrada / exceção com motivo" com chave `arquivo:hash da consulta`. Exceções por ocorrência e não por arquivo. Teste de chaves da resposta para tickets |

**Contagem:** BLOQUEANTE 1 · ALTA 3 · MÉDIA 7 · BAIXA 5 (16 achados).

## 3. Inventário corrigido das consultas por status (`card_draft`)

Método: `rg` por `status\s*(NOT IN|<>|!=)` em `src/` (sem testes), mais `rg -U` de `FROM|JOIN projects … (product_id|tenant_id|created_by) =` (≈ 150 ocorrências, leitura de cada uma fora as já classificadas em P), mais leitura do Python (`applications/orchestrator`, `services/api-python`, `agents`).

### 3.1 Confirmado com filtro (P, conferido)
`routes/projects.ts` (3 listas), `routes/dashboard.ts` (3), `routes/telegram.ts` (3), `routes/products.ts:226, :1064-1078, :1603`, `services/productNormalizer.ts:199-202, :1461`, `services/productContext.ts:168`, `services/productLifecycle.ts:100-102`, `services/productDecomposer.ts:97`, `services/productTraceability.ts:264`.

### 3.2 Faltam (enxergam `card_draft` indevidamente)

| Arquivo:linha | Leitor | Efeito | Status |
|---|---|---|---|
| `routes/products.ts:961-1010` | `GET /api/products/:id` → `projects[]` (Bancada/portal) | rascunho listado como projeto (versão 0) | **reproduzido** (S-03) |
| `services/evolutionUniqueness.ts:59-67` | índice `uq_projects_ticket_live` | 23505 na promoção se o rascunho levar `extra.ticket_id` | **reproduzido** (S-02) |
| `services/evolveClaim.ts:148-158` | `findExisting` (replay por ticket) | adotaria o rascunho como "filho existente" do ticket | inferido pelo código (S-02) |
| `services/evolveReconciler.ts:213-221` | detector de filho órfão de ticket (a) | falso achado para todo rascunho com `evolution`+`ticket_id` | inferido pelo código (S-02) |

### 3.3 Corretamente fora do filtro (motivo)
- **Lista de permissão:** `routes/specs.ts` (Minhas SPECs, `:492-510`), `routes/pipeline.ts` (`/run`), `services/promotionPlanner.ts:169`, `services/evolutionPromote.ts:66`, `routes/products.ts:278`, `services/projectCreation.ts:176` (`accepted, completed`), `services/specValidation.ts:1553` (auto-validação: lista sem `card_draft`, ou seja, o rascunho **não** é autovalidado; decidir na 3.x se deveria), `services/watchdog.ts:82, :410, :572` (`running`/`failed`/`queued`), `services/stallEscalation.ts:100`, `routes/dashboard.ts:295` (`STATUS_IN_FACTORY`).
- **Por pai/linhagem (rascunho sem pai):** `uq_projects_parent_version_live`, `uq_projects_one_live_evolution_child`, `services/lineage.ts:92`, `routes/projects.ts:3500`, `services/evolveClaim.ts:327`, `services/productLifecycle.ts:103-106` (subconsulta de irmãos por pai).
- **Por id:** `routes/deadpool.ts:171/491/691`, repositório GitHub (`routes/projects.ts:1228, :3664`, `services/provision/*`, `services/s3StaticDeploy.ts:81`, `services/postMerge/*`, `services/evolveClaim.ts:862`), `routes/products.ts:609, :1863, :1980, :2044-2080`.
- **Devem contar o rascunho:** custo e telemetria (`services/tenantCostCap.ts:70, :115`, `services/costReconcile.ts:72`, `services/watchdog.ts:199`, `routes/dashboard.ts:315` e `:326`): o custo do chat do rascunho é real e precisa entrar no teto do tenant. Também `routes/users.ts:246`, `routes/products.ts:1736` (DELETE), `services/inbox.ts:156` e `routes/tenants.ts:144` (`projects_count` administrativo; ajustar se virar métrica de plano).
- **Status de outra entidade:** tarefas (`DONE/QA_PASS/CANCELLED`), deploys (`destroyed`), cobrança (`canceled`), oráculo (`pending`).

### 3.4 Python
`rg` não encontrou SQL sobre `projects`/`tickets` em `applications/orchestrator`, `services/api-python` e `agents` (os usos de `psycopg` são de lições/skills/seed). O Python só lê projetos pela API: `zentriz_cyborg.py:489, :913, :941` usam `GET /api/projects`, que já está filtrado, e `GET /api/projects/:id`. **Nenhum leitor Python passa a enxergar `card_draft`.** A lacuna de H §12 / P §6 fica fechada para SQL direto. O portal (`applications/apps/genesis-web`) consome `GET /api/products/:id` e mostraria o rascunho até S-03 ser corrigido **[inferido; portal não lido]**.

### 3.5 Efeitos agregados (pergunta 3)
- **Estado agregado do produto:** filtrado (`productLifecycle.ts:102`, teste `accepted + card_draft ⇒ accepted` passou).
- **Minhas SPECs:** lista de permissão, teste passou.
- **Contagem de versões e `/versions`:** por pai, não afetado.
- **Cap/orçamento:** soma por métricas e inclui o rascunho, o que está correto.
- **Watchdog/autonomia:** listas de permissão; o rascunho não entra em `queued/running/failed`.
- **`SPEC_EDITABLE_STATUSES` com `card_draft`:** abre `specSplit`, `connectDeclaration`, `evolutionPlan`, `specAutonomy` e `productNormalizer` para o rascunho **sem** a trava `CARD_SPEC_LOCKED` (prevista para a 3.x). Não tem efeito enquanto nenhum rascunho existir.

## 4. O que rodei (comandos e saídas reais)

Ambiente: container efêmero `rev2-pg` (`pgvector/pgvector:pg16`, porta **55442**). Cópia temporária de `api-node` em `/tmp/rev2/api-node` (rsync sem `node_modules`, com link simbólico para o `node_modules` do repositório), onde **só a cópia** de `src/testing/evolvePg.ts` e de `scripts/apply-migrations-test.ts` passou a aceitar a porta 55442. Repositório intocado. Container e cópia removidos ao final.

### 4.1 Migrations
```
DATABASE_URL=postgres://postgres:test@localhost:55442/postgres npx tsx scripts/apply-migrations-test.ts
[DB] Migration applied: 148_cards_expand
[DB] Migration applied: 149_project_spec_files_origin
[DB] Migration applied: 150_project_tasks_card
[DB] Migration applied: 160_attachment_conversions
```
Índices depois do boot de teste (`pg_indexes`): presentes `uq_tickets_draft`, `uq_tce_dedupe`, `uq_ticket_attachments_derived_name`, `uq_projects_ticket_live` e os demais U1/U2.

### 4.2 Suítes da entrega (cópia, PG 55442)
```
PG_TEST_URL=…:55442/postgres npx vitest run cardState.test.ts cardState.pg… cardsBackfill.pg… cardsExpand.migration.pg…
  cardDraft.readers.pg… cardsOff.regression.pg… attachmentConversionQueue.pg… attachmentConverters.test.ts
  evolutionUniqueness.pg… featureFlags.test.ts
```
Na primeira rodada (antes de migrar o banco), 13 falhas por `relation "tenants" does not exist`, um artefato meu. Depois de migrar, todas as suítes passaram, com **uma exceção**: `cardsExpand … regex de ID de task do runner` falhou com `ENOENT '/tmp/orchestrator/runner.py'`. É artefato da cópia (o caminho relativo sai do repositório) e não defeito da entrega. Evidências impressas iguais às de P: `[F2-matriz] {"applied":25,"noop":32,"invalid":199,"total":256}`, `[F2-corrida-mesma] ["applied","noop"×7]`, `[F2-corrida-conflito] ["applied","invalid"×5,"noop"×4]`, `[F2-backfill-card-state] … {"draft":1,"rejected":1,"delivered":1,"blocked":3,"in_factory":2,"promoted":2} total 10`.

### 4.3 Sonda adversarial (arquivo só na cópia: `src/routes/zrev2.probe.pg.integration.test.ts`)
```
[S-P1] 200 ["card_state","blocked_reason","origin","external_ref","draft_project_id","card_contract_version"]   ← flag OFF, GET /api/tickets/:id
[S-P2-backfill] [{"draft":3}]
[S-P2-legado] 200 201 [["rejected","draft"],["promoted","draft"]]    ← PATCH legado e /evolve legado com a flag ON
[S-P2-maquina] {"kind":"diverged","cardState":"draft","status":"rejected"} divergencias 2
[S-P2-reopen] 1 {"status":"open","card_state":"in_factory"}
[S-P3-evolve] ok 500 {"statusCode":500,"code":"23505",…"uq_projects_ticket_live"}   ← card_draft com extra.ticket_id (H §5.1)
[S-P3-produto] 200 ["accepted","card_draft"]                                          ← GET /api/products/:id
```

### 4.4 Teto de memória da worker
```
node /tmp/rev2/w.mjs   # Worker com resourceLimits {maxOldGenerationSizeMb: 64}, aloca 8 × Buffer.alloc(256 MiB)
worker: alloc 2048MiB rss=2103
```

### 4.5 Fila de locks da migration
Sessão A: `BEGIN; SELECT count(*) FROM projects; SELECT pg_sleep(8)`. Sessão B: `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_card_draft_shape_check` (statement_timeout 4 s). Sessão C: `SELECT count(*) FROM projects` (statement_timeout 2 s).
```
ERROR:  canceling statement due to statement timeout   (C, enfileirado atrás de B)
ERROR:  canceling statement due to statement timeout   (B, esperando A)
```
Sem `statement_timeout`/`lock_timeout` (caso do `initDb`), B e C esperariam indefinidamente.

### 4.6 Dependências
```
gh api /advisories/GHSA-hq66-cqwq-w95j → high · pdfjs-dist ">= 5.6.83, < 6.2.108" · patched 6.2.108
gh api "/advisories?ecosystem=npm&affects=<pkg>@<ver>"  → vazio para pdfjs-dist@5.5.207, mammoth@1.13.0, word-extractor@1.0.4,
                                                          jszip@3.10.2, @xmldom/xmldom@0.8.15, underscore@1.13.8, @napi-rs/canvas@0.1.100
npm view word-extractor time.modified → 2022-06-29T03:10:16.162Z (1.0.4 = latest)
jq package-lock.json → pdfjs-dist 5.5.207 (engines node >=20.19.0), @napi-rs/canvas 0.1.100 optional (+ linux-x64-musl)
docker run node:20-alpine node -v → v20.20.2
docker run node:20-alpine: npm install --omit=dev pdfjs-dist@5.5.207 → node_modules/@napi-rs/{canvas,canvas-linux-x64-musl}; getTextContent → "TEXT: Ola alpine"
```
A imagem local `zentriz-genesis-api:latest` é anterior às dependências novas (não as contém). Não construí a imagem nova.

### 4.7 Leituras dirigidas
`git diff fb96fa8..31298ad` completo dos arquivos de serviço, rota e migration; `db/init.ts`; `141`, `128`, `143`; `ticketTransitions.ts`; trechos de `evolveClaim.ts`, `evolveReconciler.ts`, `lineage.ts`, `watchdog.ts`, `specValidation.ts`, `products.ts`; `git ls-tree` de todas as branches locais em busca de 146/151-159 (nenhuma).

## 5. Respostas às perguntas da tarefa (resumo)

1. **Expand seguro?** Sim, quanto a dados: são aditivas, os `ADD COLUMN` usam default constante (`'manual'`, sem reescrita no PG ≥ 11), os CHECKs se aplicam a colunas novas ou a um superconjunto, e a reexecução converge. Os riscos são operacionais (S-07, lock sem prazo), de ordem (S-08, 146) e de índice em tabela existente (S-14). Não achei estado parcial irreparável: cada passo pode ser reaplicado.
2. **Coexistência:** o mapeamento está certo e está escrito no mesmo `UPDATE` da máquina. **A recusa do dual-write é segura só enquanto nenhum ticket tem `card_state`.** Com a flag nunca ligada, sim. Com a flag ligada ou ligada e depois desligada, não (S-01, reproduzido). A divergência é detectável (`findCardStatusDivergences`), mas ninguém a executa.
3. **`card_draft`:** o inventário de P tem 4 furos (§3.2). Python não é afetado (§3.4).
4. **Backfill:** é idempotente (2ª rodada = 0, conferido pelo teste da entrega). É síncrono no PUT, com corrida (S-11). A heurística de `spec_origin` erra em filhos antigos (S-12).
5. **Máquina:** a tabela confere com H §4.1. A idempotência sob corrida é real (`FOR UPDATE` + CAS; 8× ⇒ 1 applied). A auditoria fica na mesma transação. `blocked` é retomável (`→ in_factory`, `→ ready`, `→ rejected`). `rejected` e `delivered` são terminais (sem aresta de saída, confirmado na matriz 8×8). Lacunas em S-09 e S-13.
6. **Flag:** `adminOnly` está implementado (403 para `tenant_admin`, teste passou). A precedência é tenant > global > env, com o furo do env sem backfill (S-06). Não existem rotas de card para responder 404. Com off, há leitura indevida das colunas novas pelas rotas de ticket (S-05).
7. **Anexos:** contagem de entradas, tamanhos declarados, razão e descompressão real com `maxOutputLength` são todos verificados **antes** do mammoth (correto, `attachmentConverters.ts:148-185`). Mídia (`word/media/`) só passa pelo tamanho declarado, o que é aceitável porque nunca é lida. O teto de memória da worker é ineficaz para memória externa (S-04). pdfjs está fora da faixa do GHSA (S-15). Sem `ATTACHMENTS_STRICT=on`, nada converte (por desenho).
8. **Testes que cumprem sem provar:** S-16 e S-05.
9. **O que falta antes de ligar a flag para um tenant com tickets (2.6/3.5):** S-01 inteiro (roteamento do PATCH, `USE_CARD_PROMOTE`, `reopenTicketsOfChild` com `card_state`, DELETE que arquiva o rascunho, Q6 no reconciliador), S-02 (decisão sobre `extra` do rascunho), S-03, S-05, S-06, S-11, uma ferramenta de reparo de divergência (transição administrativa auditada `diverged → <estado coerente>`), e um ensaio do backfill numa cópia do banco de produção, com contagem por estado conferida antes e depois.

## 6. Lacunas desta revisão

- **[não verificado]** Bomba Flate de PDF dentro do pdf.js 5.5.207. Medi apenas que a worker não limita memória externa e não construí o PDF hostil.
- **[não verificado]** Build da imagem `api` com o lockfile novo (`npm install` + `npm run build` no Alpine). Conferi só a instalação isolada do pdfjs-dist e a extração de texto.
- **[não verificado]** Dados de produção: contagem de tickets por status, duplicatas para `uq_ticket_attachments_derived_name` e transações longas. Nada foi consultado em `3.220.66.113`.
- **[não verificado]** Portal (`genesis-web`): não li como ele renderiza `projects[]` e o objeto do ticket com as chaves novas.
- A suíte completa (221 arquivos) não foi rodada por mim. Rodei as 10 suítes novas ou alteradas e a sonda.
- O teste do regex do `runner.py` não rodou na cópia (artefato de caminho). A conferência dele vale só pelo relatório P.
