> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AK — Correções N1–N8 da re-verificação da Fase 4

**Base:** `ad4f3de` (branch `evo/f4e`, worktree `.worktrees/g-f4e`). Origem: `EVOLUIR-PROJETO-AI-reverificacao-fase4.md`. Sem push e sem produção. Verificação em Postgres efêmero (`pgvector/pgvector:pg16`, 55440 e 55432), containers removidos ao final.

## 1. Correções (achado → o que mudou → onde)

| Achado | Correção | Arquivo |
|---|---|---|
| **N1** (bloqueante) | `pushProjectToGitHub` deixa de devolver `void`: devolve `{ok, error?}` (o erro continua engolido para não derrubar o aceite HTTP, mas deixa de ser escondido). `pushEvolutionToGitHub` no ramo `fallback_new_repo` só devolve `ok:true` se `ok` **e** a linha do filho em `project_github_repos` existe; senão `{ok:false, mode:"fallback_new_repo", error}` + diálogo. `runEvolutionAcceptFlow` deixa de contar `fallback_new_repo` como sucesso: falha ⇒ `push_pending=true` + `publish_state='failed'`, pai **não** é superado. `verifyChildPrMerged` passa a tratar também `publish_state='failed'` como `push_pending`. | `services/githubPush.ts` (retorno e ramo fallback), `services/evolutionAccept.ts` (`pushOk`), `services/cardDelivery.ts` |
| **N6a** | Sucesso do fallback grava `evolution_publish_mode='direct_dev'` (repo novo, push direto em `dev`, sem PR por desenho). `verifyChildPrMerged` aceita `direct_push` (`required:false`) só com linha própria + `publish_state='done'` + modo `direct_dev`. Reason do evento: `accepted_direct_push`. | `evolutionAccept.ts`, `cardDelivery.ts` |
| **N6b** | Push `skipped` com repositório na linhagem grava `publish_mode='skipped'` e o card continua pendente (`no_pr`, lado seguro). Novo achado crítico `card_published_without_pr` no reconciliador (`shadow` e `on`, entra no e-mail de operações): filho de card aceito/superado, `done`, sem PR, sem linha própria, com repositório na linhagem, após a carência. **Só alerta** (não marca `push_pending`, porque republicar com o push desligado repetiria o `skipped` e o achado oscilaria). Some sozinho quando o PR é registrado/mergeado. | `services/evolveReconciler.ts` (`detectCardPublishedWithoutPr`) |
| **N2** | Q7 (`findIncompletePublications`) restrito a filho de card (`evolution_origin='card'` **e** ticket com `card_state` não nulo) **e** tenant com `CARDS_BANCADA` ligada; filho `direct_dev` também fora. Legado nunca vira achado, e-mail, diálogo nem `push_pending`. | `services/evolveReconciler.ts` (`CARD_CHILD_SQL`, `flagEnabled`) |
| **N3** | O observador de merge só varre superado se for filho de card (`evolution_origin='card'`), e **só observa**: nova `observeEvolutionMerge` nunca chama `mergePullRequest`/`updatePullRequestBranch`; para superado, `recordMergedAndHooks(..., {recordOnly:true})` registra o fato e entrega o card, **sem** regravar `sha_dev` da raiz e **sem** hooks pós-merge (nada de reimplantar versão anterior). Legado superado deixa de ser varrido. | `services/evolutionMergeWorker.ts`, `services/evolutionMerge.ts` |
| **N4** | CAS perdido: relê o status; só responde 200 "já aceito" se for `accepted`; senão **409 CONFLICT** ("o projeto NÃO foi aceito"). | `routes/projects.ts` (aceite) |
| **N5** | O fim de um push bem-sucedido limpa `evolution_push_pending` **incondicionalmente** e grava `publish_state='done'` (o `extra` lido no início pode estar velho se o detector marcou durante o push). `evolution_republished_at` só se havia pendência. Dois pushes concorrentes (Republicar durante o push original) seguem sem trava: **risco aceito** (admitido na AG). | `services/evolutionAccept.ts` |
| **N7** | Texto corrigido na AG (M5): o pré-requisito real é `EVOLVE_RECONCILER=on`. Além disso, o merge-watch agora detecta merge externo de filho de card **sem** `EVOLUTION_AUTO_MERGE` (`observeEvolutionMerge` quando o auto-merge devolve `skipped_flag`). Legado aceito mantém o comportamento anterior. | `AG` linha M5; `evolutionMergeWorker.ts` |
| **N8** | **Regra escolhida (mínima e segura):** filho **superado** cujo PR foi **fechado sem merge** é entregue por `successor_merged` somente se alguma versão sucessora (cadeia `superseded_by`, até 5 elos) está mergeada (merge do Genesis registrado ou PR mergeado no GitHub), sem `push_pending`/`pending`/`failed`. Justificativa: o push da sucessora leva o snapshot completo de `apps/` (inclui a versão anterior). PR da v2 ainda **aberto** continua pendente (ninguém decidiu); sucessor não mergeado ⇒ `pr_closed_successor_not_merged` (pendente, sem falso). Reason: `accepted_successor_merged`. O observador continua reconsultando PR fechado a cada tick (custo baixo, sem efeito). | `services/cardDelivery.ts` (`successorMerged`) |
| **Runner** | `TSK-DEVOPS-001` do Passo 7 passa por `_link_tasks_to_card(..., *_card_link_args(pipeline_ctx))`. A guarda estática antiga (contagem de chamadas) não pegava; a nova varre **todo** `{"tasks": ...}` do `runner.py` (exceções explícitas: herdadas e `_seed_tasks`). | `orchestrator/runner.py:7657`; `orchestrator/tests/test_change_kind_ak.py` |
| **B-3** | `card_id` explícito só vale para o filho ATIVO do card: se o ticket é card (`card_state` não nulo) e `child_project_id` ≠ projeto, o vínculo é descartado (task fica sem card; 201, sem derrubar o runner do filho descartado). Ticket legado mantém o comportamento anterior. | `routes/projects.ts` (POST `/tasks`) |
| **M4** | `listExecutedTasksOfCard` ganhou consumidor: ao entregar (transição aplicada agora), grava no diálogo do filho "Card entregue: N task(s) executada(s) — ...". **Não** foi exposta no `GET /api/cards/:id`: o contrato dos cards está congelado em fixtures do portal (`cards.contract`, testado: o campo extra quebrou o contrato). Decisão coluna × derivação segue com o Jean. | `services/cardDelivery.ts` (`reportExecutedTasks`) |

## 2. Estabilidade do CI (N9) — documentado, infra intocada

Duas passadas globais (`deliverAcceptedCards`, `runReconcilerPass`, `reconcileEvolutionMerges`) no **mesmo banco** colidem: elas varrem fixtures de outros arquivos. **Cada vitest que dispara passada global precisa de banco próprio.** O novo `cardChaos.ak.pg.integration.test.ts` já usa `createScratchDb` (CREATE DATABASE + `initDb`); `cardChaos.pg.integration.test.ts` continua no banco compartilhado e já filtra por `tenantId` onde possível. Também: as 4 suítes de porta fixa (`llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback`) exigem o Postgres em **55432**; rodar tudo em 55440 as faz falhar por conexão, não por defeito. Duas execuções globais simultâneas no mesmo Postgres não são suportadas.

## 3. Testes

- Novo `routes/cardChaos.ak.pg.integration.test.ts` (13 casos, banco descartável, **push real** por padrão): N1 (push real + 422), N1/N6a, N6b, N2 (legado com a flag do tenant ligada, tenant com a flag desligada e controle), N3 (legado superado não varrido; superado só observado), N7, N4 (gate no SQL do aceite), N5 (detector marca com o push em voo), N8 (2 casos, inclui cadeia v2→v3→v4), M4, B-3.
- `test_change_kind_ak.py` (2 casos). `cardChaos.pg.integration.test.ts`: `mkCard` agora grava `evolution_origin='card'` e a flag do tenant (necessário pelo N2). `projectsReaders.inventory.test.ts`: exceções atualizadas (chave de `cardDelivery.ts` e nova de `evolutionMerge.ts`, ambas consulta por id).
- **Vermelho antes / verde depois:** com todo o código de produção da AK stashado, os 13 casos falham; com a correção, passam.
- **Mutações** (cada uma reintroduz o defeito e derruba o caso correspondente): `fallback_new_repo` volta a ser sucesso ⇒ N1 falha; remove o filtro de card do worker ⇒ N3-legado falha; remove o filtro de card do Q7 ⇒ N2 falha; remove a limpeza incondicional de `push_pending` ⇒ N5, N1/N6a e N6b falham; desliga o ramo `closed` do N8 ⇒ 2 casos N8 falham; N4 volta a responder 200 ⇒ N4 falha; remove a guarda B-3 ⇒ B-3 falha. (Na primeira rodada a mutação do filtro de card do Q7 NÃO derrubava o teste N2, porque o legado do teste não tinha a flag do tenant ligada; corrigido o teste para legado com flag ligada.)

## 4. Contagens

| Suíte | Antes | Depois |
|---|---|---|
| vitest api-node (55440 + 4 suítes em 55432) | 4069 passaram, 1 pulado | **4082 passaram, 1 pulado** (+13), 243 arquivos, 0 falha |
| `tsc --noEmit` | limpo | limpo |
| pytest orchestrator (baseline em worktree limpo `ad4f3de`, venv `/tmp/pyv`) | 23 falhas de ambiente, 1221 passam | 23 falhas **idênticas** (diff da lista vazio), **1223** passam (+2) |

## 5. Riscos aceitos / pendentes

1. **Push concorrente** (Republicar durante o push original, N5): sem trava; o último a terminar vence. Admitido desde a AG.
2. `card_published_without_pr` só alerta; o card fica pendente até um humano agir (registrar PR, republicar com o push ligado ou rejeitar).
3. `direct_dev` entrega sem PR por desenho: o push cria o repositório e escreve `dev` direto; não há revisão humana do diff (coerente com o fluxo de projeto novo).
4. N8 pressupõe que o snapshot da sucessora contém a versão anterior; se alguém editar à mão a sucessora retirando código da v2, a entrega da v2 seria declarada mesmo assim.
5. O merge-watch reconsulta PRs fechados de superados a cada tick (sem efeito; custo de API baixo).
6. M4 fica no diálogo, não no contrato HTTP: o portal só ganha o dado numa mudança de contrato (fixtures) decidida pelo Jean.
7. B-1, B-2, B-4, B-5, B-6, B-a, B-d e os cenários C8–C11/C13 no runner seguem fora do escopo desta frente.
8. `EVOLVE_RECONCILER=on` continua sendo o pré-requisito documentado para entrega por merge externo; antes de ligar em produção, uma passada `shadow` para contar achados (agora filtrados por card/flag).
