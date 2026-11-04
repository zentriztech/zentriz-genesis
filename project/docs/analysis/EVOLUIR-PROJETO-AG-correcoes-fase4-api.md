> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AG — Correções da revisão AF (Fase 4) no api-node + caos 4.6

Branch `evo/f4c` (base `4acaf89`). Escopo: `applications/services/api-node`. Sem `orchestrator/`, sem push, sem produção, sem tocar o checkout principal nem o stack docker de dev. Cada correção tem teste que falha sem ela (mutação executada, §4).

## 1. O que foi corrigido

| Achado | Correção | Onde |
|---|---|---|
| **B1** (bloqueante) | "Sem repositório" passou a ser decidido pela **linhagem** (`findLineageRepo`: linha do filho, raiz ou pai), não pela linha do filho. Precedência: publicação pendente/em voo (`evolution_push_pending` ou `evolution_publish_state='pending'`) ⇒ `push_pending` ⇒ NÃO entrega. Repositório na linhagem sem PR mergeado ⇒ NÃO entrega. Só linhagem sem repositório algum ⇒ `no_repo`. Mesma regra na máquina (`childPrecondition` → `childNeedsMerge`). O aceite grava `evolution_publish_state='pending'` **na mesma escrita** do `accepted` (evolução); `runEvolutionAcceptFlow` grava `done` ao fechar o push e `failed` + `push_pending` na falha. | `services/cardDelivery.ts:40-75`; `services/cardState.ts:178-195,344-348`; `routes/projects.ts:795-812`; `services/evolutionAccept.ts:284,295-300` |
| **A1** | Filho `archived` com `extra.superseded_by` conta como aceito: entrega (`deliverCardsOfChild`, `deliverAcceptedCards`), `childPrecondition` (`blocked→in_factory` e `in_factory→delivered`), `syncCardWithChild` (não leva a `blocked`) e candidatos do `syncCardsWithChildren`; o merge-watch e o botão "Mergear agora" aceitam o superado. `archived` por rejeição de card (`card_rejected`, sem `superseded_by`) continua morto. | `cardState.ts:158-176` (`isSupersededChild`, `acceptedLikeChildSql`); `cardDelivery.ts:97-101,171`; `cardPromote.ts:168-171,223`; `evolutionMergeWorker.ts:35`; `routes/evolutionPlan.ts:~233` |
| **M1** | Novo detector Q7 do reconciliador, `evolution_publish_incomplete` (crítico): evolução aceita com `publish_state='pending'` vencido (`EVOLVE_RECONCILER_PUBLISH_GRACE_S`, padrão 900 s) **ou** com repositório da linhagem registrado e sem `evolution_pr_number`. `fallback_new_repo` (sem PR por desenho) não é achado. Em `shadow` só registra; em `on` marca `evolution_push_pending=true` (aparece "Republicar"; a entrega segue bloqueada), registra no diálogo do projeto e o achado vai no e-mail de notificação existente. Republicar reaproveita o PR aberto (`openPullRequest` lista antes de criar). | `services/evolveReconciler.ts:284-345,~477` |
| **M2** | Valida tudo antes e grava em `BEGIN/COMMIT`: `CARD_MISMATCH` (400) ou erro de banco no meio não deixa backlog parcial. | `routes/projects.ts:~580-650` |
| **A3** (decisão do orquestrador) | Flag `CARDS_BANCADA` ligada para o tenant e ticket do projeto É card (`card_state` não nulo) **ligado a este filho** (`child_project_id`): toda task cujo ID não começa por `TSK-INH-` recebe `card_id` por padrão, sem o runner enviar. `TSK-INH-*` ficam sem, mesmo com `card_id` explícito. Resolve também B-3 (runner de filho descartado não liga ao card religado). | `routes/projects.ts:61-62,~565-600` |
| **M4** | `listExecutedTasksOfCard`: "executada" = task do filho de um card **entregue**, não herdada, com status `DONE`/`QA_PASS`. `CANCELLED`, `QA_FAIL`, `BLOCKED` e as pendentes não contam. Continua derivada (sem migration). | `services/cardDelivery.ts` (fim do arquivo) |
| **M7** (trivial, feito) | O aceite virou CAS (`UPDATE … WHERE id=$3 AND status=<lido> RETURNING`): o perdedor da corrida responde "já aceito" e não roda push/PR/CHANGELOG/entrega. | `routes/projects.ts:795-815` |

Ajustes de guardas existentes: `evolveReconciler.pg…` (parâmetro novo `publishGraceS`), `projectsReaders.inventory.test.ts` (duas consultas de `cardDelivery.ts` por id/join de ticket), e o teste e2e de entrega, que agora usa o `runEvolutionAcceptFlow` **real** e simula só o push ao GitHub (antes mockava o aceite inteiro e consagrava `accepted_no_repo`).

## 2. Testes

| | Antes (AF) | Agora |
|---|---|---|
| Arquivos de teste (55440) | 240 | 242 (+`cardChaos.pg.integration.test.ts`; +2 blocos em `projects.tasks.card…`) |
| Passaram (55440) | 4050 (+ portas fixas) | **4044** + 4 suítes de porta fixa em 55432 (6 arquivos casados pelo filtro, **55 testes**, todos verdes); 26 pulados (suítes sem PG dedicado) |
| `tsc --noEmit` | limpo | limpo |

Falhas restantes na rodada em 55440: **apenas** as 4 suítes de porta fixa (llm.reorder, llm.role-verify, costSource, skillFeedback), que passam em 55432 como previsto. Rodada 1 expôs 2 falhas do inventário S-16 (consultas novas de `cardDelivery.ts`), corrigidas.

Novos testes (21): `routes/cardChaos.pg.integration.test.ts` (15) e `routes/projects.tasks.card.pg.integration.test.ts` (+4). `contract:gen`: não necessário (nenhum código de erro/contrato mudou; `evolution_publish_state` é interno ao `extra`).

## 3. Caos 4.6 (api-node) — cenários da AF §3

"Kill" = função interrompida no meio (promessa que nunca resolve, cliente que lança antes do COMMIT, estado deixado como a rota deixa) e reexecução sobre o banco. Em todos: ≤ 1 evento `delivered` por card, 1 push por aceite, nenhum `delivered` sem PR mergeado de repositório existente.

| Cenário | Teste | Verifica |
|---|---|---|
| Repro B1 do revisor | `cardChaos…:B1 (repro)` | push pendente + pai com repositório ⇒ `pending_merge`, GitHub nem consultado |
| C1 API morre entre aceite e push | `C1` | marcador `pending` gravado no aceite; não entrega; dentro da carência o reconciliador não mexe; vencida a carência, marca republicável (3 passadas ⇒ 1 aviso); republicar + merge ⇒ 1 entrega |
| C2 push em voo + reconciliador | `C2` | 3 passadas + merge "estranho" durante o push ⇒ nada; PR aberto ⇒ nada; mergeado ⇒ 1 entrega; 1 push |
| C3/M1 queda entre registro do repo e nº do PR | `C3/M1`, `M1 … aceite antigo` | detecta, `cleaned_marked_push_pending`, 4 passadas ⇒ 1 aviso; republicar 3× ⇒ 1 linha de repo, PR nº estável, 1 entrega; `fallback_new_repo` não vira achado |
| C4/M7 aceites simultâneos | `C4/M7` | 6 aceites em corrida ⇒ 1 chamada de push; 5 entregas em corrida ⇒ 1 evento, 1 carimbo; 3 aceites repetidos ⇒ ainda 1 push |
| C5 merge no GitHub com a API fora | `C5` | `on` entrega; `shadow` não age; repetir ⇒ 1 evento |
| C6/A1 supersessão antes do merge | `C6/A1`, `A1 … blocked`, `A1 merge-watch` | card não vira `blocked`; merge posterior entrega; card já `blocked(child_archived)` é recuperado; rejeição segue morta; merge-watch observa o superado |
| C7 queda dentro de `deliverOne` | `C7` | rollback total; repetir entrega e carimba uma vez |
| M4 | `M4` | só `DONE`/`QA_PASS` não herdadas de card entregue |

Fora do api-node (runner Python, f4d): C8 a C11 e C13 do §3 da AF (seed/consolidação/flag no meio da run). C9 (backlog parcial) depende da M2, agora atômica no servidor. C12 (Guard) é herdado da Fase 3 e já coberto em `cardDelivery.pg…`.

## 4. Evidência de que os testes protegem (mutação)

Cada reversão abaixo foi aplicada isoladamente, a suíte rodada e o código restaurado:

| Mutação | Testes que falharam |
|---|---|
| B1 volta a decidir pela linha do filho e ignora `push_pending` | 7 (todos os B1, C1, C2, C3) |
| A1: `isSupersededChild` sempre falso | 2 (C6, A1 blocked) |
| Aceite sem o marcador `publish_state` | 1 (C1) |
| M7: aceite sem CAS | 1 (C4) |
| M1: detector devolve vazio | 2 (C1, C3) |
| A3: sem `card_id` por padrão | 1 |
| M2: sem `BEGIN/COMMIT` | 1 |

## 5. Riscos aceitos e pendências

- **M5** — a entrega só é percebida com `EVOLVE_RECONCILER=on` (ou `EVOLUTION_MERGE_WATCH=on`) quando o merge acontece no GitHub; em `shadow`/`off` o card fica `in_factory` (teste C5 documenta). **Pré-requisito da flag `CARDS_BANCADA`** para o tenant. Efeito colateral do fail-closed: com o reconciliador `off`, um marcador `pending` órfão (queda no aceite) nunca vira republicável sozinho; o card fica pendente, sem entregar falso.
- **M6** — `GENESIS_GITHUB_PUSH=off` ou tenant sem GitHub App **com repositório já existente na linhagem**: o aceite considera "publicado" (`skipped`), mas a entrega exige PR mergeado e fica `pending_merge` indefinidamente. É o lado seguro (nunca entrega falso); a dispensa explícita fica como follow-up. Ramo `fallback_new_repo` (linhagem sem repositório): vira `no_repo` após o push, sem PR por desenho.
- **M7** — só o CAS do aceite (trivial). O `SELECT` de status e o `UPDATE` ainda são dois comandos (o CAS fecha a corrida), mas `runEvolutionAcceptFlow` chamado fora do aceite (rota "Republicar" em paralelo ao aceite) não tem trava própria; anterior à Fase 4.
- **M3** (QA sem o tipo do card) e **A2** (prompt muda com ticket legado) são do runner (f4d), fora deste escopo.
- **Baixas não tratadas:** B-1 (consulta ao GitHub a cada passada, sem backoff nem persistir `evolution_merged_at` ao descobrir o merge), B-2 (não confere base/`head_sha` do PR), B-4, B-5, B-6.
- **Marcador novo** `extra.evolution_publish_state ∈ {pending, done, failed}` + `evolution_publish_at`: o portal não o lê; "Republicar" continua guiado por `evolution_push_pending`. Evoluções aceitas antes desta correção não têm marcador; a regra por linhagem cobre a entrega e o detector (b) cobre PR não registrado.
- `evolution_republished_at` continua sendo gravado quando `push_pending` era verdadeiro (inclusive na primeira publicação pós-reparo do reconciliador), sem mudança de semântica.

## 6. Arquivos

Alterados (sob `applications/services/api-node/src/`): `routes/projects.ts`, `routes/evolutionPlan.ts`, `services/cardDelivery.ts`, `services/cardState.ts`, `services/cardPromote.ts`, `services/evolutionAccept.ts`, `services/evolutionMergeWorker.ts`, `services/evolveReconciler.ts`; testes: `routes/cardDelivery.pg.integration.test.ts`, `routes/projects.tasks.card.pg.integration.test.ts`, `services/evolveReconciler.pg.integration.test.ts`, `services/projectsReaders.inventory.test.ts`. Novo: `routes/cardChaos.pg.integration.test.ts`.
