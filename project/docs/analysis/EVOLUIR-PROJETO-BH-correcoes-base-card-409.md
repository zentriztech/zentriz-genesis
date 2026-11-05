> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-BH — Correções D-17, 409 específico de card e rótulo "46 de 23" (rodada 4.5d)

Origem: relatório BF (`EVOLUIR-PROJETO-BF-execucoes-reais-4-5d.md`). Branch `evo/w2` (worktree `g-w2`). Escopo: api-node, genesis-web e runbook.

## 1. D-17 — base registrada do card × HEAD (CORRIGIDO)

**Causa-raiz (refinada).** A promoção já comparava o carimbo `card_ready.base_head_project_id` com o HEAD; o furo estava antes: `markCardReady` ("Validar") resolvia o HEAD *de agora* e carimbava-o sem olhar a base REGISTRADA do rascunho (`extra.card_base`, gravada na criação). Card A nasce sobre v7; v7 é recusado (HEAD volta a v6); o usuário valida ⇒ carimbo v6, promoção passa, filho nasce de v6 — embora RFC e spec-base tenham sido escritos sobre o v7 inexistente. Além disso `revalidate` rebaseava `card_base` mas deixava `tickets.project_id` preso ao v7 (o `projectId` apontado no BF).

**Correção.**
- `cardService.ts:341` `registeredBaseStale(extra, headId)`: base registrada ≠ HEAD ⇒ base antiga.
- `cardService.ts:436` `markCardReady`: base registrada vencida ⇒ `{kind:"base_stale"}`; rota `cards.ts:457` responde 409 `CARD_BASE_STALE {expectedHead, currentHead, revalidate}`; nada é carimbado.
- `cardPromote.ts:184` `promoteCard`: defesa em profundidade — também confere `card_base` (além do carimbo); vencida ⇒ volta a `refining` + 409 `CARD_BASE_STALE`.
- `cardService.ts:624` `revalidateCard`: no rebase atualiza também `tickets.project_id`.

**Testes** (`routes/cards.d17.pg.integration.test.ts`, Postgres real): v6 entregue; v7 aceito (card B); card A criado sobre v7; B recusado ⇒ validar 409 stale ⇒ revalidate (`stale`, rebased, `project_id` = v6) ⇒ validar 200 ⇒ promover 201 com `evolution_parent_id` = v6. Segundo teste: `card_base` regride para v7 com carimbo em dia ⇒ promover 409 e card em `refining`.

## 2. 409 específico de card (CORRIGIDO)

Escolha: **código novo `CARD_PREVIOUS_IN_PROGRESS`** (nenhum existente serve: `CARD_PREVIOUS_UNMERGED` vale só para HEAD *aceito* sem merge, e `CARD_CHILD_ACTIVE` é da recusa). `cardPromote.ts:113` `previousCardInProgressBlock` (antes do claim) + `cardPromote.ts:119/214` tradução da corrida (claim devolve `EVOLUTION_IN_FLIGHT` com `childProjectId`). Corpo: `blockingCardId/Code/State`, `blockingProjectId`, `blockingChildStatus/Version`, `action` (aguardar, retomar o filho ou recusar) e `rejectBlockingCard` (`POST /api/cards/:id/reject`). Filho vivo SEM card continua `EVOLUTION_IN_FLIGHT`. O card promovido segue `ready`.
Tabela de erros `cardErrors.ts:74`; portal `lib/cards/cardErrors.ts` (detalhe PT-BR: card, estado da execução, ação) + teste; contrato regenerado (`contract:gen`): `error-codes.json` ganha o código; fixtures `revalidate.stale*.json` mudam só o `card.projectId` (agora acompanha o rebase).
Testes: `cards.d17...` (blocked_cyborg ⇒ 409 novo; recusar o bloqueante ⇒ promoção 201; legado ⇒ `EVOLUTION_IN_FLIGHT`); `cards.pg.integration.test.ts:285` atualizado (card × card agora é o código novo).

## 3. Rótulo "46 de 23" — CAUSA ACHADA, correção FORA do meu escopo (`scripts/`, evo/w1)

Reprodução (somente leitura, `scripts/full-test-server.py:780`):
`_jest_zero_tests_error({"numTotalTests":0,"numFailedTestSuites":23,"numRuntimeErrorTestSuites":23,"numTotalTestSuites":23}, 1)` ⇒ `"46 de 23 suíte(s) falharam…"`.
Causa: o jest já inclui as suítes com erro de execução em `numFailedTestSuites`; `numRuntimeErrorTestSuites` é um SUBCONJUNTO. A função soma os dois (`failed_suites = a + b`), dobrando a contagem (BF: 46 de 23; FULL-TEST: 48 de 24). Nenhum trecho do api-node/portal calcula esse rótulo (apenas repassa a mensagem).
**Correção proposta para a w1:** `failed_suites = max(numFailedTestSuites, numRuntimeErrorTestSuites)` (e limitar a `total_suites`), com teste `test_fts_n2_n3_n4_n7.py` incluindo `numRuntimeErrorTestSuites=23` ⇒ "23 de 23".

## 4. Runbook

`CARDS-BANCADA-RUNBOOK.md`: §2.2 (subseção D-17), tabela §2.5 (`CARD_PREVIOUS_IN_PROGRESS`), nova §4.6 "card em `blocked_cyborg`: retomar o filho × recusar o card", tabela §11.

## 5. Verificação

- api-node: `tsc --noEmit` limpo; vitest (suítes comuns) 4167 passed + 1 skipped, 3 execuções limpas; as 4 suítes de porta fixa (55432) 25/25. Novos testes: 4 (+0 outros; 1 asserção alterada).
- Mutação (src revertido, teste mantido): 3 dos 4 testes novos falham (o 4º é o controle legado); desligar só a checagem do promote derruba o teste de defesa em profundidade.
- Portal: vitest 346/346 (345 + 1 novo), `tsc` limpo, `next lint` só o warning antigo de GraphView, `build` ok.
- Flakiness: sob carga, suítes de timeout de 5 s falham de forma intermitente (vi `cardChaos` e `cards.rejectInFactory` em execuções isoladas passando 12/12 três vezes); não relacionadas ao diff.

## 6. Riscos

- "Validar" de card antigo com `card_base` defasado passa a exigir `revalidate` (intencional; pode surpreender cards parados criados antes de uma entrega).
- Rebase agora escreve `tickets.project_id`; consumidores que liam o valor antigo veem o HEAD novo.
- `CARD_PREVIOUS_IN_PROGRESS` muda o código para clientes que dependiam de `EVOLUTION_IN_FLIGHT` em card × card (portal usa a tabela, sem tratamento especial do código antigo).
