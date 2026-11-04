> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AF — Revisão adversarial da Fase 4 (Advisor)

**Escopo:** commits `f0f215f`/`fc8b622` (evo/f4a: tarefas 4.1/4.2) e `38d672f` (evo/f4b: 4.3/4.4), mesclados na `dev` em `4fd8110`. Li o código no worktree `~/workspace/current/zentriz/.worktrees/g-chk4`, sem alterar nada. Os relatórios AD e AE serviram só de mapa: cada afirmação abaixo foi conferida no código e, quando indicado, reproduzida em Postgres efêmero (`pgvector/pgvector:pg16`, `localhost:55440`, migrations até a 160, container removido ao final).

**Veredito: APROVADO COM CORREÇÕES.** As tarefas 4.1 e 4.2 podem seguir se A2 e A3 forem corrigidas. A 4.3 **não** pode ir para a 4.5 (homologação), para a 4.6 (caos) nem ter a flag ligada para qualquer tenant antes de corrigir B1 e A1. B1 marca como `delivered` um card cujo código nunca foi publicado, e a reprodução confirmou isso.

## 0. Evidência executada

| O quê | Resultado |
|---|---|
| `vitest` `cardDelivery.pg.integration` + `projects.tasks.card.pg.integration` (55440) | 14/14 verdes |
| `pytest orchestrator/tests/test_change_kind_f4a.py` | 17/17 verdes |
| **Repro B1** (`/tmp/af-repro/repro.mts`, fora do repo): pai com repositório, tenant com GitHub App, filho `accepted` com `evolution_push_pending=true` e sem linha própria em `project_github_repos` | `deliverCardsOfChild` → `[{result:"delivered"}]`; card `delivered`; evento `reason=accepted_no_repo`; GitHub nem consultado |
| **Repro A1** (`/tmp/af-repro/repro2.mts`): card `in_factory`, filho aceito com PR #7 aberto e depois arquivado por supersessão; o merge chega mais tarde (`evolution_merged_at`) | `syncCardsWithChildren` → card `blocked` (`child_archived`); depois do merge, `deliverCardsOfChild` → `[]`; o card fica `blocked` para sempre |
| `derive_change_context` com `extra` de ticket **legado** (sem card; `ticket_id/number/kind`, que `/evolve` grava desde a RFC-0009) | `spec_origin='card:TK-0003'` e instrução de 782 caracteres: o prompt muda com a flag desligada |

## 1. Achados por severidade

### Bloqueante

**B1 — `delivered` falso quando o filho não tem linha própria em `project_github_repos`.**
`services/cardDelivery.ts:54` decide que "não há repositório", e portanto que o merge está provado (`no_repo`), olhando só a linha **do filho**. O mesmo vale para `services/cardState.ts:313-314` (`hasRepo` do filho). Essa linha só nasce **depois** de um push de evolução bem-sucedido (`services/githubPush.ts:696`). Todo filho de card trabalha em branch git da linhagem, então a linhagem sempre tem repositório. Com isso, "filho sem linha" significa quase sempre "o código ainda não foi publicado". Cenários:
1. o push falha (rede, permissão, `apps/` vazio em `githubPush.ts:~676`) → `evolution_push_pending=true`, sem linha → o aceite chama `deliverCardsOfChild` (`routes/projects.ts:849-851`) → `delivered` (reproduzido). A checagem de `evolution_push_pending` (`cardDelivery.ts:58`) fica **depois** do retorno `no_repo` e nunca é alcançada;
2. corrida com o reconciliador: o aceite grava `status='accepted'` (`routes/projects.ts:~764`) **antes** do push, que roda em `setImmediate` e pode levar minutos. Uma passada de `deliverAcceptedCards` (`cardDelivery.ts:155-169`) nesse intervalo entrega o card;
3. a API morre entre o `UPDATE … accepted` e o push: o reconciliador entrega depois, e nada nunca é publicado.
O card vira `delivered` (estado terminal, que nem `reopenCardsOfChild` nem a máquina reabrem) e os arquivos de spec recebem `executed_*`. É exatamente o "falso executado" que o §1 proíbe. O teste e2e não pega o defeito: ele trata `accepted_no_repo` como comportamento esperado, com fixture sem repositório na linhagem e `runEvolutionAcceptFlow` mockado para `true` (`cardDelivery.pg.integration.test.ts:16-19,113-119`).
**Correção:** saber se "precisa de merge" pela **linhagem** (`findLineageRepo`) + instalação viva + `GENESIS_GITHUB_PUSH`, ou por um marcador explícito gravado pelo aceite (ex.: `extra.evolution_publish_mode ∈ {evolution, skipped_no_app, push_off}`); `evolution_push_pending` e "push não concluído" ⇒ `pending_merge`; aplicar a mesma regra em `childPrecondition`. Falta um teste com pai que tem repositório e filho sem linha (push falho, push em voo, `apps/` vazio).

### Alta

**A1 — Card fica em limbo ou vira `blocked` falso quando o filho é superado antes do merge** (reproduzido). Com `EVOLUTION_AUTO_MERGE` desligado (padrão), o PR do filho v2 (card Z) pode ficar aberto enquanto um card Y cria e aceita a v3 a partir da v2. `supersedeParent` arquiva a v2 (`evolutionAccept.ts:~132`). Na passada seguinte, `syncCardWithChild` trata `archived` como filho morto e leva Z a `blocked child_archived` (`cardPromote.ts:170-173`). `deliverCardsOfChild` e `deliverAcceptedCards` exigem `status='accepted'` (`cardDelivery.ts:82,160`), assim como o merge-watch (`evolutionMergeWorker.ts:35`): o merge posterior do PR da v2 nunca entrega Z. **Correção:** filho `archived` com `extra.superseded_by` conta como aceito para a entrega e não como morto no sync; incluí-lo na consulta do reconciliador.

**A2 — Regressão com a flag desligada: o prompt muda nas evoluções com ticket legado.** O runner chama `_apply_change_context` em toda evolução (`runner.py:6170`) sem consultar `CARDS_BANCADA`. `/evolve` legado (`routes/projects.ts:3674`) e o claim (`evolveClaim.ts:514`) gravam `ticket_id/ticket_number/ticket_kind` em qualquer evolução originada de ticket da RFC-0009, com ou sem card. Resultado: CTO, PM e Dev recebem as regras "Correção = patch mínimo / FAIL_TO_PASS", "Recurso novo = Non-goals" e "não refaça TSK-INH" num fluxo que o §1 manda manter inalterado. O banco continua idêntico porque a API descarta `card_id` (`projects.ts:568-572`), mas o comportamento do LLM não. O teste de byte-identidade (`test_change_kind_f4a.py:97-104`) compara código novo com código novo, sem ticket, e não cobre esse caso. **Correção:** só derivar quando o filho é de card (`extra.evolution_origin==='card'` ou `card_draft_project_id`), ou a API expõe o estado da flag para o runner. Adicionar um teste com `extra` de ticket legado ⇒ instrução vazia.

**A3 — O critério §1 "100 % das tasks de um filho têm `card_id`" não é atendido nem medido.** Só `TSK-EVO-*` recebe o vínculo (`runner.py:4196-4206`). Ficam sem `card_id`: `TSK-FULL-TEST` (dois caminhos: `runner.py:4239-4245` e `5349`), `TSK-DEVOPS-001` (`5192`, `7626`), `TSK-TRIVIAL-001` da consolidação GAP-NEW-3 (`7433`, que ainda CANCELA as `TSK-EVO` ligadas e cria uma task sem card), as tasks que o PM emitir com outro prefixo e as `TSK-INH-*`. Nenhum teste afirma o critério. **Ação:** o Jean decide entre (a) ligar ao card toda task não herdada do filho, mudança pequena nos 5 pontos de POST, ou (b) redefinir o critério ("100 % das tasks não herdadas"). Nos dois casos, um teste de contagem no seed real.

### Média

- **M1 — Card preso sem sinal após queda entre o registro do repositório e a gravação do PR.** `githubPush.ts:696` grava a linha do repositório antes de `openPullRequest` (`:702`), e `evolution_pr_number` só é persistido depois (`evolutionAccept.ts:262-275`). Se a API morrer entre esses passos: linha existe, PR não registrado, `push_pending` não marcado ⇒ `no_pr` para sempre. Republicar exige `push_pending`, e nada detecta nem notifica (fere o princípio 4). Cenário obrigatório na 4.6.
- **M2 — `POST /api/projects/:id/tasks` sem transação.** `CARD_MISMATCH` (`projects.ts:574-576`) ou uma violação de FK de `card_id` no meio do laço deixam as tasks anteriores gravadas. Diante de um não-2xx, o runner segue com o backlog **parcial** se existir qualquer task (`runner.py:7384-7390`), e as `TSK-EVO`/`TSK-FULL-TEST` posteriores somem sem aviso. Correção: validar tudo antes do laço, ou envolver o laço em `BEGIN/COMMIT`.
- **M3 — O QA não recebe o tipo do card.** `change_kind_inputs` chega ao CTO (`pipeline_context.py:404`), ao PM (`:467`) e ao Dev (`evolution_scope_inputs`, usado só em `runner.py:2533`). Na Correção, o aceite central (FAIL_TO_PASS) não é reforçado para quem valida. O Dev, por sua vez, recebe instruções de planejamento ("planeje primeiro a task…", "crie apenas TSK-EVO e cite o card no backlog") que não lhe cabem.
- **M4 — Tasks sem `executed_*`.** O plano 4.3 pede o carimbo nas tasks; a AE derivou "executada" de `project_id = child_project_id` de card `delivered`. Por essa regra, tasks `CANCELLED`/`QA_FAIL` também contam como executadas. Decisão do Jean pendente (registrada na AE §3), mas o critério literal não foi cumprido.
- **M5 — Entrega depende de flag não padrão.** Com `EVOLUTION_AUTO_MERGE` desligado (padrão), o caminho típico é o humano mergear no GitHub. Esse merge só é percebido com `EVOLVE_RECONCILER=on` (`evolveReconciler.ts:419-425`) ou com `EVOLUTION_MERGE_WATCH=on`. Em `shadow`/`off`, o card nunca chega a `delivered`. Documentar como pré-requisito da flag ou acoplar à ligação de `CARDS_BANCADA`.
- **M6 — Ramo `fallback_new_repo`** (linhagem sem repositório, `githubPush.ts:~664`): o filho ganha repositório novo sem PR ⇒ `no_pr` perpétuo, falso pendente. Com `GENESIS_GITHUB_PUSH=off`, o card é entregue como `no_repo` sem nada que registre a dispensa (ver a correção de B1).
- **M7 — Aceite sem CAS** (`projects.ts:~764`: `UPDATE … WHERE id = $3` depois de um `SELECT status` separado). Aceites concorrentes (Cyborg + humano) podem rodar `runEvolutionAcceptFlow` duas vezes: dois pushes, duas tentativas de PR e risco de CHANGELOG versionado duas vezes. É anterior à Fase 4, mas cai no critério §1 "aceite em corrida não duplica PR". O teste "aceite repetido" é sequencial e com o filho já aceito (não reproduzido em corrida).

### Baixa

- B-1: o reconciliador consulta o GitHub a cada passada para todo filho aceito pendente (limite 100), sem backoff e sem persistir `evolution_merged_at` quando descobre o merge (`cardDelivery.ts:62-64`).
- B-2: a prova de merge não confere a base (`dev`) nem o `head_sha` do PR contra `evolution_head_sha`.
- B-3: a API aceita `card_id` em qualquer prefixo (inclusive `TSK-INH-*`) e não confere `tickets.child_project_id = :id`: um runner antigo de um filho descartado ainda liga tasks ao card religado.
- B-4: a regra "compatibilidade no máximo patch" da Correção (`change_kind.py:28`) pode contradizer o `evolution_compat` do planner (RFC `minor`).
- B-5: "cite o card TK-NNNN no backlog" convida o LLM a deformar o ID (`TSK-EVO-TK0003-001`), que o regex `runner.py:3882` descartaria em silêncio. Sugiro "cite na descrição, nunca no ID".
- B-6: o comentário em `cardState.ts` ainda diz que a verificação é "da Fase 4" (registrado na AE).
- Vazamento de token/PII (item 5): **nada encontrado.** Prompts e títulos levam só `TK-NNNN` e o título do projeto (já existente); logs não incluem corpo do ticket nem credenciais; erros do GitHub são engolidos sem eco.

### Pontos conferidos e corretos
- O gate de RFC não é afrouxado: o texto só acrescenta exigências e afirma que o gate é invariante; o gate segue no api-node.
- O regex de ID não mudou (`runner.py:3882,3893,3904`).
- As `TSK-INH-*` DONE não são reenviadas pelo seed, e o upsert preserva status terminal.
- `delivered` não é reaberto por `reopenTicketsOfChild` (`tickets.ts:345-354` só toca `promoted|in_factory|blocked`) nem por `syncCardsWithChildren`. A entrega é atômica: transição + carimbo na mesma transação, `FOR UPDATE`, `dedupeKey`. Carimbo só onde é NULL.
- Merge sem aceite não entrega (`deliverCardsOfChild` exige `accepted`).
- Negativa do Guard ⇒ `blocked budget:*`, nunca `failed` (herdado da Fase 3, sem alteração).
- Prova cross-tenant do `card_id`: só o `extra.ticket_id` do próprio projeto.
- O checkpoint é carregado antes de `_apply_change_context` (`runner.py:5888` < `6170`): a retomada usa sempre o `extra` atual.

## 2. Testes que passam por natureza (não protegem)
1. `test_sem_tipo_nem_origem_prompt_byte_identico`: compara dois contextos do código novo, sem snapshot de antes da Fase 4 e sem o caso do ticket legado (A2).
2. `test_regex_de_id_de_task_nao_mudou` e a guarda enfraquecida em `cardsExpand.migration.pg.integration.test.ts:127`: checagens textuais estáticas.
3. Seed em Python com `_Store` falso, que reimplementa a semântica da API: não prova o contrato real. "Herdada não reenviada" é trivial, porque o BACKLOG do teste não tem `TSK-INH`.
4. E2E `cardDelivery`: `runEvolutionAcceptFlow` mockado ⇒ a ordem real aceite → push → entrega e a falha do push nunca rodam. A fixture sem repositório na linhagem **consagra B1**.
5. "Aceite repetido" no teste de idempotência: o filho já está `accepted`, a rota sai em "Projeto já aceito" e nem chama a entrega. A corrida real de aceites (M7) não é testada.
6. Corrida de `deliverCardsOfChild`: a AE admite que remover o `FOR UPDATE` não derruba o teste. Ele prova a serialização de `transitionCard`, não a do módulo.
7. Testes de `blocked`/`rejected`/legado: guardas da Fase 3 que já passavam antes (declarado na AE).

## 3. Cenários de caos para a 4.6 (priorizados)
Cada cenário deve terminar com: card no estado certo, sem `delivered` sem PR mergeado, 0 tasks duplicadas, ≤ 1 PR por filho, 1 evento por transição.

| # | Onde matar | Esperado | Risco ligado |
|---|---|---|---|
| C1 | API entre `UPDATE projects SET status='accepted'` e o `setImmediate` do push | card **não** `delivered`; republicação possível | B1 |
| C2 | Push em voo (branch criado, arquivos parciais) + passada do reconciliador | `pending_merge`, sem `delivered` | B1 |
| C3 | API entre `INSERT project_github_repos` e `openPullRequest` / `UPDATE extra.evolution_pr_number` | detectado e notificado; retomada abre ou reusa o PR, sem PR duplicado | M1 |
| C4 | Dois aceites simultâneos (Cyborg + humano) | 1 fluxo de aceite, 1 PR, 1 versão de CHANGELOG | M7 |
| C5 | Merge feito no GitHub com a API fora; volta com reconciliador `on`, `shadow` e `off` | `on` entrega; `shadow`/`off` documentados | M5 |
| C6 | Supersessão (v3 aceita) antes do merge da v2; depois merge da v2 | card da v2 `delivered`, não `blocked` | A1 |
| C7 | API dentro de `deliverOne` (entre a transição e o COMMIT) | rollback total; repetição entrega e carimba uma vez | atomicidade |
| C8 | Runner entre a escrita do `BACKLOG.md` e `_seed_tasks`; e entre o seed e `_inherit_parent_tasks` | retomada sem duplicar; `TSK-EVO` com `card_id`; `TSK-INH` DONE intactas | 4.2 |
| C9 | Runner no meio do POST de seed com erro 4xx/5xx parcial | sem backlog parcial silencioso | M2 |
| C10 | Runner durante a consolidação GAP-NEW-3 (cancelou as EVO, ainda não criou a TRIVIAL) | retomada consistente; vínculo com o card preservado | A3 |
| C11 | Flag `CARDS_BANCADA` ligada ou desligada no meio de uma run | tasks antigas sem card são completadas via COALESCE; nenhuma perde vínculo | 4.2 |
| C12 | Negativa do Guard durante o Dev, retomada, aceite | `blocked budget:*` → `in_factory` → `delivered`, nunca `failed` | §1 Custo |
| C13 | Card religado a outro filho enquanto o runner do filho antigo ainda posta tasks | tasks do filho antigo não contam para o card novo | B-3 |

## 4. Correções exigidas antes da 4.5/4.6
1. B1 (prova de merge pela linhagem + `push_pending` ⇒ pendente, nos dois pontos), com teste realista sem mock do aceite.
2. A1 (filho superado conta como aceito para a entrega).
3. A2 (gate do contexto de tipo no runner) + teste com ticket legado.
4. A3 (decisão do Jean + implementação ou redefinição do critério) + teste de contagem.
5. M1, M2 e M7 entram como cenários obrigatórios da 4.6; M5 vira pré-requisito documentado da flag.
