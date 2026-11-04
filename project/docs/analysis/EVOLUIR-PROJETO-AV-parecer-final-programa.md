> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AV — Parecer final do Advisor sobre o programa "Evoluir projeto na Bancada com cards"

Data: 2026-11-04 · Papel: Advisor (revisor adversarial independente) · Base lida: worktree limpo `~/workspace/current/zentriz/.worktrees/g-fin` em `ef25bf9` (dev local, **183 commits à frente de `origin/dev`**, nunca empurrados) · Escopo: o programa inteiro contra os critérios §1 do [plano](../plans/EVOLUIR-PROJETO-BANCADA-plano.md), não só as últimas frentes · Modo: somente leitura no código; este relatório é o único arquivo gravado.

> **Veredito: NÃO PRONTO PARA PRODUÇÃO** (nem para ligar `CARDS_BANCADA` em tenant de cliente). O encanamento (estados, idempotência do lado da API, rastreabilidade de `card_id`, `delivered` ⇔ merge, migrations) está sólido e bem testado. O que falta é exatamente o que o plano pôs como portão: o **gate F4 de qualidade não foi cumprido** (0 de 4 execuções reais com todos os critérios binários em PASS; as correções AT/AU nunca rodaram em execução real), o **executor de testes do host roda código do produto no host do control plane** (bloqueante de segurança para conteúdo de cliente) e o código traz **mudanças de comportamento globais, fora da flag por tenant**, que alteram o fluxo legado em produção. A §6 lista o caminho objetivo até "pronto com condições".

---

## 1. Como este parecer foi produzido (e o que não foi feito)

- Quatro frentes de verificação em paralelo (regressão/rastreabilidade; idempotência/caos/migrations; segurança; custo/qualidade/docs), cada uma obrigada a citar `arquivo:linha`. Conferi pessoalmente no código os achados de severidade alta e bloqueante antes de registrá-los (marcados **[conferido]**).
- Testes executados nesta revisão (não reaproveitados de relatórios): **212/212** testes de integração em Postgres efêmero (porta 55440, container derrubado) em 13 suítes (`cardChaos`, `cardChaos.ak`, `projects.evolve.claim(.m)`, `cards`, `cardState`, `cardDelivery`, `budgetResume`, `cardsOff.regression`, `cardsExpand.migration`, `evolveReconciler`, `evolve.promote`, `cardBudget.f5`); migrations 141–162 aplicadas **duas vezes** e reaplicadas após apagar os 13 registros (idempotência provada); pytest direcionado **88/88** (`test_aq_correcoes_qa_escopo_baseline`, `test_context_files_n1`, `test_fts_n2_n3_n4_n7`, `test_n3_n4_n5_n7_orchestrator`, `test_change_kind_{f4a,ah,ak}`). Duas reproduções de defeito: `_is_qa_pass` (achado A-1) e `transitionCard` com chave de dedupe repetida (achado A-2).
- **Não feito:** nada em produção; nenhum LLM; nenhum push; não consultei `schema_migrations`, tamanho de tabelas, firewall nem o unit do FTS em `3.220.66.113`.

## 2. Critérios §1 do plano (e itens transversais pedidos)

| # | Critério (medida do plano) | Estado | Evidência |
|---|---|---|---|
| 1 | **Sem regressão** com `CARDS_BANCADA` desligada para o tenant | **Parcial** | Rotas HTTP de card e `/evolve` com card estão atrás da flag por tenant (`services/featureFlags.ts:96-136`, `configOnly` em `:42`; 404 em `routes/cards.ts:57`; prompts byte-idênticos fora de card, `orchestrator/change_kind.py:56-80`, testes `test_change_kind_f4a.py:97`, `test_change_kind_ah.py:56`). **Mas** há mudanças de comportamento da Fábrica **globais ou incondicionais** que atingem todo projeto, legado e greenfield (A-4), e **não existe** a suíte de regressão do legado prevista (HTTP + banco + disco); só há `cards.pg.integration.test.ts:132,152`, `projects.evolve.claim.pg.integration.test.ts:600` e `revisaoM.flags.pg…`. O cenário dourado (0.5) não foi encontrado como teste |
| 2 | **Rastreabilidade**: 100 % das tasks do filho com `card_id`; 100 % dos arquivos de spec com `spec_origin` | **Parcial** | `card_id`: correto para tasks não herdadas (`runner.py:4359-4371`, `routes/projects.ts:587-606`); `TSK-INH-*` ficam sem, por decisão do orquestrador (runbook A2), reinterpretando o "100 %" do plano sem registro no plano. `spec_origin`: só o backfill pontual ao ligar a flag (`cardsBackfill.ts:112-160`) e os arquivos do card no filho (`evolveClaim.ts:990,999`); **gravam NULL** a herança HEAD→filho (`evolveClaim.ts:925`), produto novo (`projectCreation.ts:254`), chat/GAPs (`specAutonomy.ts:2971`), planner (`evolutionPlanner.ts:394`), aceite/CHANGELOG (`evolutionAccept.ts:104`), entre outros. Nenhum teste afirma os 100 % (M-6) |
| 3 | **Idempotência**: repetir criação/promoção/aceite N vezes e em corrida não duplica filho, task nem PR | **Atendido no lado API, com um defeito** | CAS + `FOR UPDATE` + `ON CONFLICT uq_tce_dedupe` (`cardState.ts:230-313,370-376`), chave `delivered:${childId}` (`cardDelivery.ts:170`), claim com advisory lock + lease (`evolveClaim.ts:48`); matriz coberta por `cardChaos*.pg`, `cards.pg:263,324`, `evolve.claim*.pg` (212/212 verdes). **Defeito A-2**: chaves de dedupe permanentes e mal escopadas impedem o card de voltar a `blocked` |
| 4 | **Resiliência**: matar runner/api em cada etapa e retomar sem perda nem duplicação | **Parcial** | Lado API coberto (C1–C7, crash entre passos da promoção, 19 pontos de crash do claim). **Runner sem teste**: C8, C10, C11, C13 (e C9 só parcial); nenhum teste mata o runner no meio do pipeline de Fábrica. O próprio runbook exige estes cenários antes de ligar (`CARDS-BANCADA-RUNBOOK.md:509`) |
| 5 | **Qualidade (gate F4)**: ≥ 3 execuções reais, uma por tipo, cada uma com P2P sem regressão, F2P PASS, 0 violações de escopo, `TSK-FULL-TEST` PASS, aceite do Cyborg sem intervenção, custo ≤ orçamento | **Não atendido** | §3 abaixo: **0 de 4** execuções com todos os binários em PASS; `TSK-FULL-TEST` **nunca** executou de fato; baseline **nunca** chegou a `ok`; P2P só "passou" por medição manual do agente fora do sistema; escopo violado em 2 de 4 (TK-0001 e TK-0004); intervenções humanas fora do fluxo em 4 de 4 (`confirm:"MERGE"`, `chown`, remoção de checkpoint e `node_modules`, esperas manuais pelo teto horário) |
| 6 | **Custo**: nenhum card executa sem orçamento explícito; negativa do Guard ⇒ `blocked`, nunca `failed` | **Parcial** | Atende: `402 BUDGET_MISSING` na criação (`routes/cards.ts:292-296`), preflight na promoção (`cardService.ts:421`), constraint que impede `card_state='failed'`, kill switch padrão `on` e checagem `!== "off"` (`llmGuard.ts:57,382`), preflight fail-closed (`:468-472`). **Falha**: segunda negativa no mesmo filho não leva a `blocked` (A-2); negativas de plataforma (`KILL_SWITCH`/`GUARD_ERROR`/`GLOBAL_*`) param o filho sem `stopped_by='budget'` e o card fica `in_factory` invisível (`runner.py:4490-4500`, `cardPromote.ts:178`); uma estimativa absurda pausa o dono e **toda a linhagem** (`llmGuard.ts:440-445`) [conferido] |
| T-1 | Segurança | **Parcial (com bloqueante)** | Autorização por tenant nas rotas novas está correta (§4, S-ok). Executor de testes do host é RCE por desenho (B-2) |
| T-2 | Migrations 141–162 | **Atendido com condições** | Idempotentes (provado), expand, sem `DO $$` nem `;` em literal; condições em §5 |
| T-3 | Dívida e decisões do Jean | **Abertas** | §5 |
| T-4 | Coerência docs × código | **Parcial** | 6 de 8 afirmações conferem integralmente, 1 confere com linha divergente, 1 confere com ressalva; 6 divergências adicionais de documentação (§5) |

## 3. O que as execuções reais provaram e o que só foi provado offline

| Item | 4.5 (AP: TK-0001/2/3) | 4.5b (AS: TK-0004) | Depois da 4.5b (AT/AU, commits `3847a6f`, `3384b48`, `890810c`) |
|---|---|---|---|
| Estados, `delivered` ⇔ merge, `TK-NNNN`, `executed_*` único, sem duplicação | Provado (3/3) | Provado | — |
| `card_id` em tasks não herdadas | Provado | Provado | — |
| Herança transitiva | Não (flag off) | Provado (3 herdadas) | — |
| Compat explícito (D-6), `connect.yaml` (D-7) | Falhou | Provado | — |
| QA com veredito | **Falhou 9/9** | "Provado" n=1, **mas a prova é fraca**: `_is_qa_pass` aprova por substring (A-1), então um QA_FAIL com "token"/"ok" no resumo também teria virado `QA_PASS` | Não reexecutado |
| `TSK-FULL-TEST` executado e PASS | **Falhou** (`DONE` sem executar) | **Não executado** (502: slot Bedrock por instance role não dirige o executor; fail-closed por política) | Só melhora a mensagem (`_slot_unusable_reason`); **execução real continua impossível no dev** sem decisão de política (chaves no slot ou slot Anthropic/Foundry) |
| Baseline/P2P medidos pelo sistema | **Falhou** (`Connection refused`) | **Falhou** (`npm` EACCES; depois `no_tests` com jest quebrado) | Cópia gravável (N-2), `no_tests`→`error` (N-4), remedição (N-5): **só offline** |
| 0 violações de escopo | **Falhou** (TK-0001: 4 specs reduzidos + 1 arquivo de produção, mergeado em `dev`) | **Falhou** (`pnpm-lock.yaml` +5.486) | Gate de árvore do Cyborg, lockfile no build e no publicador, escopo por diff real no PR: **só offline**; o gate de escopo do Cyborg da AQ (D-1) **nunca foi exercitado** |
| Contexto do Dev sem `node_modules` | — | **Falhou** (8,7 M tokens estimados ⇒ pausa da linhagem) | `context_files.py`: só offline |
| Custo ≤ teto do card | Provado (US$ 8,37 / 7,15 / 4,92 de 10,20) | Provado (US$ 3,62) | — |
| Aceite do Cyborg sem intervenção humana | PASS formal, mas o merge exigiu `confirm:"MERGE"` nos 3 | PASS formal, merge com `confirm` | — |

**Conclusão do gate F4.** Nenhuma das quatro execuções atende ao conjunto binário do plano §1. O que está provado em execução real é o **encanamento**; a **qualidade da entrega** (QA, FULL-TEST, P2P, escopo) está provada apenas por testes unitários/integração e por mutação. Pior: as correções que tornariam o gate alcançável (AT/AU) entraram **depois** da última execução real e dependem de rebuild de `api`/`agents`/`runner` e de reiniciar o FTS. Declarar F4 cumprido seria fabricar o check.

## 4. Achados novos (por severidade)

### Bloqueantes

**B-1 — Gate F4 não cumprido** (critério 5; §3). Cenário: ligar em tenant real sem P2P medido, sem FULL-TEST executado e com escopo violado em 50 % das execuções reais ⇒ PRs contaminando a `dev` do cliente, exatamente o R-1 da AP (que no repositório de teste exigiu um PR de reversão, `8cef8f8`, e ainda deixou `pnpm-lock.yaml` indevido em `dev`, `8866b8b`).

**B-2 — O servidor de testes do host executa código do produto no host do control plane** [conferido]. `scripts/full-test-server.py:858-936` roda `npm ci`/`npm install` (scripts de pós-instalação) e `npx jest`/`vitest`/`npm test` como subprocesso direto, sem container; o unit `scripts/genesis-full-test.service.template:31` roda como `User=ubuntu`, e o próprio template (`:12-13`) registra que o unit real de produção carrega chaves `AKIA…` estáticas em `Environment=`. O usuário `ubuntu` está no grupo `docker` (conferido no dev: gid 988). Cenário de ataque: um autor de card (usuário do tenant) pede "inclua um teste que…"; o LLM gera teste ou `postinstall` maliciosos (ou é induzido por injeção no texto/anexo do card); a baseline ou a medição final executa o código no host ⇒ `docker exec` no Postgres multi-tenant, leitura de `/opt/zentriz-secrets/*.pem`, IMDS da instance role, `~/.ssh`/`~/.aws`. O `/run-tests` já existia, mas **o programa o tornou obrigatório** (rollout P3; baseline "reprova alto" sem ele). A cópia gravável do N-2 (`:687-707`) não isola nada.

### Altas

**A-1 — `_is_qa_pass` aprova reprovações por substring** [conferido, reproduzido]. `orchestrator/runner.py:3458-3470`: com veredito válido, `any(k in summary for k in ("aprovado","passou","ok",…))` casa "t**ok**en", "lo**ok**", "b**ook**", "não **passou**", "Não **aprovado**". `{"status":"QA_FAIL","summary":"Falha: o token JWT não é validado"}` ⇒ `True` ⇒ task `QA_PASS`/`DONE` (`runner.py:4919-4925`). O QA_FAIL forçado pelo fingerprint T-08 (`runner.py:4855-4863`) escreve "missing strong **tokens**" e é **sempre** neutralizado. Defeito herdado (fev/2026), mas invalida a afirmação "QA provado" da 4.5b e o texto "QA passou" do PR. Correção: decidir pelo `status` normalizado; summary nunca promove a PASS; teste com os três casos.

**A-2 — Chaves de dedupe permanentes impedem o card de voltar a `blocked`** [conferido; reproduzido em Postgres real pela frente de idempotência]. `cardState.ts:247-248` devolve `noop dedupe_key_replayed` mesmo depois de o card sair e voltar ao estado (comportamento exigido por `cardState.pg.integration.test.ts:142`). Os chamadores usam chaves que se repetem legitimamente: (a) `cardPromote.ts:174` `child_${status}` **sem o id do filho**: card bloqueado por `child_failed` → reaberto → promovido para um 2º filho → 2º filho falha ⇒ noop, card `in_factory` com filho morto; (b) `cardPromote.ts:183,196` `budget_stop:${child}:${code}`: pausa → retomada humana (`budget/resume`) → **segunda** pausa no mesmo filho (o cenário N-1 da 4.5b) ⇒ noop, card `in_factory` com filho parado. Viola o critério de Custo ("negativa ⇒ `blocked`"). `syncCardWithChild` repete sempre a mesma chave e nenhum detector do reconciliador cobre "card `in_factory` com filho morto/parado" (`evolveReconciler.ts:217-394`). Correção: chave com id do filho + carimbo da ocorrência (ex.: `budget_paused_at`); testes pausa→retomada→pausa e falha do 2º filho; detector no reconciliador.

**A-3 — Caos do runner sem teste** (critério 4; plano 4.6). C8 (runner morto entre `BACKLOG.md`, seed e herança), C10 (consolidação GAP-NEW-3), C11 (flag ligada/desligada no meio da run), C13 do lado runner: nenhum teste em `applications/orchestrator/tests`; C9 só parcial (servidor atômico, sem kill). Nenhum teste mata o runner no meio do pipeline.

**A-4 — Mudanças globais/incondicionais alteram o fluxo legado (fora da flag por tenant)** (critério 1). Incondicionais: QA sem veredito ⇒ `BLOCKED` em todo projeto (`runner.py:4885-4905`), reaberto pelo watcher do Cyborg com rework em Opus (`zentriz_cyborg.py:977-1036`, custo); `TSK-FULL-TEST` não executada ⇒ `CANCELLED` também em greenfield (`runner.py:3404-3440`); `POST /tasks` em transação única (`projects.ts:612-640`); índices de unicidade no boot. Env global com padrão **ligado**: `EVOLUTION_P2P_REQUIRED=1` ⇒ em toda evolução legada, baseline `no_tests`/`error` vira `QA_FAIL` + escalonamento (`runner.py:700-727,5901-5902,6503-6525`) e, **se o FTS não estiver no ar no host de produção** (default `host.docker.internal:7878`, `docker-compose.yml:86,252`; não verificado em prod), **toda** evolução sai reprovada; `CYBORG_TREE_GATE=on` remove lockfiles novos também em produto novo (`cyborg_v3.py:2023-2037,2060`); teto de contexto 1,5 MB / 3000 arquivos (`context_files.py:74-95`) leva o Dev a `BLOCKED` em projeto grande que antes seguia (`runner.py:5103-5105`); `/effective-flags` com 5xx duas vezes ⇒ `SpecReadError` ⇒ projeto `failed` mesmo com todas as flags desligadas (`runner.py:1006-1043,6033-6041`), cenário concreto durante o próprio deploy api→agents. Algumas mudanças são melhorias de verdade, mas o critério do plano é "sem alteração com a flag desligada" e nada disso tem teste de não regressão do legado nem decisão registrada.

**A-5 — Teto horário global dispara o kill switch de toda a plataforma** [conferido]. `llmGuard.ts:384-390` ⇒ `tripKillSwitch` (`:296-307`) até um humano religar. Com cards a US$ 5–8 em ~16 min (AP), ~5 cards simultâneos de **quaisquer** tenants (padrão US$ 40/h, `:58`; US$ 12/h no dev) derrubam todo o LLM do Genesis: um tenant nega serviço a todos. Fail-closed correto, sem isolamento por tenant. Antes de mais de um tenant ligado, é bloqueante operacional.

**A-6 — FTS escuta em `0.0.0.0:7878`** [conferido: `full-test-server.py:1997`]. Autenticação correta (token obrigatório, fail-closed, `hmac.compare_digest`, `:818-821`), mas `/health` é aberto e a única barreira de rede no dev é uma regra iptables manual (`! -s 172.16.0.0/12 … --dport 7878 -j DROP`), não versionada e que admite todo container do host (inclusive stacks de outros projetos). Firewall/SG de produção não verificado.

### Médias

- **M-1 — `TSK-FULL-TEST` reprovado vira `DONE` no aceite** [conferido]. `routes/projects.ts:847-855` converte `QA_FAIL`/`BLOCKED` em `DONE` ("Cyborg corrigiu e validou"). O texto do PR se protege (AU), mas `project_tasks` mente; viola "nunca DONE sem executar/aprovar".
- **M-2 — Guard pausa o dono (linhagem inteira) por uma única estimativa** [conferido]. `llmGuard.ts:440-445` ocorre **antes** do teto do card (`:449`): uma estimativa absurda de um card bloqueia todos os cards do produto em vez de `CARD_BUDGET_CAP` só nele. Mitigação apenas indireta (teto de contexto).
- **M-3 — Ponto cego entre o gate de árvore do Cyborg e o publicador.** `snapshot_apps_tree` (`cyborg_v3.py:1977-2003`) ignora `CONTEXT_SKIP_DIRS` (`build`, `out`, `target`, `venv`, `__pycache__`, `.pytest_cache`, …), e `pushProjectFiles` (`services/github.ts:495`) só pula `node_modules/.next/dist/.git/coverage/.nyc_output/.venv-genesis`, sem `.gitignore` nem filtro `files_allowed`: artefatos de build e um eventual `.env` escrito pelo Dev vão ao PR. Gate de árvore é fail-open (`cyborg_v3.py:2092-2093`).
- **M-4 — Merge ignora escopo e QA.** Estados de bloqueio de `evolutionMerge.ts:36-46` são só testes, compat e permissão; "escopo FALHOU" no PR é informativo e `confirm:"MERGE"` passa tudo.
- **M-5 — Token de serviço do runner atravessa tenants nas rotas internas do Guard.** `routes/llmGuard.ts:58-78` (`denyForeignTenant`) só amarra `tenant_admin`; `svc` com `projectId` de outro tenant pode chamar `/record` (inflar gasto, pausar o dono de B) e ler `/advisor-gate` de B. Depende de vazamento do token do runner.
- **M-6 — `spec_origin` não chega aos 100 %** (critério 2; escritores listados na tabela §2).
- **M-7 — Sem suíte de regressão do legado nem cenário dourado** (plano 0.5 e critério 1).
- **M-8 — CI nunca rodou no GitHub para este código.** `ci-evolution.yml` existe, mas os 183 commits não foram empurrados (`gh` responde 404 para o workflow no branch padrão; `origin/main` = `origin/dev` = `09653d5`, de 16/10). "Verde em CI" (gate F0') só vale localmente.
- **M-9 — Migration 147 varre `project_dialogue` inteira com regex**; tamanho em produção não medido; acima de 300 s (`statement_timeout`) a API entra em crash-loop no boot.
- **M-10 — Rollback de imagem não testado contra o esquema 162** (A5 do runbook); após cards criados, o código antigo enxerga `card_draft`/`materializing` como projetos comuns.
- **M-11 — Conversão de anexos sem sandbox de FS/rede.** `attachmentConversionRunner.ts:117`: bem limitado (env vazio, `ulimit -v`, RSS, SIGKILL, `spawn` com array, sha conferido), mas mesmo uid da API e o comentário "sem egress" é falso (o container da API tem egress). Risco residual: RCE no parser.
- **M-12 — D-12 corrigido só nas rotas de card.** `middleware/auth.ts:62-73` aceita payload sem `sub`; `evolution-plan`, `budget/resume` e `evolution/merge` gravam `user.id` (500 ou auditoria com autor nulo). Corrigir no middleware.
- **M-13 — Token interno estático comparado com `===` e modo dev aberto sem token** (`routes/internalLlm.ts:27,42-44`); pré-existente, herdado pela rota nova `advisor-gate`.

### Baixas

- **L-1** Migration 162: `CREATE INDEX` sem `CONCURRENTLY` em `llm_call_ledger` (bloqueia INSERTs = todas as chamadas de LLM durante a construção). Precedente bom (135/137/140 em 03/11) e, com este executor, `CONCURRENTLY` seria pior (índice `INVALID` mascarado por `IF NOT EXISTS`); exige medir `pg_relation_size` e janela sem runs.
- **L-2** 141/148: `DROP`+`ADD CONSTRAINT projects_status_check` fora de transação deixa janela sem CHECK se o `ADD` estourar `lock_timeout` (falha segura: a API não sobe).
- **L-3** Advisor em `shadow` resolvido só como visibilidade (`llmGuard.ts:492-549`); sem `advisor_pct` não há teto (`:595-607`).
- **L-4** `resumeBudgetPauseByHuman` concorrente devolve `resumed:true` duas vezes (`llmGuard.ts:898-911`); o runbook promete `resumed:false` na repetição.
- **L-5** Nomes de anexo repetidos no mesmo upload sobrescrevem o arquivo (`cardService.ts:145-150`); arquivos órfãos em ROLLBACK.
- **L-6** Oráculo de existência para token `svc` (403 × 404, `cards.ts:146-155,181-190`).
- **L-7** Merge por `user` dono do projeto (`evolutionPlan.ts:241`): é humano e auditado (confirm gravado antes, `503 AUDIT_UNAVAILABLE`, base forçada a `dev`, head amarrado ao sha empurrado, `evolutionMerge.ts:287-293`), mas a regra de papel deve ser registrada.
- **L-8** CAS no `/evolve` legado cria o filho sem promover o ticket se este sair de `open` durante a operação (`projects.ts:~3885-3888`); só o reconciliador detecta.

### Conferido e aprovado (sem achado)

Autorização por tenant em cards/produto (`cards.ts:141-200` → `lib/projectAccess.ts:28-35`, 404 idêntico para outro tenant); download de anexo; validação de anexos (allowlist + assinatura × extensão, macro/JS em PDF, zip bomb em docx, `ticketAttachments.ts:80-140`; teto multipart `app.ts:86-88`); `cost_policies` (tenant só no próprio tenant e nunca acima da global, `costPolicies.ts:26-34,79-82`); flags de rollout `adminOnly` (`runtimeConfig.ts:62-66`); backfill transacional com rollback em divergência; nenhuma URL com token git no código novo (`githubPush.ts:286-292`, `lib/redactSecrets.ts`, migration 147).

## 5. Migrations, dívida, decisões pendentes e coerência docs × código

**Migrations 141–162.** Executor `db/init.ts:39-82`: sem transação, split por `;` após remover linhas `--`, `lock_timeout` 5 s e `statement_timeout` 300 s por comando (`:29`), registro em `schema_migrations(version)` só no fim (`:75`). 146 e 151–159 nunca existiram (`git log --all`); nenhuma colisão com `main`. Idempotência provada em Postgres real. Ordem api → agents → runner correta e fail-closed do gate do Advisor. Pré-condições em §6.

**Dívida/decisões do Jean ainda abertas** (nenhuma pode ser "assumida" pelo agente):

| Item | Estado no código | Por que importa antes do rollout |
|---|---|---|
| D-E9 serviço-alvo / cruzar serviços | `400 SERVICE_REQUIRED` em produto multi-serviço | Produtos multi-serviço ficam fora de qualquer onda |
| D-E3 ritos por tipo | Implementado "como proposto", sem confirmação | Decisão de produto já materializada em código |
| `executed_*` em `project_tasks` | Não existe; "executada" é derivada (runbook A4) | Somado a M-1, a coluna `status` não é confiável como prova de execução |
| AB-07 `GLOBS_UNVERIFIED` | Bloqueia a promoção até revalidar (`cardJourney.ts:138`) | Sem confirmação humana de globs definida |
| M5/A10 base do orçamento viva × snapshot | Base = `budget_usd` corrente | Teto do card muda retroativamente se o orçamento mudar |
| N-7 política de slot do executor | FULL-TEST impossível no dev com Bedrock por instance role | **Sem esta decisão o gate F4 é inalcançável por desenho** |
| Defaults globais (A-4) | `EVOLUTION_P2P_REQUIRED=1`, `CYBORG_TREE_GATE=on`, `CONTEXT_MAX_*` | Mudam o legado em produção |
| R-1 / `pnpm-lock.yaml` no repo de teste | `dev` do SPEC-02 ainda com o lockfile indevido | Higiene do ambiente de homologação |

**Coerência docs × código** (8 afirmações amostradas dos runbooks; RUNBOOK e ROLLOUT idênticos no repo principal e no worktree):

| # | Afirmação | Resultado |
|---|---|---|
| 1 | `CARD_TRANSITIONS` em `cardState.ts:83-95` | Confere (`:83-94`) |
| 2 | Lease de 600 s em `evolveClaim.ts:48` | Confere |
| 3 | `/evolve` com card ⇒ `409 USE_CARD_PROMOTE` (`projects.ts:3551`) | Confere (`:3550-3556`) |
| 4 | `budget/resume`: svc 403, sem saldo 402, repetir é no-op | Confere (`routes/llmGuard.ts:199-226`), ressalva L-4 |
| 5 | Modo do reconciliador em `featureFlags.ts:158-163`; `on` sem disco ⇒ `shadow` | Conteúdo confere; linhas divergem (`featureFlags.ts:175-182`, `evolveReconciler.ts:469-470`) |
| 6 | `CARDS_BANCADA` `configOnly`; flag off ⇒ 404 `Recurso indisponível` | Confere (`featureFlags.ts:42`, `cards.ts:57`) |
| 7 | Migrations sem transação, split por `;`, timeouts 5 s/300 s | Confere (`db/init.ts:27-35,45-73`) |
| 8 | `confirm` gravado antes do merge; falha ⇒ `503 AUDIT_UNAVAILABLE` | Confere (`evolutionPlan.ts:297-304`) |

Divergências adicionais: (a) ROLLOUT P2 consulta `SELECT name FROM schema_migrations`, mas a coluna é `version` (`init.ts:12`) — o comando falha; (b) RUNBOOK §7 se intitula "141–161" e omite a 162; (c) ROLLOUT C12 e passo 7 aceitam `baseline.status ≠ error`, mas após o N-4 `no_tests` também reprova (deve ser `= ok`); (d) ROLLOUT passo 9/L3 citam `blocked_regressions` e "nada escuta em :7878", hoje `blocked_no_tests`/`blocked_no_evidence` (`evolutionMerge.ts:243-260`); (e) ROLLOUT §7.1 (coluna "Verificado em execução real?"), §7.3, §8 item 1 e §10 ("Pendente: AS") estão desatualizados frente à AS; (f) o cabeçalho do plano ainda diz "nada executado; aguarda o OK do Jean" e o ROLLOUT §1.1 item 1 exige `TSK-FULL-TEST` executado, o que é impossível sem a decisão N-7.

## 6. O que precisa acontecer

### 6.1 Antes de ligar `CARDS_BANCADA` em tenant real

Para a **ZFactory (onda 1, conta e repositório da Zentriz)**, mínimo:

1. Corrigir **A-1** (`_is_qa_pass`) e **A-2** (chaves de dedupe + detector "card `in_factory` com filho morto/parado"), com testes que falhem sem a correção.
2. Decidir **N-7** (como o executor do FULL-TEST obtém credencial sem violar a LEI dos slots) e os **defaults globais** de A-4 (manter, ou mover para flag por tenant).
3. Rebuild/recreate local de `api` → `agents` → `runner` com AT/AU, reiniciar o FTS, conferir digests.
4. **Repetir o gate F4**: 3 execuções reais (Evolução, Correção, Recurso novo) num produto com suíte executável, com **todos** os binários em PASS medidos **pelo sistema** (baseline `ok`, P2P sem regressão, F2P, 0 violações no diff real, FULL-TEST executado e PASS, sem `confirm:"MERGE"` nem intervenção manual, custo ≤ teto). Relatório pré-registrado, sem declarar paridade. Pelo menos uma execução deve exercitar uma rodada de correção do Cyborg (o gate D-1 nunca foi visto).
5. Escrever e rodar os testes de caos do runner **C8, C9, C10, C11, C13** (A-3) e a suíte de regressão do legado com a flag desligada (M-7).
6. FTS: bind restrito (127.0.0.1 ou a bridge do Docker) e regra de firewall versionada e documentada no ROLLOUT P3 (A-6). Com conteúdo só da Zentriz, B-2 pode ser aceito **explicitamente pelo Jean** como risco temporário da onda 1.
7. Corrigir as divergências de documentação de §5 (principalmente a consulta P2, C12 e §7.1/§7.3/§8 do ROLLOUT).

Para **qualquer tenant de cliente (onda 2)**, além do acima:

8. **B-2 resolvido**: `/run-tests` e `/cyborg-build` em container descartável (sem `docker.sock`, sem IMDS, sem rede ou com egress restrito ao registro de pacotes, uid sem privilégio, sem `HOME` do host), ou no Host B (`FTS_UNTRUSTED_ONLY=1`).
9. **A-5**: isolamento do teto horário por tenant (ou teto por tenant abaixo do global) para que um tenant não ligue o kill switch de todos.
10. M-1 (aceite não promove `QA_FAIL`/`BLOCKED` a `DONE`), M-2 (estimativa absurda não pausa a linhagem), M-3 (publicador respeita `.gitignore`/`files_allowed`), M-4 (merge bloqueia escopo FALHOU sem confirmação específica), M-5 (amarrar `svc` ao tenant) e M-12 (recusar JWT sem `sub` no middleware).
11. Decisões D-E9, D-E3, `executed_*`, AB-07, M5/A10 registradas pelo Jean; critérios de saída da onda 1 (ROLLOUT §1.1) cumpridos e aprovados.

### 6.2 Antes de promover o código a produção (mesmo com a flag desligada em todos os tenants)

Pré-condições:

1. **Push** de `dev` e CI `ci-evolution` verde **no GitHub** (M-8); só então "verde em CI" vale.
2. Decisão sobre os comportamentos globais de A-4. Se o código for a produção como está, **antes** do recreate: confirmar que o FTS está ativo e acessível em `3.220.66.113` (`ss -ltn | grep 7878` e `curl $FULL_TEST_SERVER_URL/health` no container do runner) **ou** definir `EVOLUTION_P2P_REQUIRED=0` no runner de produção; conferir o efeito de `CONTEXT_MAX_*` nos maiores projetos de produção.
3. Medições somente leitura em produção: `pg_relation_size('llm_call_ledger')` (L-1) e `pg_total_relation_size('project_dialogue')` (M-9); se `project_dialogue` for grande, aplicar a 147 à parte, em janela, antes do recreate.
4. `NODE_ENV=production` e `GENESIS_API_TOKEN` configurados na API (M-13); chaves `AKIA` removidas do unit do FTS de produção; firewall/SG da 7878 conferidos em produção (A-6).
5. `EVOLUTION_AUTO_MERGE`/`EVOLUTION_AUTO_REDEPLOY` desligados; `EVOLVE_RECONCILER=shadow`; `LLM_ROLES_MODE` igual em api/agents/runner.
6. Teste de rollback: imagem atual de produção contra um banco no esquema 162 (M-10, A5), em ambiente efêmero.
7. OK explícito do Jean para push e deploy.

Ordem: janela quieta (nenhum run nem `materializing`); tag `rollback-<svc>:pre-cards` de cada serviço no host; **api** primeiro (migrations 141–162 no boot; acompanhar o log até "migrations ok" e `/health`) → conferir digest e rotas novas (`GET /api/admin/runtime-config/resolved` com `rolloutFlags`) → **agents** → **runner/orchestrator** → **cyborg** → **genesis-web**; reconciliador `shadow` por ≥ 3 passadas com achados contados; nenhuma flag de card ligada.

Rollback: por serviço, na ordem inversa da dependência (api primeiro, conforme o runbook), com `docker tag rollback-<svc>:pre-cards zentriz-genesis-<svc>:latest` + `up -d --no-build --force-recreate`; **não há migration de volta** (expand); `CARDS_BANCADA=0` por tenant via `PUT` (nunca `DELETE`); se a API não subir por timeout de migration, ver `pg_stat_activity`, remover o bloqueador e repetir, sem editar `schema_migrations` à mão.

## 7. Veredito

**NÃO PRONTO PARA PRODUÇÃO.**

- **Bloqueantes:** B-1 (gate F4 não cumprido; correções AT/AU nunca rodaram em execução real; FULL-TEST e baseline nunca provados) e B-2 (executor de testes do host com RCE no host do control plane para conteúdo de card).
- **Altas:** A-1 (`_is_qa_pass` aprova reprovação por substring), A-2 (dedupe impede `blocked` na segunda ocorrência), A-3 (caos do runner sem teste), A-4 (mudanças globais fora da flag alteram o legado), A-5 (kill switch global disparável por um tenant), A-6 (FTS em `0.0.0.0` com firewall manual).
- **Caminho para "pronto com condições":** cumprir §6.1 itens 1–7 e repetir o gate F4 com todos os binários em PASS medidos pelo sistema; para produção, §6.2 completo. O encanamento já atende ao plano e não precisa ser refeito: o trabalho restante é de qualidade da Fábrica, isolamento do executor e decisões do Jean.
