> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AI — Re-verificação das correções da Fase 4 (Advisor)

**Escopo:** correções da revisão AF mescladas na `dev` em `ec5ca7c`: `4eda944` (f4c, api-node, relatório AG) e `eaf17a5` (f4d, runner, relatório AH). O código foi lido no worktree limpo `~/workspace/current/zentriz/.worktrees/g-chk5`, sem nenhuma alteração. Os relatórios AG e AH serviram só de mapa. Cada afirmação abaixo foi conferida no código (arquivo:linha em `ec5ca7c`) e, quando indicado, reproduzida em Postgres efêmero (`pgvector/pgvector:pg16`, `localhost:55440`, migrations até a 160, container removido ao final). Produção não foi tocada.

**Veredito: APROVADO COM CORREÇÕES.** O cenário principal de B1 e o de A1 estão corrigidos, e as duas reproduções originais agora dão o resultado certo. Resta um caminho de `delivered` falso (N1, mesma classe de B1) no ramo `fallback_new_repo`. Ele impede ligar `CARDS_BANCADA` para qualquer tenant real. Não impede a 4.5, desde que as pré-condições do §5 sejam cumpridas.

## 0. Evidência executada

| O quê | Resultado |
|---|---|
| `vitest` `cardChaos` + `cardDelivery` + `projects.tasks.card` + `evolveReconciler` (55440), 7 rodadas | 51/51 em 5 rodadas; **1 falha intermitente em 3 rodadas** (ver N9) |
| `pytest test_change_kind_ah.py test_change_kind_f4a.py` | 32/32 |
| Repro B1 original (`/tmp/af-repro/repro_chk5.mts`) | `pending_merge`/`push_pending`, card `in_factory`, GitHub nem consultado: **corrigido** |
| Repro A1 original (`/tmp/af-repro/repro2_chk5.mts`) | sync não bloqueia; depois do merge, `delivered` (`accepted_genesis_merge`): **corrigido** |
| `derive_change_context` com `extra` de ticket legado | tudo `None`, `change_kind_inputs(None,None) == {}`: **corrigido** |
| **Repro N1** (`/tmp/af-repro/repro3.mts`): linhagem sem repositório, tenant com GitHub App, `runEvolutionAcceptFlow` **real**, criação do repositório falha (422) | `publish_state='done'`, 0 linhas em `project_github_repos`, card **`delivered` com `accepted_no_repo`**, detector M1 vazio |
| **Repro N2** (`/tmp/af-repro/repro4.mts`): evolução **legada** (sem card) aceita antes do Bloco 4, com repositório próprio e sem `evolution_pr_number` | `findIncompletePublications` → `pr_not_registered` (crítico). Em `on`, o detector marcaria `push_pending=true` |

## 1. Achados da AF → estado

| Achado AF | Estado | Evidência |
|---|---|---|
| **B1** `delivered` falso pela linha do filho | **Parcial** | Corrigido: decisão pela linhagem (`cardDelivery.ts:52-59`, `cardState.ts:178-190`); precedência de `push_pending`/`publish_state='pending'` (`cardDelivery.ts:51`); marcador `pending` na **mesma** escrita do `accepted` (`routes/projects.ts:799-808`); `done` só depois do PR registrado (`evolutionAccept.ts:296-299`). Não há janela entre `accepted` e o marcador. **Resta N1:** o ramo `fallback_new_repo` declara sucesso sem prova (`githubPush.ts:663-666`, `evolutionAccept.ts:262`) e entrega falso (reproduzido). |
| **A1** filho superado | **Corrigido**, com efeitos colaterais | `isSupersededChild`/`acceptedLikeChildSql` (`cardState.ts:164-171`). Não revive card rejeitado: `supersedeParent` só arquiva pai `accepted` sem `superseded_by` (`evolutionAccept.ts:132-135`); rejeição grava `card_rejected` sem `superseded_by`; `deliverCardsOfChild` ignora `card_state='rejected'` (`cardDelivery.ts:99`). Efeitos novos: N3 e N8. |
| **A2** prompt muda com ticket legado | **Corrigido** | `is_card_child` exige `evolution_origin=='card'` (`change_kind.py:54-67`). O marcador só nasce do claim de card (`evolveClaim.ts:515`). O teste novo compara com um contexto virgem, não com um snapshot pré-Fase 4 (continua fraco por natureza, mas cobre o caso). |
| **A3** `card_id` em todo não-INH | **Corrigido** (no servidor) | API: toda task não `TSK-INH-*` recebe o card quando a flag está ligada e o ticket é card **deste** filho (`projects.ts:565-599`); teste mede 0 órfãs. Runner: 5 pontos ligados. O Passo 7 (`runner.py:7646`, `TSK-DEVOPS-001`) ficou **sem** `_link_tasks_to_card`, mas a API cobre. A consolidação trivial é pulada para card (`runner.py:7419`). Projeto comum segue igual (ver B-c). |
| **M1** queda entre registro do repo e PR | **Corrigido**, com falso positivo | Detector Q7 (`evolveReconciler.ts:294-342`). Cobre C1 e C3. **Novo N2:** dispara em evoluções legadas e não filtra por card nem por flag. |
| **M2** POST `/tasks` sem transação | **Corrigido** | Valida tudo antes e grava em `BEGIN/COMMIT` (`projects.ts:579-632`). Os testes de `CARD_MISMATCH` e de CHECK no meio do lote falhariam sem a correção. Sem regressão: o `module` é o mesmo em todo o lote do seed (`runner.py:4264`). |
| **M3** QA sem tipo | **Parcial** | QA recebe `change_kind_inputs` (`runner.py:2664-2666`). O Dev ainda recebe as instruções de planejamento (admitido na AH). |
| **M4** tasks sem `executed_*` | **Parcial** | `listExecutedTasksOfCard` só conta `DONE`/`QA_PASS` não herdadas (`cardDelivery.ts:187-195`). **Nenhum consumidor** fora dos testes: o portal e a API não a usam. Decisão do Jean (coluna × derivação) ainda pendente. |
| **M5** entrega depende de flag | **Documentado, com erro** | A AG diz "`EVOLVE_RECONCILER=on` **ou** `EVOLUTION_MERGE_WATCH=on`". Com `EVOLUTION_AUTO_MERGE` desligado, o merge-watch devolve `skipped_flag` **antes** de consultar o GitHub (`evolutionMerge.ts:182-184`). Mesmo ligado, as travas de política (`blocked_compat_implicit` etc., `:220-233`) vêm antes da checagem `pr.merged` (`:275`). Só o reconciliador `on` entrega com segurança (N7). |
| **M6** `fallback_new_repo` / push off | **Não corrigido** | Ver N1 e N6. |
| **M7** aceite sem CAS | **Corrigido**, com regressão menor | CAS `WHERE status=$4 RETURNING` (`projects.ts:799-809`); teste com 6 aceites em corrida dá 1 push. Novo N4. |
| B-3 runner de filho descartado | **Parcial** | Só o caminho por padrão foi fechado. O `card_id` **explícito** é comparado com `extra.ticket_id` do próprio projeto (`projects.ts:595`), que o filho descartado ainda tem. Como o runner agora manda `card_id` em toda task, o filho antigo continua ligando tasks ao card religado. |
| B-1, B-2, B-4, B-5, B-6 | Não tratados | Declarado na AG. |

## 2. Achados novos por severidade

### Bloqueante (para ligar `CARDS_BANCADA` em tenant real)

**N1 — `delivered` falso no ramo `fallback_new_repo` (resíduo de B1, reproduzido).** Quando a linhagem não tem repositório e o tenant tem GitHub App, `pushEvolutionToGitHub` chama `pushProjectToGitHub` e devolve `{ ok: true, mode: "fallback_new_repo" }` **sem olhar o resultado** (`githubPush.ts:663-666`). `pushProjectToGitHub` engole qualquer erro (`githubPush.ts:~580-603`). O aceite grava `publish_state='done'` (`evolutionAccept.ts:262,296`). Sem linha própria e sem repositório na linhagem, `verifyChildPrMerged` devolve `no_repo` (`cardDelivery.ts:59`), e o card vai a `delivered` sem nada publicado. O detector M1 não vê o caso (`evolveReconciler.ts:322`). Gatilhos plausíveis:
- raiz criada antes da instalação da App;
- nome de repositório já existente (422);
- falha em `pushProjectFiles` depois de `createRepository`.

O §1 proíbe exatamente esse resultado. **Correção:** `fallback_new_repo` só conta como sucesso se a linha do filho foi gravada. Senão vira `pushOk=false` + `push_pending`. Para a entrega, um repositório próprio sem linhagem (push direto em `dev`, sem PR) deve ter regra explícita (ver N6). Falta um teste com o push real e o GitHub falhando.

### Alta

**N2 — O detector M1 muda o fluxo legado e gera falsos positivos (reproduzido).** `findIncompletePublications` (`evolveReconciler.ts:294-325`) varre **toda** evolução `accepted`, com ou sem card e com a flag desligada. O ramo (b), "repositório próprio, sem `evolution_pr_number`", vale para:
1. toda evolução aceita antes do Bloco 4 (`a568622`, 04/09), quando `evolution_pr_number` ainda não era gravado;
2. toda evolução cujo PR não abriu por falta da permissão "Pull requests" (`openPullRequest` devolve `ok:false` em `github.ts:719-726`, e o push segue `ok:true` sem `prNumber` em `githubPush.ts:734`) ou por não haver diff.

Em `on`, cada caso vira achado **crítico**, `push_pending=true`, mensagem no diálogo e e-mail. O botão "Republicar" reaparece em evoluções históricas, e clicar nele empurra um snapshot antigo para `evolution/vN` e abre PR contra `dev`. **Correção:** restringir (b) a filhos com `evolution_publish_state` gravado (aceites pós-correção) ou a filhos de card. Antes de qualquer `on`, rodar uma passada `shadow` em produção (somente leitura) e contar os achados.

### Média

- **N3 — O merge-watch passou a varrer evoluções legadas superadas** (`evolutionMergeWorker.ts:36`, sem filtro de card). Com `EVOLUTION_MERGE_WATCH=on` + `EVOLUTION_AUTO_MERGE=on`, o PR antigo da v2 pode ser **auto-mergeado** depois de a v3 virar a versão corrente. `tryAutoMergeEvolution` não confere status (`evolutionMerge.ts:171-190`). Se o merge da v2 for detectado tarde, `recordMergedAndHooks` regrava `sha_dev` da raiz com um SHA mais velho (`:404-409`) e roda os hooks pós-merge (`EVOLUTION_AUTO_REDEPLOY`/`REALIGN`) com a identidade da v2, o que pode reimplantar uma versão anterior. Restringir o superado à observação (`pr.merged`), sem auto-merge nem hooks, e só para filho de card.
- **N4 — O CAS do aceite devolve sucesso falso.** Se o status mudou entre o `SELECT` e o `UPDATE` sem ir para `accepted` (ex.: `running`→`completed`/`stopped` pelo runner, `pending_cyborg`→outro), o perdedor responde `200 {status:"accepted","Projeto já aceito"}` e o projeto **não** está aceito (`projects.ts:809`). Vale também para o fluxo legado. Reler o status e responder 409 (ou repetir o CAS uma vez) quando ele não for `accepted`.
- **N5 — Push mais lento que a carência (900 s) fica preso.** O detector marca `push_pending=true` com o push ainda em voo. Ao terminar, `runEvolutionAcceptFlow` só limpa `push_pending` se ele era verdadeiro **no início** (`evolutionAccept.ts:289`, `extra` lido em `:215`) e deixa `push_pending=true` + `publish_state='done'`. A entrega fica bloqueada (lado seguro), "Mergear agora" responde `NO_PR`, e um humano precisa republicar. Se "Republicar" rodar durante o push original, há dois pushes concorrentes sem trava (admitido na AG). Limpar `push_pending` incondicionalmente no sucesso, ou ligar a carência a um heartbeat do push.
- **N6 — Card pendente para sempre, sem sinal.** (a) `fallback_new_repo` bem-sucedido: o filho ganha repositório próprio, sem PR por desenho, e `verifyChildPrMerged` usa essa linha e exige PR (`cardDelivery.ts:53-61`) ⇒ `no_pr` perpétuo. A AG §5 afirma que "vira `no_repo` após o push", o que o código contradiz. (b) Push `skipped` (sem App ou `GENESIS_GITHUB_PUSH=off`) com repositório na linhagem ⇒ `no_pr` perpétuo. Nenhum dos dois é detectado: (a) é excluído pelo detector e (b) não tem linha própria. Fere o princípio 4 (nada silencioso).
- **N7 — O pré-requisito M5 está documentado errado.** Só `EVOLVE_RECONCILER=on` percebe o merge feito no GitHub (ver tabela do §1). Corrigir a AG e o checklist da flag.
- **N8 — PR da v2 fechado sem merge porque o conteúdo foi entregue pela v3.** A v3 empurra o snapshot completo de `apps/` (que inclui a v2) num branch novo a partir de `dev` (`githubPush.ts:682-690`). Se o humano mergear só o PR da v3 e fechar o da v2, o card da v2 fica `in_factory` para sempre, e o merge-watch reconsulta o PR fechado a cada tick. Decidir a regra: a entrega do superado também vale por merge do sucessor, ou o card vai a `blocked` com motivo explícito.

### Baixa

- **N9 — Teste intermitente por interferência entre arquivos** (observado em 3 de 7 rodadas): `cardDelivery…:238` ("card religado a OUTRO filho") recebeu `delivered`; numa rodada, o caso "falha da Fábrica ⇒ blocked" também falhou. As passadas globais de `deliverAcceptedCards`/`runReconcilerPass` do `cardChaos` (novo) e do reconciliador, sem filtro de tenant e sobre o mesmo banco, entregam o card na janela entre `mkCard` e o `UPDATE`. Não é defeito do produto (a consulta junta por `child_project_id` atual), mas deixa o CI instável. Usar `tenantId` nas passadas ou um banco descartável por arquivo.
- **B-a** — O log "filho de card: consolidação pulada" aparece também em projeto **comum** com ≤ 3 tasks (`runner.py:7419-7421`: `not _may(...) and active` é verdadeiro sem card). O comportamento está correto; a mensagem engana.
- **B-b** — `listExecutedTasksOfCard` sem consumidor (M4 "corrigido" sem efeito visível).
- **B-c** — Projeto comum: o prompt do QA não muda (`{}`), a consolidação trivial continua igual (> 3 tasks), `card_id` fica nulo. Sem regressão encontrada no runner.
- **B-d** — "Mergear agora" aceita um superado (`evolutionPlan.ts:231`) sem avisar que existe versão mais nova.

## 3. Testes que passam por natureza (restantes)

1. `test_a2_ticket_legado_prompt_identico_ao_pre_fase4` compara com um `PipelineContext` virgem do código **atual**, não com um snapshot anterior à Fase 4. Protege o gate, não a byte-identidade histórica.
2. A guarda estática dos pontos de POST no runner é textual. Ela não pegou a ausência do vínculo no Passo 7 (`runner.py:7646`).
3. O `cardChaos` simula `pushEvolutionToGitHub` inteiro (`cardChaos…:24-31`). O ramo `fallback_new_repo` e a falha real de `pushProjectToGitHub` nunca rodam, e por isso N1 passou.
4. O caso "`fallback_new_repo` não vira achado" só testa o detector, não a entrega. O código entrega `no_pr` perpétuo (N6a) ou falso (N1).
5. Nenhum teste cobre evolução legada no detector Q7 (N2), nem o merge-watch com legado superado (N3).

## 4. Cenários de caos C1–C13

| # | Estado | Observação |
|---|---|---|
| C1, C2, C3, C4, C5, C6, C7 | Cobertos no api-node (`cardChaos`) | C3 cobre só o ramo `evolution`; C5 confirma que `shadow` não entrega; C4 não cobre "Republicar" em paralelo ao aceite |
| C8, C10, C11, C13 | **Não executados** | Runner: a AH não tem caos; a AG os declara fora de escopo. C13 continua aberto (B-3 parcial) |
| C9 | Parcial | O servidor ficou atômico (M2); o runner sem backlog vai a `failed` → card `blocked child_failed` (`runner.py:7401-7410`). Não há teste de kill no meio do POST |
| C12 | Herdado da Fase 3 | Sem alteração |
| **Faltantes** | — | `fallback_new_repo` com falha (N1); push > carência (N5); legado no Q7 (N2); superado com auto-merge (N3); PR da v2 fechado (N8) |

## 5. A 4.5 pode começar?

**Sim, condicionada.** As três execuções reais com LLM em homologação podem começar se **todas** as condições abaixo forem verificadas antes de cada execução (elas excluem os caminhos de N1, N6 e N7):
1. o produto de teste tem repositório registrado na **raiz** (`project_github_repos` da raiz), e o tenant tem GitHub App ativa com permissão "Pull requests: Read & write";
2. `GENESIS_GITHUB_PUSH=on` e `EVOLVE_RECONCILER=on` no ambiente de homologação (não depender do merge-watch);
3. `EVOLUTION_AUTO_MERGE` e `EVOLUTION_AUTO_REDEPLOY` desligados durante a 4.5 (evita N3);
4. o ambiente de homologação não pode ter evoluções legadas antigas no mesmo banco, ou o Q7 roda em `shadow` (evita N2);
5. ao final, conferir para cada card: `delivered` ⇔ PR mergeado no GitHub; nenhuma task não herdada sem `card_id`; `executed_*` carimbado uma vez.

**Antes de ligar `CARDS_BANCADA` para tenant real (e para fechar a 4.6):** corrigir N1 (bloqueante) e N2 (alta), tratar N4 e N5, decidir N6/N8, corrigir a documentação de M5 (N7) e executar C8–C11 e C13 no runner.

## 6. Arquivos de reprodução (fora do repo)

`/tmp/af-repro/repro_chk5.mts` (B1), `repro2_chk5.mts` (A1), `repro3.mts` (N1), `repro4.mts` (N2/N3), `migrate.mts` (aplica as migrations no 55440).
