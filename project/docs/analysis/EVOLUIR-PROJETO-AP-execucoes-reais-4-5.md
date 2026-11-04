> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AP — Execuções reais da tarefa 4.5 (cards da Bancada, LLM e GitHub reais)

Data: 2026-11-04 · Ambiente: dev do Genesis (API `localhost:3456`), tenant `e2e` (`a38f6159-…`), alvo `SPEC-02-content-svc` (project_id `8c84633f-…`, produto `05cb1b40-…`, repo `genezis-factory/spec-02-content-svc-i6c3`) · LLM: Bedrock (`us.anthropic.claude-sonnet-5-5`) · GitHub App real, push ligado · Autorização do Jean: até US$ 30 no total.

**Resultado em uma linha.** Os três cards (Evolução TK-0001, Correção TK-0002, Recurso novo TK-0003) percorreram o caminho real até `delivered` com o PR mergeado em `dev`, ao custo total de **US$ 20,46**. O fluxo de estados, rastreabilidade, `executed_*`, `TK-NNNN` e a ausência de duplicação funcionaram. **Mas a qualidade do que a Fábrica entrega não passou:** o QA nunca validou nada (9 de 9 tentativas falharam por "resposta sem JSON"), o `TSK-FULL-TEST` ficou `DONE` sem ser executado, a linha de base de testes não foi medida, e no TK-0001 o Cyborg reescreveu arquivos fora do escopo do RFC e **reduziu especificações de teste existentes**, o que foi mergeado em `dev`. Não declaro paridade (n=3).

---

## 1. Pré-condições (verificadas antes de gastar)

| # | Pré-condição | Resultado | Evidência |
|---|---|---|---|
| 1 | Repo registrado na raiz do produto | OK | `project_github_repos`: `genezis-factory/spec-02-content-svc-i6c3`, `default_branch=main`, `sha_dev=5e58abf`; GitHub App ativa (`tenant_github_installations`, instalação 129756252, org `genezis-factory`, `revoked_at` nulo) |
| 2 | GitHub App com permissão de PR | **Parcial** | Leitura provada (repo, branches, lista de PRs responderam 200). A permissão `pull_requests: write` **não é consultável sem escrever** (a API do Octokit da instalação não expõe as permissões); foi provada na prática quando o PR #1 foi criado |
| 3 | `GENESIS_GITHUB_PUSH=on` | OK | env da API |
| 4 | `EVOLUTION_AUTO_MERGE` / `EVOLUTION_AUTO_REDEPLOY` desligados | OK | não definidos no env da API (padrão off) |
| 5 | Reconciliador em `shadow` sem achados críticos de cards | OK | `EVOLVE_RECONCILER=shadow`; 2 achados abertos, ambos `warning` de `evolution_in_flight_stuck` legados (1.461 h e 1.488 h ociosos; um deles na linhagem de outro serviço do produto). Nenhum crítico. Ao final: os mesmos 2 |
| 6 | Nenhum run em voo | OK | nenhum projeto `running`/`materializing` no tenant |
| 7 | Guard: kill switch off e gasto zerado | OK (com nota) | `kill_switch=off`, tetos US$ 12/h e US$ 30/dia; gasto 24 h = US$ 0,00178 (3 chamadas de verificação do slot, não zero absoluto) |

**Desvios encontrados e corrigidos pela via suportada (todos registrados):**

1. **`CARDS_BANCADA` estava gravada como `"on"`, e a flag era ignorada.** A linha em `genesis_runtime_config` (tenant e2e, "Fase 3 cards (dev, 04/11)") tinha `value='on'`; o resolvedor só aceita inteiro (`services/featureFlags.ts:65-72`, `parseConfigValue`) e descarta com um `console.warn`. Resultado: `GET /api/products/:id/cards/capabilities` devolvia `cardsBancada:false` e as rotas davam 404. Corrigi com `PUT /api/admin/runtime-config/CARDS_BANCADA {value:1, tenantId}`, que roda o backfill transacional (0 cards existentes; `spec_origin` de 18 arquivos). Só então a flag valeu.
2. **`EVOLUTION_PROMOTE_BANCADA` não existia** (nem em env nem em config). Liguei **somente para o tenant e2e** pela mesma rota (`value:1`). Sem ela o filho do card não é promovível à fábrica.
3. **Orçamento e política (D-E10 + 5.1):** `PUT /api/projects/8c84633f…/budget {budgetUsd:30, alertStepPct:20}` (o dono da linhagem é a v1) e `PUT /api/cost-policies` com `card_budget_pct=34` no tenant e2e, `calibrated=false`, gravado pelo `tenant_admin` (teto por card = US$ 10,20). `advisor_pct` **não** foi gravado.
4. **Identidades:** a conta `zentriz_admin` não cria, não promove nem mergeia card (por desenho: `routes/cards.ts:55-105`). Usei o token do `tenant_admin` existente do tenant (`e2e-admin@zentriz.com.br`, id `83d30b20…`) para criar, validar, promover e mergear, e o `zentriz_admin` para flags/Guard. O comando de cunhagem do enunciado usa `id:` mas o `TokenPayload` exige `sub:`; com `id:` o `created_by` do rascunho fica nulo e o `POST /cards` devolve **500** (ver defeito D-12).

## 2. Linha do tempo (UTC)

| Hora | Evento |
|---|---|
| 13:41 | Orçamento US$ 30 e `card_budget_pct=34` gravados; flags corrigidas/ligadas antes disso |
| **TK-0001 — Evolução** (health `startedAt`) | |
| 13:47:55 | Card criado (`draft`); 13:48:24 RFC gerado pelo planner (`refining`); 13:48:39 `ready` (gate sem `compat`); 13:48:42 promovido, filho v2 `d5eb8124` |
| 13:49:02 | `POST /connect-declaration` (exigido: `CONNECT_MISSING`); 13:49:30 promote do filho; **13:49:36 `/run`** (card `in_factory`) |
| 13:57:44 | Backlog aprovado; Dev/QA: 3 reworks de QA, todos `QA_FAIL`; 13:59:40 task forçada a `DONE (não aprovada)` |
| 14:00–14:06 | Cyborg V3: 4 rodadas de correção "autônoma" (2 revertidas); **14:06:10 aceito** (média 8,5/10); 14:06:33 PR #1 publicado (150 arquivos) |
| 14:09:33 | "Mergear agora": 400 `CONFIRM_REQUIRED` (`blocked_compat_implicit`); com `confirm:"MERGE"` → merge, sha `49a0756`; **14:09:37 card `delivered`** |
| **TK-0002 — Correção** (`slugify`) | |
| 14:10:14 | Card criado; 14:10:46 RFC; 14:11:06 `ready` (compat `patch`, FAIL_TO_PASS exigido) |
| 14:11–14:59 | **Espera deliberada de ~48 min**: o teto horário do Guard é US$ 12 e o TK-0001 tinha gastado US$ 8,4 em 17 min; promover antes bloquearia o card por `GLOBAL_HOURLY_CAP` |
| 14:59:13 | Promovido (filho v3 `e31c129b`); 14:59:19 `/run`; 15:13:37 QA 3x `QA_FAIL`; **15:14:58 aceito** (média 8,4); 15:15:18 PR #2 |
| 15:20:08 | Merge: `CONFIRM_REQUIRED` (`blocked_regressions`, "sem resultado final de testes"). Antes de confirmar, rodei a suíte por conta própria (§4.2). 15:21:54 merge, sha `e7c8046`; **15:21:58 `delivered`** |
| **TK-0003 — Recurso novo** (`GET /version`) | |
| 15:22:32 | Card criado; 15:23:06 RFC (com Non-goals); 15:23:24 `ready` (compat `minor`) |
| 15:24–16:00 | Nova espera deliberada (~36 min) pelo mesmo motivo (janela horária) |
| 16:00:24 | Promovido (filho v4 `85428bd3`); 16:00:27 `/run`; 16:13:23 QA 3x `QA_FAIL`; **16:14:35 aceito** (média 9,2); 16:14:58 PR #3 |
| 16:16:47 | Merge com `confirm:"MERGE"` (mesmo motivo), sha `1aa35ce`; **16:16:50 `delivered`** |

Durações (criação do card → `delivered`): TK-0001 **21 min 42 s**; TK-0002 71 min 44 s (**23 min 44 s** sem a espera); TK-0003 54 min 18 s (**~17 min** sem a espera). Tempo de Fábrica (`/run` → PR): 17 min, 16 min e 14,5 min.

## 3. Critérios por card (binários, com evidência)

Legenda: PASS · FAIL · N/A. "Medido por mim" = executei a suíte jest fora do produto (cópia em `/tmp` do container, sem alterar o repositório nem a árvore dos filhos), pois o sistema não mediu.

| Critério | TK-0001 (Evolução) | TK-0002 (Correção) | TK-0003 (Recurso novo) |
|---|---|---|---|
| **P2P sem regressão** | **FAIL.** O sistema não mediu (baseline `/run-tests` com `Connection refused`, "não-regressão desativada nesta run"). O PR #1 **reduz especificações de teste fora do escopo**: `publishing.service.spec.ts` −304/+6, `activities.service.spec.ts` −96/+14, `hours.controller.spec.ts` −85/+33, `activity-config.validator.spec.ts` −26/+18. Regressão de cobertura confirmada pelo diff; regressão de teste a teste não medida | **PASS (medido por mim).** Contra a base (`dev` pós-PR1 + `slugify` original): 88 passam/31 falham; com o fix: 107/12. **0 testes que passavam e passaram a falhar**; as 12 falhas restantes existem na base | **PASS (medido por mim).** Base 107/12; com o PR 117/12; **0 regressões** |
| **FAIL_TO_PASS do card** | **PASS (medido por mim).** Evolução não exige F2P, mas o teste novo do RFC-0003 passa: `health.controller.spec.ts` do `dev` 8/8 | **PASS (medido por mim).** 19 casos novos falham na base e passam com o fix (Łódź→`lodz`, Straße→`strasse`, Smørrebrød→`smorrebrod`, Æble→`aeble`, Đà Nẵng→`da-nang`, e as letras isoladas); os 5 casos de regressão (Olá Mundo etc.) passam nos dois lados | **PASS (medido por mim).** 10 testes novos de `version.controller.spec.ts`, 10/10 |
| **0 violações de escopo** | **FAIL.** `files_allowed` do RFC = `src/health/*.ts`; o PR #1 toca 8 arquivos: além de `health.controller.ts/.spec.ts`, mexeu em `activities/validators/activity-config.validator.ts` (+31) e nos 4 specs acima. `GET evolution-state` mostra `touchedFiles` só dos 2 arquivos do Dev e `violations:{}`: o gate não viu as escritas do Cyborg | **PASS.** PR #2: `slugify.util.ts` (+19), `slugify.util.spec.ts` (+65) e `CHANGELOG.md` (escrito pelo sistema no aceite) | **PASS.** PR #3: `version.controller.ts`, `version.controller.spec.ts`, `health.module.ts` e `CHANGELOG.md` |
| **`TSK-FULL-TEST` PASS** | **FAIL.** Status `DONE`, mas o runner só registrou "Execute manualmente o Claude Code Agent para validação e2e" (`runner.py:5750`); nada foi executado | **FAIL** (idem) | **FAIL** (idem) |
| **Aceite do Cyborg sem intervenção humana** | PASS formal (aceito 14:06:10, 0 BLOCKER, build ok). Ressalva: as 4 rodadas de "correção autônoma" são a causa do desvio de escopo acima | PASS (0 rodadas de correção, 0 BLOCKER) | PASS (idem) |
| **Custo ≤ orçamento do card** (US$ 10,20) | PASS: **US$ 8,37** | PASS: **US$ 7,15** | PASS: **US$ 4,92** |
| **Tasks não herdadas com `card_id`** | PASS 2/2 (`TSK-EVO-001`, `TSK-FULL-TEST`) | PASS 3/3 (`TSK-EVO-001/002`, `TSK-FULL-TEST`) | PASS 2/2 |
| **`executed_*` gravado uma vez** | PASS: 3 linhas (`request.md` do rascunho e do filho, RFC) com o mesmo `executed_at` 14:09:37 | PASS: 3 linhas, `executed_at` 15:21:58 | PASS: 3 linhas, `executed_at` 16:16:50 |
| **`delivered` só com PR mergeado** | PASS: PR #1 `merged` às 14:09:33; evento `accepted_genesis_merge` 14:09:38 | PASS: merge 15:21:54, evento 15:21:59 | PASS: merge 16:16:47, evento 16:16:50 |
| **`TK-NNNN` no PR/commit** | PASS: título `TK-0001 · Evolução v1.1.0…`, corpo `Ticket: TK-0001`, commits `…(TK-0001)` | PASS (`TK-0002`) | PASS (`TK-0003`) |
| **Sem duplicação** (tasks/PR/eventos) | PASS: 1 PR, 6 eventos de card sem repetição de `dedupe_key`, tasks únicas por projeto (`UNIQUE(project_id, task_id)`) | PASS (idem). O backlog **não** replanejou o card anterior (as 2 tasks são só do TK-0002; `TSK-INH-EVO-001` herdada) | PASS (idem) |

Outras métricas pedidas:

- **Tentativas de QA/rework:** 3 por card (limite), **todas `QA_FAIL` com "Resposta sem JSON (ResponseEnvelope)"** — 9/9. A task é então marcada `DONE (não aprovada)` e o pipeline segue ("[ESCALATION] … Revisão humana necessária", ignorado). Ou seja, o QA não revisou nenhuma entrega.
- **Reconciliador (shadow):** nenhum achado novo sobre os cards; os 2 legados continuam.
- **Eventos do Guard:** só `budget_set` e `cost_policy_changed` (os meus). Nenhuma negativa, nenhum `CARD_BUDGET_CAP`, nenhum `GLOBAL_*_CAP`, kill switch sempre off.

## 4. Custo

Total do tenant no ledger: **US$ 20,461** (144 chamadas), de um teto autorizado de US$ 30. Regra de parada: no início do TK-0003 o acumulado era US$ 15,62 (< 24); o máximo observado foi 20,46 (< 28).

### 4.1 Por card (soma do ledger por versão do filho + a parcela do rascunho, ≈ US$ 0,07 por card, 3 chamadas do planner no total US$ 0,213)

| Card | Filho | Orquestrador | Advisor (shadow) | Outros | **Total** | % do teto do card (US$ 10,20) |
|---|---|---|---|---|---|---|
| TK-0001 | v2 | 7,363 (+0,068 Bancada, +0,039 lição) | 0,848 | 0,07 (planner) | **8,37** | 82 % |
| TK-0002 | v3 | 4,966 (+0,041) | 2,076 | 0,07 | **7,15** | 70 % |
| TK-0003 | v4 | 3,897 (+0,036) | 0,912 | 0,07 | **4,92** | 48 % |

### 4.2 Por papel/fase (`purpose` do ledger, em US$)

| Papel | v2 (TK-0001) | v3 (TK-0002) | v4 (TK-0003) |
|---|---|---|---|
| Cyborg (chamadas `direct`: auditoria e correção) | **4,536** (40 chamadas) | 0,569 (5) | 0,527 (5) |
| CTO (spec/validações) | 1,429 | 1,367 | 1,423 |
| Dev | 0,927 | 2,951 | 1,390 |
| QA | 0,582 | 1,313 | 0,641 |
| PM | 0,563 | 0,213 | 0,220 |
| Engineer | 0,243 | 0,630 | 0,609 |
| Advisor (`llm_role=advisor`, incluído nas linhas acima) | 0,848 | 2,076 | 0,912 |

Leituras: (a) **o Cyborg foi 54 % do custo do TK-0001** (as 4 rodadas de correção), e é o mesmo componente que saiu do escopo; nos outros dois cards, sem rodada de correção, custou ~US$ 0,55. (b) **O Advisor custou US$ 3,84 no total (18,8 %)**, embora o enunciado o dê como desligado: a API está com `LLM_ROLES_MODE=on` e o runner com `shadow`; em `shadow` as chamadas acontecem e são cobradas. (c) **Um card gasta US$ 5–8 em ~16 min**; dois cards na mesma hora estouram o teto horário de US$ 12 (risco R-2).

## 5. Defeitos encontrados (sem correção; evidência e local provável)

| # | Sev. | Defeito | Evidência | Local provável |
|---|---|---|---|---|
| D-1 | **Alta** | O Cyborg escreve arquivos do produto **fora do gate de escopo do RFC** e sem preservar testes. No TK-0001: 150 arquivos publicados, 8 diferentes do `dev`, 4 specs reduzidos e 1 arquivo de produção alterado (`activity-config.validator.ts`). O gate de escopo/símbolos só vê as escritas do Dev | diff do PR #1; `evolution-state.touchedFiles` = 2 arquivos, `violations:{}`; diálogo 14:01–14:05 "Cyborg — Dev gravou N arquivo(s)" | `orchestrator/cyborg_v3.py:1379` e `:1686` (rodadas e gravação) versus o gate `orchestrator/runner.py:513-546` (`FORA DO ESCOPO do RFC`, `SÍMBOLOS REMOVIDOS`), que o Cyborg não aplica |
| D-2 | **Alta** | **O QA nunca devolve JSON válido**: 9/9 revisões falharam por "Resposta sem JSON (ResponseEnvelope)"; a task vai a `DONE (não aprovada)` e o pipeline segue até o aceite. O PR descreve "QA rodaram na fábrica" | diálogo dos 3 filhos (QA_FAIL reatempto 1/3..3/3, ~7 s cada); `ESCALATION` ignorado | `orchestrator/envelope.py:80` e `:449`; prompt/saída do papel QA (Sonnet 5.5) no serviço `agents`; decisão de seguir após 3 reworks em `runner.py` (~`:4982`/`:5117`) |
| D-3 | **Alta** | `TSK-FULL-TEST` fica `DONE` sem executar nada ("Execute manualmente…") | diálogo dos 3 filhos; task `DONE` | `orchestrator/runner.py:5750` |
| D-4 | **Alta** | Linha de base de testes **não medida** em todas as execuções: `/run-tests` recusa conexão, "não-regressão desativada nesta run". Sem P2P, o merge cai em `blocked_regressions` ("sem resultado final de testes") e o único caminho é `confirm:"MERGE"`, que eu usei nos 3 PRs com base na minha medição independente | `evolution-state.baseline.status="error"`; mensagem 13:49:36 / 14:59:20 / 16:00:27 | `orchestrator/runner.py:638-660` (`/run-tests` no executor, Lei 8 rota B) e `:6326` |
| D-5 | Média | A suíte do produto base tem **12 testes já falhando** (8 arquivos: courses, hours, outbox, rights-projection, media-assets, content-ingestion, content-tree, counters). O `package.json` do serviço não tem configuração de jest; foi preciso um `jest.config.js` externo para rodar com `ts-jest` | minha execução; `package.json` sem seção `jest` | produto gerado (SPEC-02), não o Genesis |
| D-6 | Média | O planner não grava a compatibilidade em forma que o gate leia, a menos que o pedido a exija: no TK-0001 `/ready` devolveu `gate.compat:null` e o merge pediu confirmação `blocked_compat_implicit`. Nos cards 2 e 3 pedi explicitamente e o gate leu `patch`/`minor` | resposta do `/ready` do TK-0001; `CONFIRM_REQUIRED` | `services/evolutionPlanner.ts` (prompt/RFC) e a leitura de `compat` do gate; `routes/evolutionPlan.ts:~250` |
| D-7 | Média | O filho do TK-0001 exigiu `connect.yaml` (`CONNECT_MISSING`) antes de ir à fábrica, passo que não está no fluxo do card nem no guia; os filhos seguintes herdaram o arquivo | 409 em `POST /projects/:id/promote`; `POST /connect-declaration` (US$ 0,068) | `services/promotability.ts:~345` (`assessEvolutionReadiness`), `routes/pipeline.ts:~224` |
| D-8 | Média | `CARDS_BANCADA='on'` na tabela é ignorada **em silêncio** (só `console.warn`), e a rota `GET /api/admin/runtime-config/resolved` não lista as flags de rollout, então nada na UI/API mostrava que a flag estava morta | `capabilities:false` com a linha presente | `services/featureFlags.ts:65-72`; `routes/runtimeConfig.ts:172` |
| D-9 | Média | O Advisor consome orçamento em `shadow` (US$ 3,84, 18,8 %); com `LLM_ROLES_MODE` diferente entre API (`on`) e runner (`shadow`) a premissa "Advisor desligado" não vale | ledger `llm_role=advisor`: 38 chamadas | config de ambiente; runbook A13 |
| D-10 | Baixa | `TASK_INHERIT_TRANSITIVE` desligada: o filho v3 herdou só 1 task (`TSK-INH-EVO-001`) das 21 do anterior; as `TSK-INH-BE-*` se perdem a cada versão | `project_tasks` do v3: 4 linhas | runner (herança de tasks); flag em `featureFlags.ts:34` |
| D-11 | Baixa | O RFC-0005 assumiu `runtime` como objeto `{name,version}`; o card e a implementação usam `node: process.version`. Com o QA inoperante a divergência RFC×código não é detectada | `docs/rfc/RFC-0005…` × `version.controller.ts` | planner/QA |
| D-12 | Baixa | Token sem `sub` leva a `POST /cards` a **500 INTERNAL** (`created_by` nulo no INSERT do rascunho) em vez de 401/400 | log: `null value in column "created_by" of relation "projects"` | `services/cardService.ts:204`; `middleware/auth.ts` (aceita payload sem `sub`) |
| D-13 | Baixa | O texto do PR afirma "Gate de escopo (RFC files_allowed), símbolos preservados e QA rodaram na fábrica" mesmo quando QA falhou 3x e o escopo foi violado | corpo dos PRs #1–#3 | template do corpo do PR (publicação no aceite, `evolutionAccept.ts`) |

## 6. Riscos

- **R-1 `dev` do repo alvo contaminado.** O PR #1, já mergeado, reduziu 4 specs de teste e alterou `activity-config.validator.ts`. Recomendo revisar/reverter esses 5 arquivos para o estado de `5e58abf` (sem mexer no `health`). Os PRs #2 e #3 estão limpos. Não fiz isso (fora do escopo da tarefa).
- **R-2 Teto horário do Guard.** Um card típico gasta US$ 5–8 em ~16 min contra o teto global de US$ 12/h; dois cards seguidos bloqueiam por `GLOBAL_HOURLY_CAP`. Neste teste a vazão foi controlada por espera manual.
- **R-3 Merge por confirmação.** Sem baseline, o botão "Mergear agora" só funciona com `confirm:"MERGE"`; em produção isso convida a confirmar sem evidência. Aqui a evidência foi minha execução da suíte (TK-0002 e TK-0003); no TK-0001 confirmei sem ter medido a regressão de testes (medi apenas o `health` depois do merge).
- **R-4 Qualidade dependente do Cyborg.** Como QA e `TSK-FULL-TEST` não funcionam (D-2, D-3), o aceite autônomo é a única barreira, e ela é um LLM auditando o próprio código (média 8,4–9,2/10) e sem gate de escopo.
- **R-5 Amostra n=3** em um único serviço NestJS pequeno, com mudanças triviais. Não há base para declarar paridade nem para extrapolar custo de mudanças maiores.

## 7. Estado final deixado no dev

- **Cards (tenant e2e):** TK-0001 `64889bd9-…`, TK-0002 `e647c6b5-…`, TK-0003 `a1cf60bd-…`, todos `delivered`; sem card aberto.
- **PRs (todos mergeados em `dev`, nada em `main`):**
  - #1 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/1 · `evolution/v2`→`dev` · merge `49a07566`
  - #2 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/2 · `evolution/v3`→`dev` · merge `e7c80462`
  - #3 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/3 · `evolution/v4`→`dev` · merge `1aa35ce5`
- **Repositório:** `dev` = `1aa35ce` (v1.2.0); `main` = `ebc46cb` (intacta); branches remanescentes `evolution/v2`, `v3`, `v4` (não removidas) e `staging`.
- **Projetos:** v1 `8c84633f` arquivada (dona do orçamento), v2 e v3 arquivadas (supersedidas), **v4 `85428bd3` `accepted` (versão corrente, v1.2.0)**.
- **Orçamento:** US$ 30 no projeto-dono (`8c84633f`); gasto US$ 20,461, saldo US$ 9,54, sem pausa. `card_budget_pct=34` (tenant e2e, `calibrated=false`). Sem `advisor_pct`. Guard: kill switch off, tetos US$ 12/h e US$ 30/dia inalterados.
- **Flags deixadas:** `CARDS_BANCADA=1` e `EVOLUTION_PROMOTE_BANCADA=1` para o tenant e2e (a primeira regravada de `on` para `1`); `EVOLVE_RECONCILER=shadow`; `EVOLUTION_AUTO_MERGE`/`AUTO_REDEPLOY` não definidos (off); `GENESIS_GITHUB_PUSH=on`.
- **Limpeza:** nenhum código de produto editado; arquivos temporários apenas em `/tmp` (hospedeiro) e removidos do container; tokens em `/tmp/adm.tok` e `/tmp/ta.tok` (4 h, expiram sozinhos).
