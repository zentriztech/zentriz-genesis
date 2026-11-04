> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BA — Execuções reais 4.5c (três cards, um por tipo, depois de todas as correções)

Data: 2026-11-04 (22:06–23:35 UTC) · Ambiente: dev do Genesis (API `localhost:3456`), tenant e2e (`a38f6159-…`), alvo `SPEC-02-content-svc` (produto `05cb1b40-…`, repo `genezis-factory/spec-02-content-svc-i6c3`) · LLM: Bedrock (`us.anthropic.claude-sonnet-5-5`) via slot do tenant `byoc_exempt` · GitHub App real · Autorização: US$ 20–25.

**Resultado em uma linha.** Das três execuções, **só o card de Evolução (TK-0005) chegou a `delivered`** (PR #7 mergeado em `dev`, com `confirm:"MERGE"` depois da minha medição independente). A Correção (TK-0006, PR #8) e o Recurso novo (TK-0007, PR #9) foram **aceitos pela Fábrica e publicados, mas NÃO mergeados**: a medição independente provou que o PR #8 **quebra o build do produto** (`outbox-worker.service.ts:26`, TS2554) e falha nos próprios testes, e o PR #9 carrega essa mesma alteração fora do escopo. O gate F4 **não fecha**. Custo da rodada: **US$ 17,17** (ledger 24,08 → 41,25; teto de parada 46 não atingido). Não declaro paridade (n=3).

A causa dominante não está nos papéis de Dev/QA, e sim em **dois defeitos do Cyborg V3 que tornam o aceite vazio** (D-1 e D-2 abaixo), mais o `approved=True` indevido do executor (D-3).

---

## 1. Pré-condições (verificadas antes de gastar)

| # | Pré-condição | Resultado | Evidência |
|---|---|---|---|
| 1 | API no ar, containers recriados com o código corrigido | OK | `GET /health` 200 (v1.5.0); containers com 2 min de uptime no início |
| 2 | Servidor de testes do host `:7878` | OK | `ss`: escuta em 127.0.0.1 e 172.17.0.1; `GET /health` do FTS 200; firewall `ausente` (aviso do `start-fts.sh`, esperado no dev) |
| 3 | Flags do tenant | OK | `genesis_runtime_config`: `CARDS_BANCADA=1`, `EVOLUTION_PROMOTE_BANCADA=1`, `TASK_INHERIT_TRANSITIVE=1`; `GET /cards/capabilities` = `cardsBancada:true` |
| 4 | Repo | OK | `dev` e `main` conferidos; `main = ebc46cb` do início ao fim |
| 5 | Orçamento | OK | dono `8c84633f` US$ 50, gasto 24,0778, saldo 25,92, sem pausa; ledger do tenant US$ 24,08 (linha de base) |
| 6 | Guard | OK | `kill_switch=off`, global US$ 12/h e 55/dia, tenant US$ 12/h |
| 7 | Token | OK | cunhado no container `api` com `sub` do `tenant_admin` `e2e-admin` (4 h); `zentriz_admin` só para consulta/Guard |
| 8 | Token GitHub (somente leitura) | OK | App `genezis-factory` (3609618, instalação 129756252) mintado com `sudo python3` + `jwt`; nunca impresso; **apagado ao fim** (`gh.tok`, `ta.tok`) |

## 2. Linha do tempo (UTC)

| Hora | Evento |
|---|---|
| **TK-0005 — Evolução** (`/metrics` ganha `content_svc_start_time_seconds`) | |
| 22:06:59 | Card criado (rascunho `0836a6d3`), projectId = v5 `9e623776` (sem ele: `SERVICE_REQUIRED`, esperado) |
| 22:07:03–22:07:25 | Planner: job `done` em 22 s, RFC-0007, `compat: minor` declarado sem pedir; 2 perguntas/assunções |
| 22:07:30 | `/ready` ⇒ `gate {rfcs:1, compat:"minor", scope:[health.controller.ts, .spec.ts]}`. **Sem `GLOBS_UNVERIFIED`; nenhum bypass** |
| 22:07:35 | `/promote` ⇒ filho **v6 `65e77ab2`** (`git-clone`, 11 arquivos); `POST /projects/:id/promote` 200 (sem `CONNECT_MISSING`); 22:07:42 `/run` ⇒ `in_factory` |
| 22:07:48 | Baseline: `status=error` ("46 de 23 suítes falharam…", produto sem jest.config) |
| 22:08–22:17 | CTO/Engineer (3 rodadas de perguntas), PM; Dev 22:17:58 |
| 22:18:23 | **QA_PASS** (1 chamada) |
| 22:18:25–22:26:46 | **TSK-FULL-TEST executado pelo FTS do host** (8 min 21 s; slot `byoc_exempt`, conta da Zentriz) |
| 22:26:52 | `QA_FAIL` da TSK-FULL-TEST pelo gate P2P ("baseline NÃO medida"); 22:26:52 Cyborg assume |
| 22:27:20–22:29:05 | Cyborg: `/cyborg-engineer` ⇒ **502** ("sem GENESIS_API_TOKEN no FTS"), 3 rodadas de "correção autônoma", rodada 3 revertida, **aceite às 22:29:05** |
| 22:29:25 | **PR #7** publicado (3 arquivos no diff) |
| 22:32:24 | Merge sem `confirm` ⇒ 400 `CONFIRM_REQUIRED` (`blocked_regressions`, "sem resultado final de testes"); depois da medição independente, `confirm:"MERGE"` ⇒ squash `0f69b51`; **22:32:25 `delivered`** |
| **TK-0006 — Correção** (CircuitBreaker, HALF_OPEN de sonda única) | |
| 22:32:45 | Card criado (v6 `65e77ab2`); RFC-0008 22:33:25 (`compat: patch`, sem pedir); `/ready` 22:33:26; promovido 22:33:29 ⇒ **v7 `3df5d962`**; `/run` 22:33:30 |
| 22:40:57 / 22:41:49 | QA_PASS TSK-EVO-001 e TSK-EVO-002 (1ª e 2ª chamadas de QA) |
| 22:41:51–22:42:46 | TSK-FULL-TEST executada (55 s) ⇒ `QA_FAIL` pelo gate P2P (22:42:51) |
| 22:43:07–22:46:51 | Cyborg: 4 BLOCKERs na auditoria inicial, 3 rodadas de correção, rodada 3 revertida, **aceite 22:46:51** com auditoria final 402 `REPEAT_PAYLOAD` |
| 22:47:12 | **PR #8** publicado (3 arquivos: CHANGELOG, spec +123, `circuit-breaker.util.ts` +100/−28) |
| 22:47–23:35 | Medição independente: **build quebrado e testes do PR falhando** ⇒ **não mergeado** (§3.5) |
| **TK-0007 — Recurso novo** (`GET /time`) | |
| 22:50:13 | Card criado sobre v7; RFC-0009 (`compat: minor`, escopo: `time.controller.ts`, `.spec.ts`, `health.module.ts`); promovido 22:50:54 ⇒ **v8 `1d74b7dd`**, **`evolutionSource: disk-copy`** (o fetch do git falhou: ref `evolution/v7` 404 e `fetch origin dev` 404), ou seja, v8 partiu do disco de v7, que tem a alteração quebrada de v7 não mergeada; `/run` 22:51:04 |
| **22:54:48** | **`KILL_SWITCH` ligado pelo Guard** (`GLOBAL_HOURLY_CAP`: US$ 12,06 na última hora contra teto 12). Run de v8 `stopped` ("pausado de forma retomável", tarefas devolvidas sem contar tentativa) |
| 22:54–23:25 | Espera (o gasto da hora decaiu de 12,06 para 9,10). O orquestrador liberou o kill switch e subiu os tetos horários global e do tenant para US$ 20/h |
| 23:25:50 | `POST /projects/v8/run` (retomada) |
| 23:34:34 | Cyborg aceita (mesma auditoria vazia); **23:34:55 PR #9** publicado (6 arquivos; 3 deles de v7, fora do escopo) |
| 23:35 | `POST /evolution/merge` sem confirm ⇒ 400 `CONFIRM_REQUIRED`, **`blocked_scope`**. **Não confirmei** (§3.5) |

Duração criação→`delivered`: TK-0005 **25 min 26 s**. TK-0006: 14 min 27 s até o PR (não entregue). TK-0007: 44 min até o PR (~13 min de trabalho + 31 min de kill switch).

## 3. Critérios (PASS/FAIL com evidência do sistema)

| # | Critério | TK-0005 (Evolução) | TK-0006 (Correção) | TK-0007 (Recurso novo) |
|---|---|---|---|---|
| 1 | QA devolve envelope válido, aprova/reprova de forma coerente; output_tokens>0; rodada de correção após QA_FAIL | **PASS** envelope (1 chamada `QA:validate_task`, 3.293 tok de saída; 0 "sem JSON"; 0 chamadas com saída 0 em 35). **Sem rodada Dev/Cyborg após QA_FAIL de tarefa** (QA nunca reprovou). Coerência: não exercitada | **FAIL na coerência.** Envelope válido (2 chamadas, 7.511 tok; 0 "sem JSON"), mas o QA aprovou a TSK-EVO-001/002 com a premissa "preserva os testes originais" e declarou "Jest fora do task_files" (**QA nunca roda testes**); o código final do PR #8 falha nos próprios testes | **PASS** envelope (1 chamada, 3.420 tok; 0 "sem JSON"); o teste que o Dev escreveu para "única leitura do relógio" **falha contra o código do próprio Dev** (`time.controller.spec.ts:60`) e o QA aprovou |
| 2 | TSK-FULL-TEST executado de verdade pelo FTS (DONE com saída real) ou NOT_RUN com motivo | **PARCIAL.** Executado pelo FTS (log `Concluída: rc=0 len=2315`, 8 min 21 s, slot `byoc_exempt`), saída real em `docs/qa/QA_REPORT_TSK-FULL-TEST.md`. Mas o CLI reportou **BLOQUEADO** (diretório do projeto é de root; `npm install` EACCES; backend NestJS recebeu prompt de frontend). Status final `QA_FAIL` (nunca `DONE`) | **PARCIAL** (idem; 55 s, `len=2172`; build passou numa cópia, testes não rodados) | **PARCIAL** (idem; `len=1549`; "não consegui executar a task", parou na Fase 1) |
| 3 | Baseline medida (`baseline.status`) e P2P | **FAIL.** `status=error`: "46 de 23 suítes falharam ao carregar/transformar… provável falta de configuração de testes". Mensagem acionável (melhoria sobre `no_tests` silencioso da 4.5b) mas baseline **não medida**; P2P vazio | **FAIL** (idem) | **FAIL** (idem) |
| 4 | Cyborg/PR no escopo; nenhum spec encolhido; lockfile/artefatos ausentes; `violations` coerentes | **PASS.** PR #7: `CHANGELOG.md` (+5), `health.controller.spec.ts` (+88/−0), `health.controller.ts` (+5); sem lockfile; `violations:{}`; gate de escopo "passou — diff real (3)" | **PARCIAL.** Escopo formal passou (3 arquivos, dois permitidos). Mas o Cyborg **reescreveu `circuit-breaker.util.ts` mudando a API pública** (construtor `(name, options)` → `(options)`; novo `now`; `trip`), contra a nota do Dev ("patch mínimo, API pública inalterada"). Nenhum gate vê mudança de API dentro de arquivo permitido. Spec não encolheu (+123/−0) | **FAIL.** Gate de escopo **FALHOU** (corretamente): PR #9 traz `circuit-breaker.util.ts` (+100/−28), seu spec (+123) e `CHANGELOG` (+10), herdados do v7 não mergeado. `merge` ⇒ `blocked_scope`. O gate funcionou; a causa é D-4 (`disk-copy`) |
| 5 | FAIL_TO_PASS PASS e sem regressão (medição independente) | **PASS.** ts-jest, base `dev` × `evolution/v6`: 130 ✓/25 ✗ → 135 ✓/26 ✗; 6 testes novos, **6 ✓**; 1 "regressão" aparente (`circuit-breaker … HALF_OPEN após o cooldown`) é **teste intermitente** pré-existente (cooldown 1 ms; reproduzido também na base: 2 de 6 execuções) | **FAIL.** Base 135 ✓ → PR 134 ✓/32 ✗: **regressão real** `abre o circuito após atingir o threshold…`; dos 5 testes F2P do PR, **0 passam** no código do PR (usam `new CircuitBreaker('x', {…})`, que o código novo não aceita). Contra a base, o spec do PR dá 4 ✗/4 ✓ (3 F2P falham como esperado, 1 passa). **`tsc -p tsconfig.build.json` do PR: `outbox-worker.service.ts(26,66): TS2554`** (base: limpo) | **FAIL.** PR #9 sobre `dev`: 136 ✓ → 145 ✓/33 ✗; 2 regressões (as do circuit-breaker); `time.controller.spec`: 11 ✓/**1 ✗** (teste do Dev errado); build do PR quebrado pelo mesmo `TS2554` |
| 6 | Texto do PR com os 5 gates reais | **PASS.** Escopo passou (diff real 3), Símbolos passou, QA passou, **TSK-FULL-TEST FALHOU**, **Baseline não executado/sem evidência**, mais o aviso "não executado NÃO é aprovação". Veracidade: o "QA passou" é só "sem reprovação registrada" | **PASS formal** (mesmos 5 gates, todos fiéis aos dados). Limite: "símbolos passou" e "escopo passou" não pegam a quebra de API | **PASS.** Escopo **FALHOU** declarado com o arquivo; demais fiéis |
| 7 | `card_id` nas tasks não herdadas; herança transitiva | **PASS.** `TSK-EVO-001` e `TSK-FULL-TEST` com `card_id`; 4 herdadas sem (`INH-EVO-001/002`, `INH-V4-EVO-001`, `INH-V5-EVO-001`) | **PASS.** EVO-001/002 e FULL-TEST com `card_id`; 5 herdadas (inclui `INH-V6-EVO-001`) | **PASS.** EVO-001 e FULL-TEST com `card_id`; **7 herdadas** (cadeia completa até `INH-V7-EVO-001/002`). 0 tasks não herdadas sem `card_id` nos 3 filhos |
| 8 | `delivered` só com PR mergeado, um único evento | **PASS.** PR #7 `merged_at 22:32:24Z`, sha `0f69b51`; 1 evento `delivered` (`accepted_genesis_merge`, 22:32:25), 6 eventos, `dedupe_key` sem repetição. **Registro:** exigiu `confirm:"MERGE"` | **N/A (corretamente não entregue).** PR #8 aberto, card `in_factory`, 0 eventos `delivered` | **N/A (corretamente não entregue).** PR #9 aberto, `blocked_scope`, 0 eventos `delivered` |
| 9 | Custo por papel/fase; Advisor | **US$ 5,498** (§4); Advisor **0** (`llm_role` = `orchestrator` em 109 de 112 chamadas, 3 sem papel; nenhuma `advisor`) | **US$ 5,620**; Advisor 0 | **US$ 6,057**; Advisor 0 |
| 10 | Compat declarada pelo planner sem pedir; `connect.yaml` sem 409 | **PASS.** `minor`, `compatExplicit:true`; promote do filho 200 | **PASS.** `patch` | **PASS.** `minor` |
| 11 | Cancelamentos/pausas do Guard e retomadas | Nenhum. 15 `repeat_payload_denied` ao todo (D-1) | Nenhum | **`KILL_SWITCH` 22:54:48** (hora a US$ 12,06/12); run `stopped`; liberado pelo orquestrador às ~23:25 com tetos 20/h; retomada por `POST /run`. Card ficou `in_factory` com filho `stopped` durante 31 min (sem sinalização de bloqueio) |
| 12 | Tempo total | 25 min 26 s até `delivered` (Fábrica 21 min 43 s) | 14 min 27 s até o PR (Fábrica 13 min 42 s); não entregue | 44 min até o PR (efetivo ~13 min) |

### 3.5 Verificação independente (como no AP/AS)

Clones limpos de `dev` e das branches `evolution/v6|v7|v8` em `/tmp/r45c/{base,pr}-c{1,2,3}`, `node_modules` do `/tmp/repo5b`, `jest` com `ts-jest` (`diagnostics:false`, config externa), `--json` comparado teste a teste (passava na base ∧ não passa no PR), mais `tsc --noEmit -p tsconfig.build.json` em base e PR. Script: `/tmp/r45c/indep.sh`. Nada do repositório ou das árvores do Genesis foi alterado.

Decisões de merge (documentadas):
- **PR #7 (TK-0005): `confirm:"MERGE"` usado**, com `reason` registrado: baseline não medida (produto sem jest.config, D-5), 0 regressões reais, 6 testes novos passam, diff de 3 arquivos no escopo.
- **PR #8 (TK-0006): NÃO confirmado.** Regressão real + F2P 0/5 + build quebrado. Confirmar seria mergear defeito provado em `dev`.
- **PR #9 (TK-0007): NÃO confirmado** (`blocked_scope` exigiria `confirmScope:"OUT_OF_SCOPE"`; o diff fora do escopo é justamente o código quebrado).

## 4. Custo

Ledger do tenant: **24,077 → 41,252 = US$ 17,174** (112 chamadas, todas `orchestrator`/sem papel; o Advisor não rodou). Parada em 46 não atingida. Teto horário: a hora chegou a US$ 12,06 e **ligou o kill switch** (§5, D-6). Saldo do projeto-dono: US$ 8,75 de 50 (gasto 41,25).

| Papel / fase | TK-0005 (US$) | TK-0006 (US$) | TK-0007 (US$) |
|---|---|---|---|
| Cyborg (`purpose=direct`: auditorias + rodadas) | 2,524 (23 ch.) | 2,725 (23 ch.) | 3,153 (29 ch.) |
| CTO | 1,399 (6) | 1,061 (4) | 1,326 (5) |
| Engineer | 0,679 (2) | 0,321 (1) | 0,647 (2) |
| Dev | 0,469 (1) | 0,916 (2) | 0,466 (1) |
| PM | 0,232 (1) | 0,255 (1) | 0,253 (1) |
| QA | 0,110 (1) | 0,224 (2) | 0,110 (1) |
| Planner (rascunho/Bancada) | 0,071 | 0,082 | 0,086 |
| Lição (`lesson_extract`) | 0,015 | 0,036 | 0,016 |
| Advisor | 0 | 0 | 0 |
| **Total** | **5,498** | **5,620** | **6,057** |

Leitura: o Cyborg consome **~46–52 %** do custo de cada card e é justamente o que produz o aceite vazio (D-1) e a reescrita que quebrou o build (D-2). Dev e QA custam 0,6–1,1.

## 5. Defeitos novos (sem correção; local provável)

| # | Sev. | Defeito | Evidência | Local provável |
|---|---|---|---|---|
| **D-1** | **Alta** | **Aceite do Cyborg é "fail-open": análises que falham (402 `REPEAT_PAYLOAD`) contam como "0 BLOCKER".** Depois de uma rodada revertida, a re-auditoria repete o mesmo payload; o Guard nega (`repeat_max_per_6h=4`) 4 das 5 análises; o código exclui da média as que falharam e conta só findings existentes ⇒ "0 BLOCKER, média 8,0 (só a4), build OK" ⇒ aceite. Ocorreu nos **3 cards**: `docs/cyborg/audit.json` com `a1,a2,a3,a5` = `score 0, ok false, error 402 REPEAT_PAYLOAD`. Em TK-0006 a melhor auditoria real tinha **4 BLOCKERs** | `docs/cyborg/audit.json` dos filhos; `llm_guard_events`: 15 `repeat_payload_denied`; diálogo "rodada 3 regrediu (blk 4→5)… Mantido o melhor estado (4 BLOCKER)" seguido de "0 BLOCKER residual" | `orchestrator/cyborg_v3.py:2172-2173` (`_scores = [... if ar.ok or ar.score > 0]`; análise com `error` não pode contar como aprovada nem ser excluída); reaudit idêntico após `revert` (mesmo hash) |
| **D-2** | **Alta** | **Gate de build do Cyborg é vazio e a reescrita do Cyborg não é re-testada nem re-QA'd.** `/cyborg-build` roda `nest build` num diretório sem `node_modules`: `sh: nest: not found` e `build_rc=0` ("build OK"). As rodadas de correção reescreveram `circuit-breaker.util.ts` mudando o construtor e quebrando `outbox-worker.service.ts` (consumidor), sem nenhum gate: escopo olha só nomes de arquivo, símbolos olha só remoções | `audit.json.build = {rc:0, output_tail:"…nest: not found"}`; PR #8 `tsc -p tsconfig.build.json` ⇒ `TS2554`; nota do Dev (`docs/dev/dev_implementation_TSK-EVO-002.md`) diz "API pública inalterada" e a FULL-TEST do v7 (pré-Cyborg) buildou na cópia | `scripts/full-test-server.py` (`_handle_cyborg_build`: instalar dependências antes do build e propagar rc≠0 quando o binário não existe); `cyborg_v3.py` (`_cur_build_rc`, rc de build vazio aceito); sem `tsc --noEmit` do projeto e sem rodar a suíte após rodada |
| **D-3** | Alta | **`approved=True` do executor por substring** mesmo com relatório "BLOQUEADO / não vou declarar APROVADO". O runner só não aprovou porque o gate P2P sobrepôs | `fts.log`: `Concluída: approved=True` nas 3 FULL-TEST; relatório do card 1: "Parei aqui… não vou declarar APROVADO" | `scripts/full-test-server.py:1862-1864` (`any(w in output.upper() for w in ["APROVADO", "PASSED", "ALL PASS"…])`) |
| **D-4** | Alta | **Filho promovido com `disk-copy` quando o git falha, sem alarme**, partindo do disco de uma versão **aceita mas não mergeada**; o PR seguinte carrega a alteração anterior (aqui: o código quebrado do PR #8) e o card inteiro só falha no gate de escopo no fim. `evolutionSourceError` fica só no retorno do `/promote` (`GET …/git/ref/heads%2Fevolution%2Fv7 - 404` e `git fetch origin dev` ⇒ 404; no mesmo ambiente os clones da 1ª e 2ª promoção funcionaram) | `promote3.out`: `evolutionSource:"disk-copy"`; log da API; `extra.evolution_source_error` | `services/cardPromote.ts` / clone da linhagem (sem retry nem bloqueio quando o pai tem PR aberto); investigar a causa do 404 (token de instalação ou ref com `%2F`) |
| **D-5** | Média | **Rótulo "46 de 23 suítes"**: soma `numFailedTestSuites` + `numRuntimeErrorTestSuites`, que se sobrepõem | mensagem em evolution-state, PR e diálogo (3 cards) | `scripts/full-test-server.py:789-790` |
| **D-6** | Média | **Kill switch global por estouro horário de um único tenant.** O tenant tinha teto US$ 12/h igual ao global (config da rodada), então o teto do tenant não negou antes; a Fábrica gastou US$ 12,06 em 60 min (cada card ~US$ 5,5–6 em ~15 min) e o Guard desligou o LLM de todo o Genesis. O card TK-0007 ficou `in_factory` com filho `stopped` sem estado `blocked` (31 min). Não fiz o escalonamento do runbook A14 (conferir `spend.lastHourUsd` antes de promover), erro meu de condução | `llm_guard_events` 22:54:48 `kill_switch_tripped {GLOBAL_HOURLY_CAP, 12.06}`; ticket 7 `card_state=in_factory`, projeto `stopped` | `services/llmGuard.ts` (preflight do teto do tenant não menor que o global); `cardPromote.ts` `syncCardWithChild` não trata `stopped` por KILL_SWITCH como `blocked` |
| **D-7** | Média | **FULL-TEST roda como `ubuntu` em diretório de root e prompt de frontend no backend**: `npm install` EACCES; prompt cita Next.js/`AppShell`/`NAV_ITEMS`, que não existem no NestJS. Resultado: a execução "de verdade" valida pouco (só build numa cópia) | `docs/qa/QA_REPORT_TSK-FULL-TEST.md` dos 3 filhos | resíduo do N-2: `/run-full-test` não usa a cópia gravável que `/run-tests` usa; `project/full-test-prompt.md` genérico |
| **D-8** | Média | **`/cyborg-engineer` 502** ("sem GENESIS_API_TOKEN no FTS") nos 3 cards ⇒ o "engenheiro sênior" nunca roda; o Cyborg cai no fallback de auditoria (que, por D-1, é vazio). Ambiente já conhecido (AT) | `fts.log` 22:27:20, 22:43:48, 23:32:33 | env do FTS (`start-fts.sh` não passa `GENESIS_API_TOKEN`) |
| D-9 | Baixa | **Dev e QA nunca executam testes** (nota do Dev: "O Jest não foi executado"; do QA: "execução do Jest fora do task_files"). Nenhum teste escrito pelo Dev é rodado pelo sistema antes do aceite; teste errado do TK-0007 passou | `dev_implementation_TSK-EVO-002.md`; `qa_report-TSK-EVO-002.md` | pipeline de Dev/QA (sem ferramenta de execução) |
| D-10 | Baixa | **Teste intermitente do produto** `circuit-breaker … HALF_OPEN após o cooldown` (`cooldownMs:1` e `expect(OPEN)` imediato): falha por tempo na base e no PR. Não é do Genesis, mas gera falsa regressão em medição por teste | 2 de 6 execuções na base/PR | produto (SPEC-02): `circuit-breaker.util.spec.ts:23-33` |
| D-11 | Baixa | **Baseline `error` é consequência de o produto não ter configuração de jest (D-5 da 4.5)**: o sistema agora diz isso com clareza e reprova a FULL-TEST, mas sem baseline nenhum card pode fechar P2P; o merge sempre cai em `confirm` | evolution-state dos 3 filhos | produto; ou criar a config no card de bootstrap |

## 6. Intervenções manuais (todas)

1. `POST /api/projects/<v6|v7|v8>/promote` e `/run` pelas rotas normais (sem `chown`, sem `stop`, sem remoção de checkpoint, sem `PUT /budget`, sem `budget/resume`).
2. **`confirm:"MERGE"` no PR #7**, depois da medição independente (§3.5), com `reason` gravado. Nenhum `confirmScope`.
3. **Kill switch:** disparado pelo Guard às 22:54:48 e **liberado pelo orquestrador** (não por mim), que também subiu os tetos horários global e do tenant para US$ 20/h; retomei o v8 com `POST /projects/v8/run` às ~23:25:50.
4. Nenhuma edição de código de produto ou do Genesis. Temporários em `/tmp/r45c` (clones, configs de jest, saídas); tokens GitHub e do `tenant_admin` apagados.

## 7. O que ficou provado e o que não (gate F4)

| Item | Estado após a 4.5c |
|---|---|
| QA devolve envelope válido (A-1/AQ-D-2) | **Provado** (4 chamadas, 0 vazias). **Coerência do veredito: não provada** (QA aprova sem executar testes) |
| Executor com slot `byoc_exempt` (AZ) | **Provado**: o FTS executou 3 FULL-TEST ao vivo na conta da Zentriz. A **validação** feita por ele é fraca (D-3, D-7) |
| TSK-FULL-TEST nunca `DONE` sem execução | **Provado** (`QA_FAIL` pelo gate P2P nos 3) |
| Baseline medida / P2P | **Não provado**: `error` explícito (produto sem jest.config) |
| Cyborg no escopo (AQ-D-1/N-3) | **Parcial**: lockfile/arquivos avulsos ausentes nos 3 PRs e o gate de escopo por diff real **funcionou** (`blocked_scope` no #9); mas o Cyborg altera API dentro de arquivo permitido (D-2) e o aceite é vazio (D-1) |
| Texto do PR com gates reais (N-6) | **Provado** (5 gates fiéis nos 3 PRs) |
| Compat sem pedir / connect / herança transitiva | **Provados** (3 de 3; cadeia de 7 herdadas no v8) |
| `delivered` só com PR mergeado, evento único | **Provado** (TK-0005; TK-0006/0007 corretamente não entregues) |
| Entrega ponta a ponta com qualidade (F4) | **Não fechado**: 1 de 3 entregue e só com `confirm`; a Correção entregaria código que quebra o build do produto |

Recomendação mínima antes de nova rodada: corrigir D-1 (análise com erro nunca aprova e nunca é excluída), D-2 (instalar dependências e rodar `tsc --noEmit` + a suíte do projeto depois de cada rodada do Cyborg, rc≠0 reprova), D-3 e D-4; subir `GENESIS_API_TOKEN` do FTS (D-8); escalonar a promoção por `spend.lastHourUsd` (D-6).

## 8. Estado final deixado

- **Cards (tenant e2e):** TK-0005 `815a5b60-1dbf-4ee0-9cf2-152d78432c1c` **delivered**. TK-0006 `03793881-5d6e-40c4-bca3-923729feb09e` **in_factory** (filho v7 `3df5d962` arquivado/superseded, PR aberto). TK-0007 `acf41ab9-74eb-4ce3-bb1c-7b2423049158` **in_factory** (filho v8 `1d74b7dd` **accepted**, versão corrente, PR aberto).
- **PRs (repo `genezis-factory/spec-02-content-svc-i6c3`):**
  - #7 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/7 · `evolution/v6`→`dev` · **mergeado** (squash `0f69b51`).
  - #8 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/8 · `evolution/v7`→`dev` · **aberto, não mergear** (quebra o build; `TS2554` em `outbox-worker.service.ts:26`).
  - #9 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/9 · `evolution/v8`→`dev` · **aberto, `blocked_scope`**; contém o código do #8. Se for aproveitar `GET /time`, refazer sobre `dev` limpo.
- **Repositório:** `dev = 0f69b51`; `main = ebc46cb` intacta; branches `evolution/v6|v7|v8` mantidas.
- **Projetos:** v5 `9e623776` e v6 `65e77ab2` e v7 `3df5d962` arquivados; **v8 `1d74b7dd` `accepted`** (versão corrente do Genesis, mas **desalinhada do `dev`**: contém o código de v7 que não está no `dev`). Dono `8c84633f`: orçamento US$ 50, gasto US$ 41,25, saldo US$ 8,75, **sem pausa**.
- **Guard:** `kill_switch=off`; global e tenant US$ 20/h (alterados pelo orquestrador; antes 12/12), global US$ 55/dia; ledger do tenant US$ 41,25.
- **Flags:** inalteradas (`CARDS_BANCADA=1`, `EVOLUTION_PROMOTE_BANCADA=1`, `TASK_INHERIT_TRANSITIVE=1`).
- **Limpeza:** tokens apagados. Permanecem em `/tmp/r45c`: scripts (`env.sh`, `flow.sh`, `mon.sh`, `indep.sh`), clones `base-c*`/`pr-c*`, resultados `res-*.json`, `timeline.txt`; `/tmp/adm.tok` expira sozinho. O FTS (`:7878`) segue no ar.
