> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (R) — Fase 2: API de cards (tarefa 2.6)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/i1` (a partir da `dev`, sobre o merge `31298ad` da Fase 2 dados do card + conversão de anexos) · **Worktree:** `.worktrees/g-i1` · **Papel:** executor. Sem produção, sem push, sem deploy, Guard intocado, sem PII.
**Desenho:** [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) §4 (máquina), §5 (`card_draft`), §6 (orçamento); [I](EVOLUIR-PROJETO-I-fase1-claim-indices-orcamento.md), [K](EVOLUIR-PROJETO-K-fase1-transicoes-e-promocao.md), [L](EVOLUIR-PROJETO-L-fase1-reconciliador.md), [N](EVOLUIR-PROJETO-N-correcoes-fase1-motor.md), [O](EVOLUIR-PROJETO-O-correcoes-fase1-seguranca-flags.md), [P](EVOLUIR-PROJETO-P-fase2-dados-do-card.md), [Q](EVOLUIR-PROJETO-Q-conversao-de-anexos.md).
**Convenção:** caminhos relativos a `applications/services/api-node/src/`. **Estado:** preparado e validado em Postgres efêmero; **não funcional em produção** (nada implantado; `CARDS_BANCADA` desligada em todo lugar). Só api-node e testes; a UI é a Fase 3.

## 1. Commits (locais, em `evo/i1`)

| Commit | Conteúdo |
|---|---|
| `e8a9a60` | Gate de RFC do card por tipo (`evolutionGate.ts`) + teste unitário (2.6 f) |
| `a35fea8` | `services/cardService.ts`, `services/cardPromote.ts`, `routes/cards.ts`, adaptação de `services/evolveClaim.ts` (parâmetro `card`), registro em `app.ts`, chaves em `routes/runtimeConfig.ts`, gancho em `services/opsNotify.ts` (2.6 a–c) |
| `3453023` | Escritores legados roteados pela máquina (`routes/tickets.ts`, `routes/projects.ts`, `services/tickets.ts`), Q1/Q6 no reconciliador (`services/evolveReconciler.ts`), suíte `routes/cards.pg.integration.test.ts`, guarda estática atualizada (2.6 d, e) |
| (este relatório) | documentação |

## 2. Contrato da API

Todas exigem autenticação. **Flag:** `CARDS_BANCADA` do tenant do recurso (precedência tenant > global > env). A autorização por tenant/produto vem **antes** da flag (outro tenant recebe o 404 de sempre); flag off ⇒ `404 {code:"NOT_FOUND", message:"Recurso indisponível"}` (como M-19). Mutações: `zentriz_admin` ⇒ 403 `MANAGEMENT_ACCOUNT_READONLY_CREATE`; token de serviço (`svc=runner`) ⇒ 403 `FORBIDDEN`.

| Rota | Entrada | Saída |
|---|---|---|
| `GET /api/products/:productId/cards/capabilities` | — | `200 {cardsBancada: boolean}` (sempre 200 para quem tem acesso ao produto) |
| `POST /api/products/:productId/cards` | json ou multipart: `kind` (`evolution`\|`fix`\|`feature`; alias `changeKind`), `title?`, `body` (≤ 20 000), `projectId?` (qualquer versão da linhagem-alvo), anexos opcionais (`files`) | `201` resumo do card + `body` |
| `GET /api/products/:productId/cards` | `?state=a,b&kind=&origin=manual\|import&limit=&offset=` | `200 {items[], total, limit, offset}`; só tickets com `card_state` (legados não entram) |
| `GET /api/cards/:id` | — | resumo + `body`, `attachments[]` (+ `downloadUrl`), `events[]` (50 últimos), `base {headProjectId, headVersion, validatedAt}`, `actions {edit, refine, ready, promote, revalidate, reject, resume, delete}` |
| `PATCH /api/cards/:id` | `title?`, `body?`, `kind?` | `200` resumo. Só `draft\|refining`. Reescreve `tickets/TK-NNNN/request.md` do rascunho; `draft → refining` na 1ª escrita |
| `POST /api/cards/:id/refine` | — | `200 {ok, replayed, card}`; `draft\|ready → refining` |
| `POST /api/cards/:id/ready` | — | `200 {ok, replayed, card, gate{rfcs, scope, compat, kind}}`; "Validar": gate invariante + tipo + orçamento + base registrada; grava `extra.card_ready` no rascunho e faz `draft\|refining → ready` |
| `POST /api/cards/:id/reject` | — | `200 {ok, replayed, card}`; `draft\|refining\|ready\|blocked → rejected` |
| `POST /api/cards/:id/resume` | — | `blocked`: filho na fábrica ⇒ `in_factory`; filho morto/inexistente ⇒ `ready` (vínculo limpo) |
| `POST /api/cards/:id/revalidate` | — | `200 {ok, card, base{headProjectId, headVersion, previousHeadProjectId}, next, message}`; rebasea o rascunho para o HEAD corrente, invalida `card_ready`, `ready → refining` |
| `POST /api/cards/:id/promote` | — | `201` (criado) · `200 {replayed:true}` / `{resumed:true}`; corpo do claim (`childProjectId, parentProjectId, versionNumber, workMode, inheritedFiles…`) + `cardId, cardState, cardStatus, draftProjectId` |
| `DELETE /api/cards/:id` | — | `204`; só `draft` (CAS `WHERE card_state='draft' AND status='open'`); remove o rascunho junto |
| `GET /api/cards/:id/base-spec` | — | `200 {readOnly:true, headProjectId, headVersion, title, specHash, baseHeadProjectId, stale, files[{path, relDir, filename, isPrimary, sizeBytes, contentSha256, content, truncated}]}`; não existe rota de escrita |
| `GET /api/cards/:id/attachments/:attachmentId` | — | download (mesmas regras de `/api/tickets/...`) |

**Alias de leitura:** as rotas de ticket continuam servindo os cards (`SELECT *` já devolve `card_state`, `draft_project_id`… desde a Fase 2); nada no contrato antigo foi renomeado ou removido.

**Códigos de erro (além de 400 `BAD_REQUEST`, 404 `NOT_FOUND`, 403):**

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `ATTACHMENT_INVALID` (`errors[]`), `ATTACHMENT_UNREADABLE`, `SERVICE_REQUIRED` (+`services[]`) | anexos fora da allowlist/teto; produto com mais de um serviço sem `projectId` |
| 402 | `BUDGET_MISSING`, códigos do Guard, `BUDGET_FREE_BELOW_MIN` (+`freeUsd`, `minFreeUsd`) | sem dono de orçamento na criação; Guard/saldo livre mínimo em `ready` e `promote` (o card **não** muda de estado) |
| 409 | `CARD_INVALID_TRANSITION` (`from,to,allowed`), `CARD_DIVERGED`, `CARD_NOT_EDITABLE`, `CARD_NOT_DELETABLE`, `CARD_NOT_READY` (`state`), `CARD_BASE_STALE` (`expectedHead, currentHead, revalidate`), `CARD_CHILD_NOT_IN_FACTORY`, `CARD_DRAFT_UNREADABLE`, `NO_ACCEPTED_HEAD`, `PRODUCT_ARCHIVED`, `ATTACHMENTS_UNAVAILABLE` | regras de estado |
| 409 | `EVOLUTION_RFC_REQUIRED`, `EVOLUTION_RFC_INVALID` | gate base (invariante nos 3 tipos) |
| 409 | `CARD_KIND_MISMATCH` | Correção com compat > patch |
| 409 | `CARD_KIND_REQUIREMENT` (`details.missing`: `repro_scenario` \| `non_goals`) | Correção sem cenário de reprodução; Recurso novo sem `Non-goals` |
| 409 | `EVOLUTION_IN_FLIGHT`, `MATERIALIZATION_IN_PROGRESS` (+`Retry-After`), `EVOLUTION_BUSY` | herdados do claim |
| 422 | `CARD_DRAFT_UNREADABLE` (falha terminal da materialização; card ⇒ `blocked`), demais terminais do claim (`HEAD_SPEC_UNREADABLE`, `CODE_BASE_UNAVAILABLE`, `ATTACHMENT_UNREADABLE`) | |
| 500 | `MATERIALIZATION_FAILED` | erro transitório; repetir retoma |

**Rotas antigas com card:** `PATCH /api/tickets/:id` (card ⇒ pela máquina, resposta no formato do ticket; `delivered` ⇒ 409 `CARD_DELIVERY_IS_AUTOMATIC`; texto depois de promovido ⇒ 409 `TICKET_IMMUTABLE`, como antes), `DELETE /api/tickets/:id` (card ⇒ só `draft`, leva o rascunho), `POST /api/projects/:id/evolve` com `ticketId` de card ⇒ **409 `USE_CARD_PROMOTE`** `{cardId}`.

## 3. Diagrama de sequência da promoção

```mermaid
sequenceDiagram
  autonumber
  participant U as Usuário
  participant R as routes/cards.ts
  participant P as cardPromote.promoteCard
  participant C as evolveClaim (claim + materialize)
  participant M as cardState.transitionCard
  participant DB as Postgres
  U->>R: POST /api/cards/:id/promote
  R->>P: card (tenant/flag já checados)
  P->>DB: lê rascunho (card_ready) — hash da spec do rascunho == carimbo?
  alt hash diferente ou carimbo ausente
    P->>M: ready → refining (system)
    P-->>U: 409 CARD_NOT_READY
  end
  P->>DB: HEAD corrente == base registrada (+ hash da spec do HEAD)?
  alt HEAD andou
    P->>M: ready → refining (system, base_stale)
    P-->>U: 409 CARD_BASE_STALE + POST /api/cards/:id/revalidate
  end
  P->>C: runEvolveWithClaim(parentId = base registrada, card)
  C->>DB: orçamento: Guard + saldo livre mínimo (fora do lock) — negativa ⇒ 402, card segue ready
  C->>DB: BEGIN + advisory lock da linhagem
  C->>DB: idempotência (ticket) · ticket FOR UPDATE (card_state = ready) · HEAD == base? (senão CARD_BASE_STALE) · filho vivo? (EVOLUTION_IN_FLIGHT) · vN = HEAD+1
  C->>DB: INSERT filho 'materializing' (dono TERMINAL do orçamento)
  C->>M: ready → promoted (user, child, dedupeKey = claim_id) na MESMA transação
  C->>DB: COMMIT (conexão devolvida ao pool)
  loop passos idempotentes com lease e heartbeat
    C->>DB: spec_tree (copia a árvore do HEAD) · code (clone/branch evolution/vN) · ticket (request.md + anexos)
    C->>DB: card_spec (move RFCs/documentos do rascunho; spec_origin = card:TK-NNNN) · triages · dialogue
  end
  C->>DB: finalize (CAS: status + claim_id + lease + ticket promoted→filho) → spec_submitted
  C-->>U: 201 {childProjectId, versionNumber, cardState: promoted}
  Note over DB,M: filho entra na fábrica (scheduleFactoryStart) ⇒ syncCardWithChild: promoted → in_factory
  Note over C,M: falha terminal ⇒ filho failed + card promoted|in_factory → blocked (materialization_failed:CODE); resume ⇒ ready
```

## 4. Decisões e desvios de H

1. **Rascunho usa `extra.card_ticket_id`, não `extra.ticket_id` (desvio de H §5.1 e do enunciado).** O índice único parcial `uq_projects_ticket_live` (`evolutionUniqueness.ts`) rejeita dois projetos vivos com o mesmo `extra->>'ticket_id'`; o rascunho (`card_draft` não é `failed/archived`) impediria o INSERT do filho na promoção. O vínculo oficial ticket ↔ rascunho é `tickets.draft_project_id`. Também mantém o rascunho fora do detector `child_ticket_mismatch` e de `findExisting`.
2. **Rascunho `card_draft`:** `parent_project_id NULL`, `version_number 0`, `budget_owner_project_id` = dono **terminal** do HEAD (`resolveBudgetAnchor`, exportada do claim), `extra = {card, evolution:true, card_ticket_id/number/kind, evolution_parent_id, card_target_root_id, card_base, card_ready?}`. Só `tickets/TK-NNNN/request.md` + anexos de texto; `spec_origin = card:TK-NNNN`. Sem cópia de árvore, sem `apps/`, sem clone (teste prova).
3. **Promoção insere um filho novo** (H §5.1): o rascunho fica `card_draft` para sempre como histórico. "Mover a spec do card" = passo novo `card_spec` (copia para o filho tudo que o rascunho tem fora de `tickets/TK-NNNN/`, que o passo `ticket` regenera), idempotente, `spec_origin = card:TK-NNNN`. A base vencida é detectada **duas vezes**: fora do lock (barato, devolve o card a `refining`) e dentro do lock do claim (HEAD ≠ base registrada ⇒ `CARD_BASE_STALE`).
4. **Carimbo `card_ready`** = `{draft_spec_hash, base_head_project_id, base_head_version, base_spec_hash, at}` (H §5.4). A promoção recalcula o hash da spec do rascunho: **qualquer escrita no rascunho depois do "pronto" (por qualquer escritor de spec) invalida a promoção** (`CARD_NOT_READY`, volta a `refining`). Isso substitui, nesta fase, a trava `CARD_SPEC_LOCKED` dos escritores (Fase 3).
5. **Orçamento negado não bloqueia o card (desvio de H §6).** H diz "`ready → blocked` com `budget:<código>`", mas a tabela de H §4.1 (e `cardState.ts`) não tem `ready → blocked`. Mantive a tabela: 402 com o código do Guard/`BUDGET_FREE_BELOW_MIN` e o card segue `ready`. O saldo livre mínimo reaproveita `EVOLVE_MIN_FREE_BUDGET_USD` (config; nenhum valor de dinheiro no código).
6. **Falha terminal ⇒ `blocked`, não "reabre"** (H §4.1): `failTerminal` grava `promoted|in_factory → blocked` (`materialization_failed:<CODE>`); `resume` com filho morto faz `blocked → ready` (vínculo limpo) e a promoção segue do zero (novo filho; número de versão reaproveitado). Claim vencido **sem efeitos** (Q1 do reconciliador) ⇒ `promoted → ready`. `reopenTicketsOfChild` ⇒ `ready` (nunca reabre `delivered`).
7. **`USE_CARD_PROMOTE` por dado, não por flag:** vale quando o ticket já tem `card_state` (se a flag fosse desligada depois, o `/evolve` legado ainda divergiria `card_state` de `status`). Também protegido dentro do claim (inclusive sob lock). Ticket legado: caminho idêntico (teste byte a byte).
8. **`promoted → in_factory`:** `scheduleFactoryStart` (único ponto pós-`/run`) chama `syncCardForChildProject` por `import()` dinâmico (best-effort). `syncCardWithChild` também leva filho `failed/archived` a `blocked`. Esperas humanas (`blocked_cyborg`, `needs_spec_input`, `stopped`) **não** bloqueiam o card (H §4.1); `stopped_by='budget' ⇒ blocked` **não** foi implementado (fica para a 4.x).
9. **Anexos de card exigem `ATTACHMENTS_STRICT` ligada** (senão 409 `ATTACHMENTS_UNAVAILABLE`): é ela que mantém pdf/doc/docx fora da árvore de texto da spec. Ligar `CARDS_BANCADA` e `ATTACHMENTS_STRICT` juntas. Conversão pdf/doc/docx → `.md` (flag própria) é disparada em segundo plano; o derivado chega ao rascunho no próximo `PATCH` (que regrava a pasta do card) ou na promoção (passo `ticket`).
10. **Tipo do card = `tickets.change_kind`** (`evolution\|fix\|feature`); chega à Fábrica por `extra.ticket_kind` do filho (já existia) e o rótulo vai no cabeçalho da spec (`(TK-0001 · correção)`, teste). Cenário de reprodução reconhecido por linha de cenário contendo reprodução/reproduction/regressão **dentro dos critérios/requisitos**, ou a marca `FAIL_TO_PASS` (prosa solta não conta).
11. **Paginação e teto da spec-base são configuração** (`CARDS_LIST_PAGE_DEFAULT`, `CARDS_LIST_PAGE_MAX`, `CARD_BASE_SPEC_MAX_BYTES` em `genesis_runtime_config`, registradas em `CONFIG_KEYS`); os números do código (20/100/1 MB) só valem sem a chave (calibrado=falso). Sem migration nova.
12. **Guarda estática da Fase 2** (`cardsOff.regression…`): a lista de arquivos que podem mencionar as colunas novas ganhou os arquivos novos de card e os cinco escritores roteados (`routes/tickets.ts`, `routes/projects.ts`, `services/tickets.ts`, `services/evolveClaim.ts`, `services/evolveReconciler.ts`). A regressão `off` (colunas novas intocadas) continua verde.

## 5. Testes e saídas reais

Postgres efêmero `pgvector/pgvector:pg16`: **55432** (suíte completa) e **55440** (suítes novas), migrations aplicadas por `scripts/apply-migrations-test.ts`; ambos derrubados ao final. Suíte completa com `DATABASE_URL` indefinida (ver nota em P §5).

```
BASELINE (dev + merge 31298ad, PG 55432):  Test Files 223 passed (223) · Tests 3866 passed | 1 skipped (3867)
DEPOIS   (evo/i1, mesma instrução):        Test Files 225 passed (225) · Tests 3895 passed | 1 skipped (3896)   (+2 arquivos, +29 testes, 0 falhas)
tsc --noEmit: EXIT 0
Suítes de 2.6 na 55440 (cards.pg + gate por tipo + regressão off): Test Files 3 passed (3) · Tests 31 passed (31)
```

| Suíte | Cobre |
|---|---|
| `services/evolutionGate.cardKinds.test.ts` (6, sem banco) | exigências por tipo sobre RFCs parseados: Evolução sem extra; Correção (reprodução, compat > patch, a mais alta manda); Recurso novo (`Non-goals`); prosa solta não conta |
| `routes/cards.pg.integration.test.ts` (23, Postgres real) | flag off (404 em todas as rotas; capabilities false); **ticket legado idêntico com a flag on/off** (6 respostas normalizadas); autorização por tenant e conta de gestão; **ciclo completo** criar → refinar → pronto → promover → in_factory; **corrida de 6 promoções ⇒ 1 filho**; **2 cards: v2 e v3, `EVOLUTION_IN_FLIGHT`, `CARD_BASE_STALE` até revalidar**; spec do rascunho alterada depois do "pronto"; **crash antes de `card_spec` ⇒ retomada** com lease vencido; falha terminal ⇒ `blocked` ⇒ `resume` ⇒ nova promoção; gates por tipo; tipo `fix` no filho; orçamento (sem dono, saldo mínimo); serviço (`SERVICE_REQUIRED`); listagem/filtros/paginação/teto de página por config; transições idempotentes e inválidas; exclusão com CAS (corrida delete × refine); PATCH/DELETE legados pela máquina; `USE_CARD_PROMOTE` (EVOLVE_CLAIM on/off); `reopenTicketsOfChild` e Q1; **Q6 (divergência) no reconciliador, sem limpeza automática**; spec-base somente leitura (+`stale`, teto por config); anexos (txt na pasta do card, pdf só no card, promoção leva os de texto) |

Evidências `[F2-6-…]` impressas: `ciclo {"eventos":["draft","refining","ready","promoted","in_factory"],"versao":2,"arquivosDoFilho":3}`; `corrida-mesmo-card {"respostas":[201,409,409,409,409,409]}` (os 409 são `MATERIALIZATION_IN_PROGRESS`); `sequencia {"v":[2,3],"staleCode":"CARD_BASE_STALE"}`; `crash-retomada {"passos":["code","ticket","triages","_started","dialogue","card_spec","spec_tree"]}`; `gates` (sem RFC ⇒ `EVOLUTION_RFC_REQUIRED` e RFC vago ⇒ `EVOLUTION_RFC_INVALID` nos 3 tipos); `reabertura {"eventos":["draft","ready","promoted","in_factory","ready"]}`; `q6 {"achados":1}`; `delete-corrida` (ora `deleted`, ora `refined`; nunca os dois).

Nota de teste: o job do reconciliador usa lock de sessão por banco; a suíte de cards repete a passada se outro arquivo a segura (`skipped:"locked"`), para não ficar intermitente na execução paralela.

## 6. Riscos

- **Escritores de spec ainda não conhecem o card (`CARD_SPEC_LOCKED` é Fase 3):** `spec-files`, `spec-content`, Chat e planner podem escrever no rascunho em qualquer estado do card (`card_draft` ∈ `SPEC_EDITABLE_STATUSES`), inclusive depois de promovido (o rascunho é histórico). A promoção é protegida pelo hash do carimbo; a escrita **não** faz `draft/ready → refining` sozinha (só o `PATCH` de texto faz). Antes de expor ao usuário, a Fase 3 precisa da trava e da transição automática.
- **Chat IA/GAPs/planner de RFC não leem a spec-base:** só existe `GET /api/cards/:id/base-spec`. `buildEvolutionPlanContext` usa o arquivo primário do projeto e o rascunho não tem primário; a leitura "rascunho ∪ HEAD (somente leitura)" de H §5.2 (e `BASE_READ_ONLY` no Chat) é Fase 3.
- **Revalidar não confere `files_allowed` contra o mapa do repositório do HEAD novo** (D-B1 c de H): só rebaseia e exige nova validação; a revisão humana do RFC é manual. O `dev_sha` não é registrado (H R3 segue aberto).
- **`ready` não trava a spec** entre o carimbo e a promoção além da checagem de hash (janela curta entre a checagem fora do lock e o claim; o carimbo é recalculado a cada promoção).
- **Orçamento compartilhado pode pausar a produção** (H R1): mitigado só pelo saldo livre mínimo configurável (`EVOLVE_MIN_FREE_BUDGET_USD`); sem valor configurado vale apenas o Guard.
- **Falha terminal com efeitos deixa o card `blocked` com o filho `failed` até alguém chamar `resume`.** O achado `ticket_promoted_without_child` (Q2) também dispara nesse caso (esperado).
- **`POST /api/products/:id/tickets` (legado) continua criando ticket sem `card_state`** mesmo com a flag ligada; o ticket criado depois do backfill fica fora da máquina até a porta de entrada da Fase 3 (`enterCardMachine`).
- **`reopenTicketsOfChild` e `failTerminal` ganharam uma consulta a mais** (`SELECT … card_state IS NOT NULL`) mesmo com a flag off (leitura sem efeito; os testes antigos continuam verdes).
- **Leitores Python de `projects.status`/`card_draft`** continuam sem inventário (lacuna de H §12 e de P).
- **Migrations 148–150 e 160 não aplicadas em produção;** nenhuma migration nova nesta tarefa.

## 7. Fora de escopo (próximas tarefas)

UI do quadro e do diálogo de criação (3.x); trava `CARD_SPEC_LOCKED` e transições automáticas por escrita na spec; Chat/GAPs/planner lendo rascunho ∪ HEAD (somente leitura); `stopped_by='budget' ⇒ blocked`; `in_factory → delivered` com PR mergeado (4.3); preenchimento de `card_id`/`origin_spec_file` pelo runner (4.2); `files_allowed` × mapa do repositório novo na revalidação; `enterCardMachine` exposto por rota; importação (`origin = import`); Auto Care; Staff/papéis de modelo.
