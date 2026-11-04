> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-BANCADA — Fase 5 (5.1 orçamento do card em % · 5.2 métricas de cards)

Branch `evo/f5` (base 8a261b4). Escopo: api-node. Sem mudança no portal (nenhum tipo/schema novo; `contract:gen` não necessário).

## 5.1 — Orçamento do card em percentual (política `card_budget_pct`)

**Como o orçamento do card funciona hoje (D-E10, inalterado sem política).** O rascunho do card nasce com `budget_owner_project_id` = dono terminal do orçamento do HEAD (`cardService.ts:204`, ancora via `resolveBudgetAnchor`, `evolveClaim.ts:110`); o filho promovido herda o mesmo dono (`evolveClaim.ts:507,534`). Ou seja, rascunho e filho NÃO têm `budget_usd` próprio: compartilham o do dono. A promoção não copia valor algum, e esta fase não mudou isso.

**Política.** `card_budget_pct` em `cost_policies` (`costPolicies.ts`): escopo global ou tenant (tenant vence), `pct` 1–100 (validação em `validatePolicy` + CHECK da migration 161), `abs_cap_usd` opcional; recusa `floorUsd`/`valueUsd`. Nasce `calibrado=false`; só `zentriz_admin` calibra; `tenant_admin` escreve só a própria linha (`routes/costPolicies.ts:30`). Versão, histórico e evento de auditoria idênticos às demais (sem migration nova: a 161 é genérica por `policy_key`).

**Aplicação pelo Guard (soberano, fail-closed).** `cardBudgetCheck` (`llmGuard.ts:554`):
- vínculo card → projetos: `tickets.child_project_id` / `tickets.draft_project_id` (com `card_state` não nulo);
- gasto do card = soma de `llm_call_ledger.cost_usd` por `project_id` ∈ {rascunho, filho} (inclui o gasto de refino);
- teto = `pct` × `budget_usd` do dono (limitado por `abs_cap_usd`); `gasto + estimativa da chamada > teto` ⇒ negativa;
- `preflight` (`llmGuard.ts:435`): nega com `CARD_BUDGET_CAP`, grava evento `card_cap_reached`, e para SÓ o filho (`stopped`/`stopped_by='budget'` se a Fábrica estava ativa). Não chama `pauseForBudget`: o dono e os outros cards seguem;
- `checkProjectBudgetGate` (`llmGuard.ts:929`): mesmo teto com estimativa zero (usado por `syncCardWithChild`/`resume`);
- erro de leitura lança ⇒ `GUARD_ERROR` (fail-closed), testado;
- sem política, projeto que não é card, ou dono sem orçamento ⇒ `applies:false` (comportamento atual; `BUDGET_MISSING` continua do `preflight`, inalterado).

**Card `blocked`, nunca `failed`.** Reutiliza o mapeamento existente de `syncCardWithChild` (`cardPromote.ts`): filho parado pelo Guard ⇒ `blocked` com `budget:CARD_BUDGET_CAP` (ator `guard`). Acréscimo mínimo (`cardPromote.ts:190-198`): se o filho está vivo e NÃO parado (Bancada mantém o status) e o Guard nega com `CARD_BUDGET_CAP`, o card também vai a `blocked`. Subir o percentual (ou o orçamento) libera pelo ramo `budget_released` já existente; `resume` segue exigindo que o Guard libere. Mensagem de usuário em `cardErrors.ts:81`.

**Arquivos centrais tocados do advisor gate:** apenas `llmGuard.ts` (import, código `CARD_BUDGET_CAP`, bloco novo `cardBudgetCheck` e dois ganchos); `advisorGate`, `advisorFloor.ts` e `advisorPolicyView` intactos. O teste estático da Fase 2 (`cardsOff.regression`) passou a permitir `llmGuard.ts` e `cardMetrics.ts` (leitura de `card_state`/`ticket_card_events`).

## 5.2 — Métricas de cards

`GET /api/products/:productId/cards/metrics[?since=ISO&limit=N]` (`routes/cards.ts:200`, `services/cardMetrics.ts`). Mesma autorização e flag `CARDS_BANCADA` do quadro (produto de outro tenant ⇒ 404; flag off ⇒ 404 "Recurso indisponível"; `svc` ⇒ 403). Contrato `version: 1` (só se acrescentam campos):
- `byState` (todos os 8 estados, zero incluído), `totalCards`;
- `timeInState[estado] = {cards, totalSeconds, avgSeconds}` a partir de `ticket_card_events` (intervalo = evento que entra no estado até o próximo evento do mesmo card; estado atual conta até `now()`);
- `cost = {totalUsd, avgUsdPerCard, cardsWithCost, items[{ticketId, number, title, state, costUsd, calls}]}` (ledger por rascunho + filho; `limit` 1–200, padrão 50, ordenado por custo);
- `blocked = {promotedCards, everBlockedCards, currentlyBlocked, rate, reasons[{reason, cards, kind: budget|other}]}`; taxa = já bloqueados ÷ já promovidos (`null` sem promovidos).
Isolamento: filtra por `product_id` e `tenant_id` do produto (verificado com dois tenants).

## Testes
`services/cardBudget.f5.pg.integration.test.ts` (5 testes, Postgres real): validação/escopo/histórico/permissões; teto dentro/estourou ⇒ negativa, dono não pausa, segundo card intacto, card `blocked` `budget:CARD_BUDGET_CAP` e liberação ao subir o pct; Bancada (filho não parado) + tenant vence global; sem política = igual a hoje + `BUDGET_MISSING` + fail-closed; métricas exatas (190 s/100 s/300 s por estado, custo 4,00/1,00, taxa 0,6667, motivos) + isolamento cross-tenant + `since`/`limit`/flag off. Os 5 falham sem a implementação (verificado com stash dos arquivos de produto).
Suíte completa (Postgres 55440, sem as 4 de porta fixa): 240 arquivos, 4047 passam, 1 skipped; as 4 de porta fixa (+ vizinhas pelo padrão: 7 arquivos) em 55432: 69 passam. `npx tsc --noEmit` limpo. Obs.: o baseline "4072" não pôde ser reconciliado com a contagem exata (a exclusão por padrão é diferente da usada na medição original).

## Assunções (`calibrado=false`)
- Percentual por card não tem valor-padrão nem sugerido: nenhuma linha é criada; todo valor gravado é `calibrado=false` até um `zentriz_admin` calibrar com dado de ledger (C9').
- Gasto do card = só `project_id` do rascunho e do filho direto. Filhos de split do filho (se existirem) não entram.
- Estimativa de chamada = `estimateCallUsd` já usada pelo preflight (não calibrada).
- Taxa de `blocked` usa denominador "já promovidos"; tempo por estado inclui o intervalo aberto até `now()`.

## Pendências
- Divisão por card de uma mesma versão não impede que muitos cards somados passem o orçamento do dono (o teto global do dono segue valendo e pausa tudo).
- Sem UI/painel; sem exposição do teto do card em `budgetSummary`/jornada (candidato a F5+).
- `card_cap_reached` não gera e-mail (só evento do Guard).
