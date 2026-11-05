> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BI — Execução real 4.5e (Correção ponta a ponta, depois de BG e BH)

Data: 2026-11-05 (02:41–02:58 UTC) · Ambiente: dev do Genesis (API `localhost:3456`), tenant e2e (`a38f6159-…`), alvo `SPEC-02-content-svc` (produto `05cb1b40-…`, repo `genezis-factory/spec-02-content-svc-i6c3`) · LLM: Bedrock `us.anthropic.claude-sonnet-5-5` via slot `byoc_exempt` · GitHub App real · Autorização: gasto restante do orçamento novo.

**Resultado em uma linha.** Pela primeira vez o ciclo fechou: o card **TK-0010** (Correção, `slugify` descartava `ı`, `ð`, `þ`) foi do rascunho ao `delivered` em 16 min e US$ 3,79, com PR #10 mergeado em `dev` (`a7e113a`). As correções BG/BH funcionaram ao vivo (D-12 fallback, D-13 escopo de delta, D-15 Docker bloqueado, rótulo "23 de 23"). O código está correto (medição independente: 0 regressões em 3 execuções, 13 testes novos passam, 11 falham no código da base). **Ressalvas honestas:** (a) a "auditoria do Cyborg" foi o fallback só-auditoria, porque a ponte `/cyborg-engineer` do FTS deu 502 (D-18); (b) o sistema **aceitou** o filho com TSK-FULL-TEST reprovada e baseline não medida (o texto do PR diz isso com clareza e o merge exigiu `confirm:"MERGE"`, que usei somente após a medição independente); (c) o ramo `PRE_EXISTING` do D-13 não foi exercitado (0 BLOCKER).

---

## 1. Pré-condições (verificadas antes de gastar)

| # | Pré-condição | Resultado | Evidência |
|---|---|---|---|
| 1 | API e containers no ar | OK | `GET /health` 200 v1.5.0; `api/agents/runner/cyborg/web` "Up", api healthy |
| 2 | FTS `:7878` com código novo | OK | `GET /health` 200; `fts.log`: `ERESOLVE … fallback` só existe no código BG |
| 3 | Flags do tenant | OK | `GET /products/:id/cards/capabilities` = `cardsBancada:true` |
| 4 | Repo | OK | `origin/dev = 0f69b51` (conferido por `git fetch`) |
| 5 | Linhagem | OK | HEAD v6 `65e77ab2` `accepted`; v7/v8 anteriores `archived`; cards 8 e 9 já rejeitados |
| 6 | Orçamento | OK | ledger do tenant US$ 49,543 (linha de base) |
| 7 | Guard | OK | `kill_switch` off; `spend.lastHourUsd` = 6,97 antes de promover (6,97 + 8 ≤ 20, regra §2.7) |
| 8 | Tokens | OK | `tenant_admin` (`/tmp/ta.tok`) para criar/promover/mergear; token da App GitHub mintado com `sudo python3` + `jwt`, **apagado ao fim** |

## 2. Alvo escolhido

**TK-0010 (Correção, `kind=fix`)** — `slugify` (`src/common/utils/slugify.util.ts`) transliterava ł, ø, ß, æ, œ, đ (RFC-0004) mas não `ı` (i sem ponto), `ð/Ð` (eth) nem `þ/Þ` (thorn): `slugify('Kış ılık')` devolvia `k-s-l-k` (reproduzido com Node antes de abrir o card). Aceite: FAIL_TO_PASS, `compat: patch`, Non-goals explícitos (sem deps, sem package.json/lockfiles/CHANGELOG, sem reduzir testes). Não repete withRetry, CircuitBreaker, /metrics, /live, /time.

## 3. Linha do tempo (UTC)

| Hora | Evento |
|---|---|
| 02:41:41 | Card `5c8434a9` criado (`POST /api/products/:id/cards`), `projectId` = v6 `65e77ab2` |
| 02:42:10 | Planner (rascunho `65edaf15`): RFC-0012, `compat: patch`, 0 perguntas; `spec_write` |
| 02:42:14 | `/ready` ⇒ `gate {rfcs:1, compat:"patch", scope:[slugify.util.ts, slugify.util.spec.ts]}` |
| 02:42:17 | `/promote` ⇒ filho **v7 `097b3d09`**, `evolutionSource: git-clone`, `evolutionSourceError: null`; 02:42:24 `/promote` do projeto + `/run`; card `in_factory` |
| 02:43–02:50 | CTO/Engineer (3 rodadas de proposta técnica), PM (fast-track, 2 tasks), CTO valida backlog |
| 02:50:50 / 02:52:00 | Dev + QA: TSK-EVO-001 e TSK-EVO-002, ambos `QA_PASS` na 1ª tentativa |
| 02:52:02–02:52:53 | **TSK-FULL-TEST** executada pelo FTS (51 s): `FULL_TEST_VERDICT: REJECTED`, `approved=False`; 1 tentativa `docker --version` **bloqueada** |
| 02:53:46 | Cyborg V3 assume; 02:53:57 auditoria prévia 5/5 válidas, escopo DELTA (2 arquivos), 0 BLOCKER |
| 02:53:50–02:53:57 | `/cyborg-build`: ERESOLVE ⇒ fallback `--legacy-peer-deps` rc 0; `build_rc=0`, `tsc_rc=2` |
| 02:54:08 | `/cyborg-engineer` 502 (D-18) ⇒ fallback só-auditoria ⇒ **aceito** (0 BLOCKER, média 8,0, build_rc=0, 5/5) |
| 02:54:26 | Publicação em `evolution/v7` e **PR #10** aberto (`TK-0010 · Evolução v1.3.1`); filho v7 `accepted`, v6 `archived` |
| 02:57:48 | `POST /evolution/merge` sem confirmação ⇒ 400 `CONFIRM_REQUIRED` `blocked_regressions` ("sem resultado final de testes") |
| 02:57:5x | Medição independente já feita (ver §5) ⇒ `POST …/evolution/merge {confirm:"MERGE", reason}` ⇒ `state:"merged"`, `sha a7e113a` em `dev` |
| 02:57:55 | Card `delivered` (`accepted_genesis_merge`), um único evento |

Duração do card: 16 min 14 s; Fábrica (run → aceite): 11 min 44 s.

## 4. Critérios (PASS/FAIL com evidência do sistema)

| # | Critério | Veredito | Evidência |
|---|---|---|---|
| 1 | `/cyborg-build` com `install_fallback` e build OK | **PASS** | `fts.log` 02:53:50 "ERESOLVE no install; fallback --legacy-peer-deps rc=0"; `audit.json.build = {rc:0, output_tail:"[install: npm install --legacy-peer-deps (fallback ERESOLVE)]… nest build", type_check_rc:2}`. Observação: `type_check_rc=2` são 14 erros de `tsc --noEmit` em 4 specs (`activities.service`, `activity-config.validator`, `hours.controller`, `publishing.service`), **idênticos na base** (medição própria, 14 e 14); o gate não os trata como falha (build_rc=0 "ideal") |
| 2 | Auditoria escopada ao delta; ≥ 4/5 válidas; aceito sem BLOCKER no delta | **PASS (parcial no `PRE_EXISTING`)** | `audit.json.scope = {mode:"delta", parent_id:65e77ab2…, delta_files:[slugify.util.ts, slugify.util.spec.ts], files_allowed:[mesmos]}`; `validity = {valid:5,total:5,required:4,sufficient:true}`; diálogo "escopo: DELTA do card (2 arquivo(s))"; "0 BLOCKER residual, média 8.0/10, build OK". `pre_existing: []`: como não houve BLOCKER, o rebaixamento a `PRE_EXISTING` **não foi exercitado ao vivo**. Ressalva: o aceite veio do fallback só-auditoria (D-18), não de uma sessão do engenheiro |
| 3 | QA coerente | **PASS** | 2 chamadas `QA:validate_task`, 0 vazias; ambas `QA_PASS`, coerentes com a medição (13 testes novos passam; F2P real). O QA continua sem executar testes (D-9, não reverificado) |
| 4 | TSK-FULL-TEST executado de verdade, sem Docker | **PASS** | `fts.log` "Concluída: approved=False (FULL_TEST_VERDICT: REJECTED)", 51 s; `[full-test] 1 tentativa(s) de usar Docker BLOQUEADA(s): ['… docker --version']`; `QA_REPORT_TSK-FULL-TEST.md` registra "tentativas de Docker bloqueadas" e "Docker é proibido"; `docker ps -a` sem containers novos. O CLI rodou build (OK), adicionou jest/ts-jest **na cópia** (134 testes passam, 12 falham) e não conseguiu validar o servidor (sem Mongo). Obs.: a lista só aparece no log e no relatório; `projects.extra` não guarda `docker_attempts_blocked` |
| 5 | Baseline (medida / `no_tests` / erro com mensagem) | **PASS (erro explícito; não medida)** | `baseline.status="error"`, `install:"npm install --legacy-peer-deps (fallback ERESOLVE)"`, `workdir:"copy"`, mensagem "**23 de 23** suíte(s) falharam ao carregar/transformar (0 testes executados)… provável falta de configuração de testes". O rótulo "46 de 23" foi corrigido (D-5). A medição P2P continua inexistente (D-11) |
| 6 | PR só no escopo, sem lockfile/artefato | **PASS com ressalva** | PR #10: `slugify.util.ts` (+7/−2), `slugify.util.spec.ts` (+37/−0), `CHANGELOG.md` (+5/−0). Sem lockfile, sem package.json, `diff -rq` base×PR só nesses 3. O CHANGELOG é fechado pelo próprio sistema no aceite ("CHANGELOG fechado como v1.3.1") e contraria o Non-goal do card; entrada genérica "Evolução aceita — SPEC-02-content-svc" |
| 7 | FAIL_TO_PASS e sem regressão (medição independente, 3x) | **PASS** | ts-jest (`diagnostics:false`), base `dev` × PR `evolution/v7`, 3 execuções: base 135/26, 136/25, 136/25 ✓/✗; PR 149/25 nas três; **0 regressões** nas três; 13 testes novos, **13 passam**; o spec novo contra o `slugify` da base: **11 falham**, 27 passam. A 1ª execução da base teve 1 falha a mais (`circuit-breaker`, o intermitente D-10) — falso positivo do lado da base, não do PR. `tsc -p tsconfig.build.json` rc 0 nos dois |
| 8 | Texto do PR com os 5 gates, coerente | **PASS** | Corpo do PR: escopo **passou**, símbolos **passou**, QA **passou**, TSK-FULL-TEST **FALHOU**, baseline **não executado/sem evidência** + aviso "não executado/sem evidência NÃO é aprovação". Bate com `evolution-state.factoryGates` e com a minha medição (a reprovação é de infraestrutura de teste, não do código). Defeito menor em D-20 |
| 9 | `card_id`, `delivered` com único evento, `factoryHealth` | **PASS** | `TSK-EVO-001`, `TSK-EVO-002`, `TSK-FULL-TEST` com `card_id`; 5 `TSK-INH-*` sem. `ticket_card_events`: `draft → refining → ready → promoted → in_factory → delivered`, **1** evento `delivered`. `GET /api/cards/:id`: `state:delivered`, `prUrl …/pull/10`, `factoryHealth:"failed"` (coerente com o gate FULL-TEST) |
| 10 | Custo por papel/fase | **PASS** | §5 |

## 5. Verificação independente e custo

**Medição** (script `/tmp/r45e/indep.sh`, cópias em `/tmp/r45e/{base,pr,f2p}`, resultados em `/tmp/r45e/m-r45e-1/`): `dev` (`0f69b51`) × `evolution/v7` (`033199a`) extraídos com `git archive`, `node_modules` de `/tmp/repo5b`, jest+ts-jest com configuração externa, comparação teste a teste via `--json`. Nada do repositório nem das árvores do Genesis foi alterado.

**Custo** (ledger do tenant US$ 49,543 → **53,334 = US$ 3,791**; 0 chamadas com saída 0; 0 `advisor`; parada em 54,5 não atingida):

| Papel / fase | US$ | Chamadas |
|---|---|---|
| Dev (`implement_task`) | 0,881 | 2 |
| Engineer (`generate_engineering_docs`) | 0,656 | 2 |
| CTO (`validate_engineer_docs` 0,604 + `validate_backlog` 0,278 + `spec_intake` 0,256) | 1,138 | 5 |
| Cyborg (5 análises de auditoria) | 0,548 | 5 |
| PM (`generate_backlog`) | 0,241 | 1 |
| QA (`validate_task`) | 0,212 | 2 |
| Planner (rascunho/Bancada) | 0,078 | 1 |
| Lição (`lesson_extract`) | 0,039 | 1 |
| **Total** | **3,791** | 19 |

Leitura: o Cyborg caiu para 14 % do custo (BF: 26 %) e não houve rodada paga de correção. Pico da hora no Guard: US$ 7,71 (teto 20). Custo por card efetivo: menos da metade do TK-0009 da 4.5d (4,84) e sem retrabalho.

## 6. Intervenções manuais (todas)

1. Criação do card, validação (`/evolution-plan` + `/ready`), `/promote` do card, `/promote` e `/run` do projeto filho: rotas normais, sem `chown`, `stop`, remoção de checkpoint, `PUT /budget` ou `budget/resume`.
2. **`POST /api/projects/097b3d09…/evolution/merge` com `confirm:"MERGE"`** (e `reason`), às 02:57:5x, **depois** de: (a) a primeira tentativa sem confirmação ser corretamente bloqueada; (b) a medição independente (0 regressões, F2P ok, tsc ok). Foi o único ato de risco assumido por mim; está gravado em `evolution_merge_confirmation` e no diálogo do filho. Sem `confirmScope` (escopo passou).
3. Nenhum bypass de Guard, nenhuma edição de código de produto ou do Genesis, merge somente em `dev`. Kill switch não disparou. Token GitHub apagado; temporários em `/tmp/r45e` e `/tmp/r45d`.

## 7. Defeitos novos (sem correção; local provável)

| # | Sev. | Defeito | Evidência | Local provável |
|---|---|---|---|---|
| **D-18** | **Alta (ambiental, mas mascara o Cyborg)** | **A ponte `/cyborg-engineer` do FTS não funciona neste host**: o FTS não tem `GENESIS_API_TOKEN` e não cunha o token de projeto ⇒ 502 ⇒ o Cyborg cai no "fallback só-auditoria" e **aceita só pelas 5 análises**. O diálogo ainda diz "Cyborg V3 trabalhando no produto (pode levar 20-40 min)" antes do 502 e o aceite sai no mesmo segundo. Por isso a auditoria escopada ao delta só foi validada no caminho "0 BLOCKER"; o caminho "BLOCKER no delta ⇒ engenheiro" e `PRE_EXISTING` ficaram sem prova ao vivo | `fts.log` 02:54:08 `ERROR [sandbox] sem GENESIS_API_TOKEN no FTS` + `POST /cyborg-engineer 502`; diálogo 02:54:08 | `scripts/full-test-server.py:222-232` (`_mint_scoped_token`/`_fts_admin_token`); `applications/orchestrator/cyborg_v3.py:2674-2682` (`spawn_engineer` falho ⇒ fallback); configurar o token no serviço do FTS (host), fora do código |
| **D-19** | Média (desenho) | **O aceite do filho não depende do TSK-FULL-TEST nem do `tsc`.** Com `TSK-FULL-TEST = QA_FAIL`, baseline `error` e `type_check_rc=2`, o Cyborg aceitou ("build_rc=0 (ideal)"), publicou o PR e atualizou a linhagem (v6 `archived`, v7 HEAD) antes de qualquer humano. A trava está só no merge (`blocked_regressions` + `confirm:"MERGE"`) e no `factoryHealth: failed`. Se alguém usar o botão de merge com o hábito de confirmar, código quebrado entra em `dev`. Aqui o código estava certo; o filtro humano não é substituível | `audit.json.build.type_check_rc=2`; `factoryGates.fullTest.status="failed"`; `ticket_card_events` | `cyborg_v3.py` `evaluate_audit_acceptance` (incluir `type_check_rc` ≠ 0/-1 e `FULL_TEST` reprovada como não aceitável, ou ao menos rebaixar para `needs_human` quando a baseline falhou por *infra*) |
| D-20 | Baixa | (a) Rótulo da trava: `blocked_regressions` com detalhe "sem resultado final de testes" descreve **ausência de medição**, não regressão (confunde o operador); (b) o gate de escopo diz "diff real (3 arquivo(s)) dentro do `files_allowed`" enquanto `touchedFiles` tem 2 (o CHANGELOG entra na conta sem estar no RFC); (c) o detalhe do gate FULL-TEST é truncado em 200 caracteres no meio da palavra ("…(jest.config/ts-jest). ● T)") | `evolution-state` e corpo do PR | `services/evolutionMerge.ts` (estado/detalhe); `lib/evolutionScope.ts`; montagem do texto dos gates |
| D-11 (persiste) | Média | Baseline nunca medida: o `npx jest` da baseline roda sem config de ts-jest (23 suítes "failed to run"); a FULL-TEST (CLI) descobre o conserto, mas ele fica só na cópia. Sem P2P, todo merge deste produto cai em `confirm:"MERGE"` | `baseline.status=error`; `QA_REPORT_TSK-FULL-TEST.md` ("Adicionei o bloco `jest` com ts-jest") | produto sem `jest.config`/bloco `jest` em `package.json`; ou card de bootstrap; ou config padrão ts-jest na baseline |
| D-10 (persiste) | Baixa | Teste intermitente `circuit-breaker … HALF_OPEN` falhou 1 vez em 3 execuções da base | `m-r45e-1/res-base.json` (26 ✗ contra 25) | `src/common/utils/circuit-breaker.util.spec.ts` |
| D-9 (não reverificado) | Baixa | QA aprova sem rodar testes | — | pipeline Dev/QA |

Sem defeito novo em D-12, D-13, D-14 (não acionado: o build executou), D-15, D-16 (diálogo agora cita o provedor do slot: "5 análises Bedrock") e D-17 (o card nasceu e foi promovido sobre v6; não houve cenário de base vencida, portanto o `CARD_BASE_STALE`/`CARD_PREVIOUS_IN_PROGRESS` do BH **não foi exercitado**).

## 8. O que ficou provado e o que não

| Item | Estado após a 4.5e |
|---|---|
| D-12 (fallback `--legacy-peer-deps`) | **Provado ao vivo** (`install_fallback`, build rc 0) |
| D-13 (auditoria no delta) | **Provado no caminho feliz** (`scope.mode=delta`, 2 arquivos, 5/5 válidas, aceito); `PRE_EXISTING` e "sem escalação de feature" **não exercitados** |
| D-14 (gate de ambiente antes das rodadas) | **Não exercitado** (ambiente OK) |
| D-15 (sem Docker) | **Provado** (1 tentativa bloqueada, nenhum container novo) |
| D-5 (rótulo "46 de 23") | **Provado corrigido** ("23 de 23") |
| D-17/BH (base do card, 409 específico) | **Não exercitado** |
| Entrega ponta a ponta com PR de qualidade (F4) | **Fechado neste caso**: card → PR com 5 gates reais → merge em `dev` → `delivered` com evento único. Ressalvas D-18/D-19/D-11 |
| O sistema não aprova código quebrado | **Parcialmente**: o merge foi barrado até haver confirmação humana, mas o *aceite* do filho não é barrado por FULL-TEST/baseline (D-19). Nesta rodada não havia código quebrado para testar de fato |

## 9. Estado final deixado

- **Card:** TK-0010 `5c8434a9-748d-48e9-a769-dd2111ca6056` **delivered** (PR #10 mergeado), `factoryHealth: failed` (gate FULL-TEST). Cards 8 e 9 seguem rejeitados.
- **Linhagem:** HEAD **v7 `097b3d09-0dc2-4b4e-bb1f-f799cc20b592`** `accepted` (v1.3.1); v6 `65e77ab2` `archived`.
- **Repositório:** `dev = a7e113a` (merge do PR #10); `main = ebc46cb` intacta; branch `evolution/v7` permanece no remoto.
- **Orçamento:** ledger do tenant US$ 53,334 (US$ 3,791 nesta rodada); sem pausa. Guard: `kill_switch` off, última hora US$ 7,71.
- **Flags e FTS `:7878`:** inalterados e no ar (não reiniciei). Sem containers novos.
- **Limpeza:** `/tmp/r45d/gh.tok` apagado; `/tmp/ta.tok` e `/tmp/adm.tok` são do orquestrador. Permanecem em `/tmp/r45e` scripts, cópias, `art/` (audit.json, QA_REPORT) e medições.
