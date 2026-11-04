> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AC — Correções dos achados AB (reverificação da Fase 3)

**Data:** 2026-11-04 · **Branch:** `evo/l3` (base `1511930`) · **Origem:** `EVOLUIR-PROJETO-AB-revisao-fase3-reverificacao.md` · **Escopo:** backend (`api-node`), portal (`genesis-web`) e contrato. Sem produção, sem push, sem Playwright (a execução fica com o orquestrador). Caminhos do backend relativos a `applications/services/api-node/src/`; do portal, a `applications/apps/genesis-web/`.

## 1. Resumo por achado

| ID | Estado | Correção (arquivo:linha aproximada) | Teste (falha sem a correção) |
|---|---|---|---|
| AB-01 (ALTA) | **Corrigido** | (a) `services/evolutionPlanner.ts` `upsertCardAware`: trava reconferida **imediatamente antes de cada gravação**, na mesma transação, sob `FOR UPDATE` do ticket; card fora de `draft/refining` ⇒ `CardLockedDuringPlanError` e job `error` ("validado ou promovido"). (b) `services/cardService.ts` `markCardReady`: na transação do carimbo, jobs `pending/running` do rascunho viram `interrupted`; `setJob` não ressuscita job encerrado por fora (`WHERE status IN ('pending','running')`). (c) `services/evolveClaim.ts` `stepCardSpec`: confere o hash do rascunho com `card_ready.draft_spec_hash` antes de copiar; divergência ⇒ `TerminalFailure CARD_DRAFT_CHANGED` (nada chega ao filho). Portal: `CardActionsBar` desabilita "Validar" (com aviso) enquanto o planner gera; `CardSpecTab` desabilita gerar/modelo durante a validação | `routes/cards.fase3.ac.pg.integration.test.ts` (4 testes AB-01, incluindo job em voo com gancho no LLM e RFC injetado entre claim e `card_spec`); portal `CardDetailView.test.tsx` "AB-01" |
| AB-02 (MÉDIA) | **Corrigido** | `routes/tickets.ts` (POST `/api/products/:id/tickets` ⇒ 409 `USE_CARDS` com a flag do tenant do produto); `routes/projects.ts` `/evolve`: sem ticket **ou com ticket legado** (sem `card_state`, sem filho) ⇒ 409 `USE_CARDS`; a flag passa a ser a do tenant do **projeto**, só para quem o enxerga (não vaza flag) | 2 testes AB-02 + ajuste do teste legado de `cards.pg.integration.test.ts` (ticket legado agora recusa com a flag ligada e promove sem ela) |
| AB-03 (decisão) | **Corrigido** | Decisão: `zentriz_admin` **não promove** (RFC-0002 A.1). `routes/cards.ts`: `PROMOTER_ROLES = {tenant_admin}`, `canOperateCard(user, card, action)`, `denyOperate(..., "promote")`; `actions` do detalhe calculadas com o papel (`promote`, `reject`, `revalidate`, `reopen`, `resume`, `delete`). `zentriz_admin` segue rejeitando/revalidando/reabrindo/retomando/excluindo. Portal `PromotePanel`: sem botão quando `actions.promote=false`, com explicação. Matriz atualizada em `EVOLUIR-PROJETO-Z-correcoes-fase3-backend.md` §3 | AB-03 (backend, 403 e `actions` por papel) e `PromotePanel.test.tsx` "AB-03" |
| AB-04 (MÉDIA) | **Corrigido** | `routes/cards.contract.pg.integration.test.ts` grava 14 fixtures novas em `lib/cards/__contract__/`: `CARD_PATH_COLLIDES_WITH_BASE` (3 formas), `CARD_ATTACHMENT_CONVERSION_PENDING`, `CARD_SPEC_CHANGED`, `CARD_ACTION_NOT_ALLOWED` (user e zentriz_admin), `INVALID_ID`, `USE_CARD_DELETE`, `USE_CARDS` (evolve e tickets) e a jornada com `GLOBS_UNVERIFIED`. Portal `lib/cards/schemas.ts`: `ERROR_SCHEMAS_PREPARED` removido; schemas estritos com os campos reais (novo combinador `s.oneOf` para as duas formas do `paths/path`) | `contract.test.ts`: (i) todo schema estrito tem fixture real (barra o "passa sem provar"); (ii) campo a mais/a menos falha por fixture; (iii) o schema básico antigo reprova o corpo real de `USE_CARD_DELETE` e um schema com tipo errado também |
| AB-05 (MÉDIA) | **Corrigido** | `services/cardSpecGuard.ts`: `specNumberKey` + `findBaseCollision`/`findBaseCollisions` reservam o **número** de RFC/ADR do HEAD (nome diferente, mesmo número ⇒ 409 na escrita, no "Validar" e no claim). Portal: `suggestRfcPath(existing, title, basePaths)` e `CardSpecTab` passam os arquivos do `base-spec` | AB-05 (backend) e `specApi.test.ts`/`CardDetailView.test.tsx` "AB-05" |
| AB-06 (MÉDIA) | **Corrigido** | `services/cardService.ts` `markCardReady`: anexo `queued` (sem linha na fila) ⇒ `kickTicketConversions` (enfileira e dispara a conversão) e releitura; a espera termina sozinha | AB-06 (anexo enviado sem conversão, flag ligada depois: linha criada, estado `pending`, valida quando terminar) |
| AB-07 (BAIXA) | **Não resolvido** | Persistir confirmação explícita dos globs (`revalidate {globsReviewed}` + conferência no `promote`) muda contrato e regra de negócio; rebaixar o bloqueador a aviso afrouxaria uma trava. Ficou a fixture real da jornada com `GLOBS_UNVERIFIED` (AB-04) para a decisão | Decisão do Jean |
| AB-08 (BAIXA) | **Corrigido** | `routes/cards.ts` `productGuard`/`cardGuard`: token `svc` com a flag do tenant desligada recebe o 404 "Recurso indisponível" de sempre; com a flag ligada, 403. O `INVALID_ID` em projetos comuns de tenants sem cards é efeito deliberado do Y-04 (registrado aqui; não há CHANGELOG no repositório) | AB-08 |
| AB-09 (BAIXA) | **Corrigido** | `services/specAutonomy.ts` `writeSpecFile` e `createNewSpecFile` chamam `noteCardSpecWrite` após gravar (rascunho de card: `ready → refining`, carimbo descartado; projeto comum: no-op). O ponto `routes/specChat.ts:2493` só checa a trava (a gravação é feita pelo `PUT spec-file`, que já notifica) | Coberto pela suíte existente (sem teste dedicado novo) |
| AB-10 (BAIXA, processo) | **Fora do alcance** | Os 15 PNG modificados estavam no worktree `g-chk3`, não neste. Aqui `git status` não mostra PNG alterado e nenhum foi commitado. Reexecução do Playwright fica com o orquestrador | n/a |

## 2. Decisões e observações

- **Trava sob lock (AB-01a):** o `ready` trava `tickets` (`FOR UPDATE`) antes de reler o hash; o planner agora faz o mesmo antes de gravar. Ou a escrita termina antes (o `ready` vê o hash novo e responde `CARD_SPEC_CHANGED`), ou o `ready` vence e a escrita é recusada. Gravações anteriores do mesmo job (antes do `ready`) permanecem; o hash do carimbo as cobre.
- **Job interrompido (AB-01b):** a chamada ao LLM em voo não é cancelada (custo já comprometido), mas seu resultado não grava nem muda o status do job.
- **`/evolve` com ticket legado já promovido** (`child_project_id` preenchido) continua no caminho histórico (replay idempotente).
- **`CARD_DRAFT_CHANGED`** é código novo apenas do passo interno de materialização (falha terminal 422 do claim, card ⇒ `blocked`); não há fixture porque só ocorre com escritor que ignora a guarda.
- **Mensagem de colisão** ganhou "nem reutilizar o número dele" (`cardPathCollidesBody`); os textos de `cardErrors.ts` não mudaram.

## 3. Verificação executada

Postgres efêmero `pgvector/pgvector:pg16` na porta 55432 (derrubado ao final).

| Suíte | Resultado |
|---|---|
| api-node `npx vitest run` | 238 arquivos, **4027 passaram**, 1 pulado (baseline 4015; +12: 10 testes AB em `cards.fase3.ac…`, 2 de contrato novos) |
| portal `npx vitest run` | 12 arquivos, **329 passaram** (baseline 299) |
| portal `tsc --noEmit`, `next lint`, `npm run build` | tsc limpo; lint sem erros (1 aviso antigo em `GraphView.tsx`); build OK |
| `contract:gen` e `contract:gen:spec` | executados; fixtures antigas inalteradas, 14 novas |

### 3.1 Prova de que os testes falham sem a correção

Com as correções de `src` guardadas (`git stash`), os 10 testes de `cards.fase3.ac.pg.integration.test.ts` falharam (9 + AB-08 adicionado depois); no portal falharam os 4 testes novos (AB-01, AB-03, AB-05 e `suggestRfcPath`). No contrato, o teste estrito reprovou 10 fixtures novas enquanto os schemas eram os "preparados". Sondas do AB-01(c) devolveram 201 sem a correção (RFC não validado chegando ao filho).

## 4. Pontos abertos

1. **AB-07:** decisão sobre a confirmação humana dos globs.
2. **AB-10:** reexecutar `test:e2e` e `test:e2e:real` sobre o HEAD final (não rodei Playwright).
3. A UX do planner em voo cobre só a aba da spec montada; se o usuário trocar de aba, "Validar" volta a habilitar (o servidor encerra o job ao validar, então é seguro).
