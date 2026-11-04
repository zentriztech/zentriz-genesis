> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AE — Fase 4, tarefas 4.3 e 4.4 (delivered + executed_* e PR por card)

Branch `evo/f4b` (base 80103b1). Escopo: api-node. Sem push, sem produção, sem tocar `orchestrator/` nem prompts.

## 1. O que já existia (verificado antes de implementar)

| Item | Onde | Situação |
|------|------|----------|
| `promoted`, `in_factory`, `blocked` (filho `failed/archived`, falha de materialização), `blocked` por orçamento (`budget:*`, ator `guard`), retomada `blocked → in_factory`, `rejected` humano | `services/cardPromote.ts` (`syncCardWithChild`, `resumeCard`), `services/evolveClaim.ts:862`, `routes/cards.ts` | Já implementados e testados na Fase 3. Orçamento negado **nunca** vira `failed`. Reaproveitados, não duplicados. |
| Aresta `in_factory → delivered` com `mergeCheck` parametrizado | `services/cardState.ts` (`childPrecondition`) | Existia, mas **nada a chamava** (o aceite não tocava `tickets`). |
| Carimbo `TK-NNNN` no commit em lote, no título do PR e `**Ticket:**` no corpo | `services/github.ts` (`messageSuffix`), `services/githubPush.ts`, `services/evolutionAccept.ts` (`buildPullRequestBody`) | Já existia (RFC-0009 F3), **sem nenhum teste**. |

## 2. Implementado

**4.3 — `services/cardDelivery.ts` (novo)**
- `verifyChildPrMerged`: prova de merge fora do lock. Sem repositório no filho ⇒ `no_repo`. Com repositório: `extra.evolution_merged_at` (merge do Genesis) ou consulta ao PR (`getPullRequest`, injetável; nos testes o Octokit é simulado). Sem PR/instalação/merge ⇒ `pending_merge`, nada muda.
- `deliverCardsOfChild`: filho `accepted` + prova ⇒ por card, **uma transação**: `SELECT … FOR UPDATE`, (se `promoted/blocked`, antes `→ in_factory` com `child_accepted`), `transitionCard(in_factory → delivered, system, dedupeKey delivered:<filho>)` e carimbo `executed_in_project/executed_at` dos arquivos de spec com `spec_origin = card:TK-NNNN` (no filho e no rascunho), só onde `executed_in_project IS NULL`. Qualquer recusa ⇒ ROLLBACK de tudo. Card já `delivered` sem carimbo (queda no meio) é reparado na repetição, sem novo evento. Só toca `card_state` não nulo e só o card ainda ligado àquele filho (relido sob lock).
- `deliverAcceptedCards`: passada do reconciliador (cobre merge feito direto no GitHub).
- Ganchos: `routes/projects.ts:825` (aceite, depois do push/PR e da tentativa de merge), `services/evolutionMerge.ts:422` (após gravar o merge, automático ou manual), `services/evolveReconciler.ts:423` (somente `EVOLVE_RECONCILER=on`; novo campo `cardsDelivered`; em `shadow` não age). Todos best-effort, nunca lançam.

**4.4**
- `evolutionPrTitle` (puro, `githubPush.ts:36`) usado no PR (`githubPush.ts:704`).
- Novo: o título do commit de merge (squash) em `dev` também leva `TK-NNNN · ` (`evolutionMerge.ts:352-353`); antes só o corpo tinha o carimbo.
- Verificação de merge com repositório simulado (sem rede) nos testes.

## 3. Decisão sobre "tasks recebem `executed_*`"
`project_tasks` **não tem** colunas `executed_*` (migration 150 só criou `card_id` e `origin_spec_file`; `executed_*` existem só em `project_spec_files`, migration 149). Seguindo a decisão D-M2 da revisão D (sem segunda fonte de verdade), "task executada" fica **derivada**: `project_tasks.project_id = tickets.child_project_id` de um card `delivered`. Não criei migration (evita conflito de numeração com a frente f4a). Se o Jean quiser coluna explícita em tasks, é uma migration aditiva pequena. Decisão pendente.

## 4. Testes

Postgres efêmero 55440 (suíte completa) + 55432 (4 suítes de porta fixa, 25 testes, todas passaram).

| | Baseline | Agora |
|---|---|---|
| Arquivos | 238 | 240 |
| Testes passados | 4027 (1 pulado) | **4048** (4023 em 55440 + 25 das suítes de porta fixa em 55432); 1 pulado |
| `tsc --noEmit` | – | limpo |

Novos (21): `routes/cardDelivery.pg.integration.test.ts` (12), `services/githubPush.ticketStamp.test.ts` (6), `services/evolutionMerge.test.ts` (+3).
Cobrem: ponta a ponta card → aceite HTTP → `delivered` (evento único, `executed_*` só nos arquivos do card; `initial` e outro card intactos); PR aberto não entrega e, mergeado (Octokit simulado), entrega; `evolution_merged_at` dispensa rede; sem PR/instalação não entrega; corrida de 10 entregas + aceite repetido (1 evento, datas imutáveis); reparo de carimbo; reconciliador; `promoted/blocked` → `in_factory` → `delivered`; filho `failed` ⇒ `blocked` `child_failed` e retomada; orçamento ⇒ `blocked budget:BUDGET_PAUSED` (ator guard, filho segue `stopped`, nunca `failed`); rejeição humana ⇒ `rejected` e nunca reaberto; card religado a outro filho não é entregue; ticket legado (sem `card_state`) byte a byte inalterado; carimbo TK no título do PR, mensagem de commit em lote (com e sem sufixo), linha `**Ticket:**` e título do squash.

**Mutação:** sem o gancho do aceite ⇒ 3 testes falham; sem o carimbo `executed_*` ⇒ 3 falham. Os testes de `blocked` (falha/orçamento), `rejected`, legado, de título/commit/corpo sem prefixo e o de filho trocado são **guardas de comportamento** que já passavam antes (a Fase 3 já implementava essas arestas); não falham sem a correção, por desenho. Também observado: remover o `FOR UPDATE` do módulo não derruba a corrida, porque `transitionCard` já serializa por conta própria (o lock local é defesa em profundidade).

Ajustes de guardas existentes: `cardDelivery.ts` entrou na lista de arquivos permitidos de `cardsOff.regression` e ganhou exceção por consulta em `projectsReaders.inventory.test.ts` (chave `services/cardDelivery.ts:f0e686f7`, busca por id).

`contract:gen`: não necessário (nenhum código de erro nem contrato de rota mudou).

## 5. Pendências / riscos
1. Task com coluna `executed_*`: decisão do Jean (item 3).
2. Merge feito direto no GitHub sem o Genesis só é percebido pelo reconciliador (`EVOLVE_RECONCILER=on`), que consulta o GitHub a cada passada para filhos aceitos sem merge; limitado por `limit` (100). Não persisto `evolution_merged_at` ao descobrir via GitHub (sem `sha_dev`/hooks pós-merge); se desejado, é follow-up.
3. `cardsDelivered` na passada do reconciliador está coberto pela função (teste direto), não por `runReconcilerPass` ponta a ponta.
4. `task_id`/`card_id` nas tasks continuam a cargo do runner (4.2, frente f4a).
5. Comentário de `cardState.ts` ainda diz que a verificação de merge é "da Fase 4"; vale ajustar na integração.

## 6. Arquivos
Novos: `src/services/cardDelivery.ts`, `src/routes/cardDelivery.pg.integration.test.ts`, `src/services/githubPush.ticketStamp.test.ts`.
Alterados: `src/routes/projects.ts`, `src/services/evolutionMerge.ts`, `src/services/evolveReconciler.ts`, `src/services/githubPush.ts`, `src/services/evolutionMerge.test.ts`, `src/services/projectsReaders.inventory.test.ts`, `src/routes/cardsOff.regression.pg.integration.test.ts` (caminhos sob `applications/services/api-node/`).
