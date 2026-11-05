> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BF — Execuções reais 4.5d (Correção + Recurso novo, depois de BB, BC e BD)

Data: 2026-11-05 (01:33–02:11 UTC) · Ambiente: dev do Genesis (API `localhost:3456`), tenant e2e (`a38f6159-…`), alvo `SPEC-02-content-svc` (produto `05cb1b40-…`, repo `genezis-factory/spec-02-content-svc-i6c3`) · LLM: Bedrock `us.anthropic.claude-sonnet-5-5` via slot `byoc_exempt` · GitHub App real · Autorização: +US$ 15 (orçamento do dono US$ 60).

**Resultado em uma linha.** Os dois cards (TK-0008 Correção, TK-0009 Recurso novo) produziram código **correto** (medição independente: 0 regressões reais, testes novos 100 % verdes, `tsc` do build sem erros), mas **nenhum chegou a PR**: o Cyborg parou os dois em `needs_human` porque o **gate de build novo (BB) não consegue instalar as dependências do produto** (`npm install` simples falha com `ERESOLVE`; o `/cyborg-build` não tem o fallback `--legacy-peer-deps` que o `/run-tests` tem). O sistema agora falha **fechado e com mensagem acionável**, mas **o gate F4 NÃO fecha**: sem PR não há merge nem `delivered`. Nenhum código quebrado foi aprovado (o oposto da 4.5c). Custo: **US$ 8,29** (ledger 41,252 → 49,543; parada em 53,0 não atingida).

Correções confirmadas ao vivo: D-1 (5/5 análises válidas, 0 `REPEAT_PAYLOAD`), D-3 (veredicto só por `FULL_TEST_VERDICT`), D-4 (as duas promoções por `git-clone`), BB item 5 (gate por rodada reverteu 6 rodadas), BD (recusa de card `in_factory` com 200). Persistem: baseline não medida (D-5/D-11) e o rótulo "46 de 23".

---

## 1. Pré-condições (verificadas antes de gastar)

| # | Pré-condição | Resultado | Evidência |
|---|---|---|---|
| 1 | API e containers com o código corrigido | OK | `GET /health` 200 v1.5.0; containers `api/agents/runner/cyborg/web` com ~1 min de uptime |
| 2 | FTS `:7878` com o código do BB | OK | processo reiniciado às 01:33:52 (`fts.log`), `scripts/full-test-server.py` com mtime 23:57 de 04/11 (posterior ao BB); `GET /health` 200 |
| 3 | Flags do tenant | OK | `genesis_runtime_config`: `CARDS_BANCADA=1`, `EVOLUTION_PROMOTE_BANCADA=1`, `TASK_INHERIT_TRANSITIVE=1`; `GET /products/:id/cards/capabilities` = `cardsBancada:true` |
| 4 | Repo | OK | `dev = 0f69b51`, `main = ebc46cb`; PRs #7 mergeado, #8 e #9 fechados sem merge |
| 5 | Linhagem | OK | HEAD v6 `65e77ab2` `accepted`; v7/v8 antigos `archived`; TK-0005 delivered, TK-0006/0007 rejected |
| 6 | Orçamento | OK | dono `8c84633f` `budget_usd=60`; ledger do tenant US$ 41,252 (linha de base) |
| 7 | Guard | OK | `kill_switch=off`, global 20/h e 75/dia, tenant 20/h, `repeat_max_per_6h=4`; `spend.lastHourUsd` = 0,08 antes do 1º card e 3,52 antes do 2º (regra A14/§2.7: `lastHour + 8 ≤ 20` cumprida nas duas promoções) |
| 8 | Tokens | OK | `tenant_admin` (`/tmp/ta.tok`) para criar/promover/recusar; `zentriz_admin` só para o Guard; token da App GitHub mintado com `sudo python3` + `jwt` (leitura), **apagado ao fim** |

Observação: o teto do tenant (20/h) continua igual ao global (20/h); o runbook §2.7 diz que o do tenant deve ficar abaixo. Não alterei (configuração do orquestrador); o gasto de pico da hora foi US$ 8,29, longe do teto.

## 2. Alvos escolhidos (pedidos pequenos e realistas; não repeti CircuitBreaker nem `GET /time`)

- **TK-0008 (Correção, `kind=fix`)**: `withRetry` (`src/common/utils/retry.util.ts`) soma o jitter (até 20 %) **depois** de cortar em `maxDelayMs`, então o atraso real chega a 1,2 x o teto (consumidor: outbox-worker). Reprodução: `Math.random=1`, base=max=1000, `retries=1` ⇒ `setTimeout(1200)`. Aceite: teste FAIL_TO_PASS, API inalterada, Non-goals explícitos.
- **TK-0009 (Recurso novo, `kind=feature`)**: `GET /live` no `HealthController` (sonda de liveness sem dependências, `{status:'alive'}`), testes de que não acessa `connection`, regressão de `/health`, `/ready`, `/metrics`; Non-goals explícitos (sem deps, sem módulo/DTO/guard, sem CHANGELOG/package.json).

## 3. Linha do tempo (UTC)

| Hora | Evento |
|---|---|
| **TK-0008** | |
| 01:36:03 | Card criado (`ac1c54e6`), `projectId` = v6 `65e77ab2` |
| 01:36:36 | Planner (rascunho `9eeac1af`): RFC-0010, `compat: patch` declarado sem pedir, 0 perguntas; `/ready` ⇒ `gate {rfcs:1, compat:"patch", scope:[retry.util.ts, retry.util.spec.ts]}` |
| 01:36:39 | `/promote` ⇒ filho **v7 `66c3ff7c`**, **`evolutionSource: git-clone`**, `evolutionSourceError: null`; `POST /projects/:id/promote` 200; 01:36:42 `/run` |
| 01:44:05 | Dev concluiu (1 chamada); 01:44:26 **QA_PASS** (1 chamada) |
| 01:44:28–01:47:00 | **TSK-FULL-TEST executada pelo FTS** (2 min 32 s): build passou na cópia; `FULL_TEST_VERDICT: REJECTED`; `approved=False`; 01:47:06 `QA_FAIL` pelo gate P2P |
| 01:47:52 | Cyborg assume; auditoria prévia **5/5 válidas**, 5 BLOCKER, `build_rc=1` |
| 01:48:18–01:49:14 | Rodada 1 (Dev gravou 0 arquivo: escrita rejeitada por "SÍMBOLOS REMOVIDOS DEFAULT_OPTIONS"), escalação "conclusão de feature" (2 escritas rejeitadas: símbolos + "TESTES REDUZIDOS 18 → 10"); **01:49:14 `needs_human`** |
| 01:54:12 | **Recusado por mim** (`POST /api/cards/:id/reject`, BD) ⇒ 200, filho `archived` |
| **TK-0009** | |
| 01:53:40 | Card criado (`5d7f2404`) com `projectId` = v7 (HEAD vivo na hora); 01:54:06 RFC-0011, `compat: minor`, 2 perguntas/assunções |
| 01:54:08 | `/promote` com v7 `blocked_cyborg` ⇒ **409 `EVOLUTION_IN_FLIGHT`** (não `CARD_PREVIOUS_UNMERGED`; registrado) |
| 01:54:12–01:54:21 | Após recusar TK-0008: `/promote` ⇒ 201, filho **v7 `217cf240`** sobre **v6** (`git-clone`; a supersessão foi desfeita, sem `CARD_BASE_STALE`); `/run` 01:54:21 |
| 02:02:50 | 2 tarefas Dev (EVO-001, EVO-002) + 2 QA_PASS; 02:04:33–02:05:20 FULL-TEST (47 s) ⇒ `REJECTED`, `QA_FAIL` às 02:05:26 |
| 02:05:35 | Cyborg: 5/5 válidas, 4 BLOCKER, `build_rc=1`; **5 rodadas + 1 de escalação REVERTIDAS pelo gate** (BB); 02:07:52 `needs_human` |

Duração até o ponto de parada: TK-0008 13 min 11 s (Fábrica 12 min 36 s); TK-0009 13 min 31 s.

## 4. Critérios (PASS/FAIL com evidência do sistema)

| # | Critério | TK-0008 (Correção) | TK-0009 (Recurso novo) |
|---|---|---|---|
| 1 | QA com envelope válido e coerente; `gate_reverts` | **PASS.** 1 chamada `QA:validate_task`, 2.851 tok de saída, 0 chamadas com saída 0; QA_PASS coerente com a minha medição (a correção está certa). Sem QA_FAIL de tarefa ⇒ sem rodada de correção por QA. O QA continua **sem executar testes** (D-9). Rodadas do Cyborg: 0 aceitas, 0 revertidas (2 escritas rejeitadas pelo gate de escopo/símbolos) | **PASS.** 2 chamadas, 8.540 tok, 0 vazias; QA_PASS nas duas tarefas, coerente (20 testes novos passam). **`gate_reverts`: 6 rodadas revertidas** (rodadas 1–5 + 1 da escalação) com a causa "build/tipos não verificáveis… falha fechada"; a causa foi ao prompt da rodada seguinte. 2 escritas rejeitadas (testes 24 → 9; `apps/package.json` fora do escopo) |
| 2 | TSK-FULL-TEST executado de verdade | **PASS (executada, reprovada).** FTS `Concluída: approved=False (FULL_TEST_VERDICT: REJECTED) rc=0`, 2 min 32 s, slot `byoc_exempt`. O CLI rodou `npm run build` (OK), criou `project/start.sh`, subiu MongoDB em Docker e a API (51 rotas, 200 em `/health`), achou 13 testes falhando e adicionou jest/ts-jest na cópia. Task `QA_FAIL`, nunca `DONE` | **PASS (executada, reprovada).** 47 s; build OK; API não sobe (sem Mongo, `ECONNREFUSED`); 24 suítes sem config de jest; `REJECTED`, `QA_FAIL`. Relatório honesto |
| 3 | Baseline medida / `no_tests` / erro acionável | **FAIL (não medida).** `status=error`, `install: "npm install --legacy-peer-deps (fallback ERESOLVE)"`, `workdir: copy`; "46 de 23 suíte(s) falharam ao carregar/transformar (0 testes executados)… provável falta de configuração de testes". Mensagem acionável, mas sem P2P; rótulo "46 de 23" persiste (D-5) | **FAIL** (idem; a mensagem da FULL-TEST cita "48 de 24", a baseline "46 de 23": rótulos inconsistentes) |
| 4 | Auditoria final do Cyborg com ≥ 4/5 análises válidas | **PASS.** `audit.json.validity = {valid:5, total:5, required:4, sufficient:true, invalid:{}}`; 0 `repeat_payload_denied` no Guard na rodada. Veredito: `needs_human` (5 BLOCKER; `build_rc=1`) | **PASS.** `validity` idêntico 5/5; 4 BLOCKER; 0 REPEAT_PAYLOAD. Veredito `needs_human` |
| 5 | Build do produto passa no PR | **N/A (sem PR).** Medição por fora no código do filho: `tsc --noEmit -p tsconfig.build.json` rc 0, 0 erros (base também). **Mas o gate de build do próprio sistema FALHOU** (D-12): `BUILD NÃO EXECUTOU: install falhou (rc=1)… ERESOLVE`, `type_check_rc=-1` | **N/A (sem PR).** `tsc` por fora rc 0, 0 erros. Mesmo gate de build do sistema falhou (D-12) |
| 6 | Diff só no escopo do RFC; sem lockfile/artefato; spec não encolheu | **PASS.** `touchedFiles`: `retry.util.ts` (+2/−1) e `retry.util.spec.ts` (+73/−0, 18 → 22 casos); sem lockfile; `violations` do Cyborg vazias no que foi gravado; tentativas do Cyborg de remover `DEFAULT_OPTIONS` e reduzir testes **bloqueadas** pelo gate | **PASS com ressalva.** Controller (+8) e spec (+94); mais um arquivo novo `health.controller.live.http.spec.ts` (148 linhas) que **não está** no `files_allowed`, mas casa `**/*.spec.*` de `EVO_ALWAYS_ALLOWED` (por desenho, `lib/evolutionScope.ts:13`); o gate marcou `scope: passou (3 arquivos)`. Cyborg tentou `package.json` e reduzir o spec: bloqueado |
| 7 | FAIL_TO_PASS PASS e sem regressão (medição independente) | **PASS.** ts-jest, base `dev` × filho: 136 ✓/25 ✗ → 140 ✓/25 ✗; 4 testes novos, **4 ✓**; rodando o spec novo contra o código da base, **2 dos 4 falham** (os de teto) e 2 passam (guardas), logo F2P real. **0 regressões** | **PASS.** 136 ✓/25 ✗ → 155 ✓/26 ✗; 20 testes novos, **20 ✓**; 1 "regressão" aparente (`circuit-breaker … HALF_OPEN após o cooldown`) é o teste **intermitente** D-10 em arquivo não tocado (reproduzi no filho: 2 falhas em 6 execuções isoladas). 0 regressões reais |
| 8 | Texto do PR com os 5 gates reais | **N/A (sem PR).** `evolution-state.factoryGates` (a fonte do texto): escopo passou, símbolos passou, QA passou, **FULL-TEST FALHOU**, baseline `not_run`; coerente com a minha medição | **N/A (sem PR).** Mesmos 5 gates, coerentes |
| 9 | `card_id` nas tasks não herdadas | **PASS.** `TSK-EVO-001` e `TSK-FULL-TEST` com `card_id`; 5 herdadas (`INH-*`, incl. `INH-V6-EVO-001`) sem | **PASS.** `EVO-001`, `EVO-002`, `FULL-TEST` com `card_id`; 5 herdadas sem |
| 10 | `delivered` só com PR mergeado, evento único; `factoryHealth` | **N/A (corretamente não entregue).** 0 eventos `delivered` (6 eventos de transição); card `rejected`. `factoryHealth: null` (filho nunca aceito, esperado pelo BC) | **N/A (corretamente não entregue).** 0 `delivered` (5 eventos); card `in_factory`; `factoryHealth: null` |
| 11 | Custo por papel/fase; Advisor 0 | **US$ 3,448** (§5); Advisor **0** (nenhuma chamada `advisor` desde 01:30; as 38 do tenant são de 04/11 13:58–16:13) | **US$ 4,843**; Advisor **0** |
| 12 | Intervenções manuais | §6 | §6 |

### Verificação independente (script `/tmp/r45d/indep2.sh`)

Cópia de `dev` (`0f69b51`) × árvore `apps/` do filho (copiada do volume do container, somente leitura), `node_modules` do `/tmp/repo5b`, `jest` com `ts-jest` (`diagnostics:false`, config externa), `--json` comparado teste a teste, mais `tsc --noEmit -p tsconfig.build.json` em ambos. Resultados: `/tmp/r45d/m-c1/`, `/tmp/r45d/m-c2/` (`res-*.json`, `log-*.txt`, `tsc-*.txt`). Diffs: TK-0008 mexe em 2 arquivos; TK-0009 em 3; nada mais em `apps/src`. Nada do repositório ou das árvores do Genesis foi alterado.

## 5. Custo (ledger do tenant: 41,252 → 49,543 = US$ 8,291; 44 chamadas; 0 com saída 0)

| Papel / fase | TK-0008 (US$) | TK-0009 (US$) |
|---|---|---|
| CTO | 1,288 (5) | 1,303 (5) |
| Cyborg (`purpose=direct`: auditorias + rodadas) | 0,903 (7) | 1,191 (12) |
| Dev | 0,481 (1) | 1,395 (3) |
| Engineer | 0,311 (1) | 0,337 (1) |
| PM | 0,233 (1) | 0,255 (1) |
| QA | 0,107 (1) | 0,240 (2) |
| Planner (rascunho/Bancada) | 0,079 | 0,072 |
| Lição (`lesson_extract`) | 0,046 | 0,051 |
| Advisor | 0 | 0 |
| **Total** | **3,448** | **4,843** |

Leitura: o Cyborg caiu de ~50 % para 26 %/25 % do custo (não há mais 3 rodadas "pagas"), mas ainda gasta US$ 0,9–1,2 para **não entregar**, e no TK-0009 o Dev pagou 3 chamadas (1,395) por um endpoint de 8 linhas (testes extensos, mais um arquivo de spec HTTP fora do RFC). Hora de pico do Guard: US$ 8,29 (teto 20), sem `kill_switch` nem `tenant_hourly_cap_denied`. Saldo do dono: US$ 60 - 49,54 = US$ 10,46.

## 6. Intervenções manuais (todas)

1. Criação dos dois cards, `ready`, `promote` e `POST /projects/:id/promote` + `/run` pelas rotas normais (sem `chown`, `stop`, remoção de checkpoint, `PUT /budget` nem `budget/resume`; sem `confirm`, `confirmScope` ou merge).
2. **`POST /api/cards/ac1c54e6…/reject`** (TK-0008) às 01:54:12, motivo gravado (`Rodada 4.5d: Cyborg needs_human (build do gate não executou: npm install ERESOLVE)…`). Necessária porque o card em `blocked_cyborg` mantinha `EVOLUTION_IN_FLIGHT` para o TK-0009 (a execução do card 2 era o objetivo do round). Também exerce a saída do BD.
3. Nenhum bypass de Guard, nenhuma edição de código de produto ou do Genesis, nenhum merge, nenhum PR criado. Kill switch não disparou.
4. Temporários em `/tmp/r45d` (scripts, clones `src-dev`, cópias `wk1/wk2`, medições `m-c1/m-c2`, `inst/`); token GitHub apagado.

## 7. Defeitos novos (sem correção; local provável)

| # | Sev. | Defeito | Evidência | Local provável |
|---|---|---|---|---|
| **D-12** | **Alta (bloqueia o F4)** | **O gate de build do Cyborg não consegue instalar as dependências do produto.** `npm install` simples falha com `ERESOLVE` (`@nestjs/config@^3.2.0` pede peer `@nestjs/common` 8–10; o produto usa 11). O `/run-tests` tem o fallback `--legacy-peer-deps` (a baseline mostra `install: "…(fallback ERESOLVE)"`), o `/cyborg-build` **não**. Com o BB fail-closed (correto), **todo card deste produto** termina `needs_human`, com `build_rc=1`, `type_check_rc=-1` e todas as rodadas de correção revertidas | `audit.json.build.output_tail` dos dois filhos ("BUILD NÃO EXECUTOU: install falhou (rc=1)… ERESOLVE"); reproduzido por fora num clone limpo: `npm install --no-audit --no-fund --prefer-offline` rc 1, com `--legacy-peer-deps` rc 0 (610 pacotes, 3 s) — `/tmp/r45d/inst-plain.txt`, `inst-legacy.txt` | `scripts/full-test-server.py:794-804` (`_pick_node_pm` devolve `npm install … --prefer-offline` sem fallback) e `_cyborg_build_core` (~834); o fallback existe só em ~1124-1127. Alternativa de produto: alinhar `@nestjs/config` à major 11 |
| **D-13** | Alta | **A auditoria do Cyborg avalia o produto inteiro, não o delta do card.** Um bugfix de 2 arquivos recebeu "5 BLOCKER / 11 gaps" por dívida antiga (spec de `ActivitiesService` com modelo inventado, FR-13 sem rota, FR-14, NFR-02 sem guard) e o Cyborg entrou em "CONCLUSÃO DE FEATURE (autorizado a ADICIONAR módulos inteiros)" para uma correção de 1 linha. Tentou remover `DEFAULT_OPTIONS`, reduzir testes (18 → 10; 24 → 9) e editar `package.json`; tudo foi barrado pelos gates de símbolos/testes/escopo (bom), mas o custo e o risco existem, e mesmo com D-12 resolvido o card seria reprovado por dívida alheia | `audit.json` dos dois filhos (findings `fr_partial`, `invented_field`, `nfr_gap`); diálogo 01:48:34 / 02:07:09; `scope_violations.json` | `orchestrator/cyborg_v3.py` (briefing das 5 análises e escalação de feature): escopo do veredito = arquivos tocados pelo card/RFC; dívida pré-existente vira achado informativo |
| **D-14** | Média | **Rodadas pagas sem chance de aceitar.** No TK-0009 as rodadas 1–5 chamaram o Dev e só depois foram revertidas por "tsc indisponível… install falhou". O gate poderia curto-circuitar **antes** da primeira rodada quando o build não executa (causa externa ao código) e escalar direto para `needs_human` | diálogo 02:06:11–02:07:09 (5 reverts idênticos); 12 chamadas Cyborg, US$ 1,19 | `cyborg_v3.py`: `autonomous_rework` / `round_integrity_gate` (verificar a executabilidade do build uma vez antes do laço) |
| **D-5 (persiste)** | Média | Rótulo "46 de 23 suítes" soma `numFailedTestSuites` + `numRuntimeErrorTestSuites`; mensagens da FULL-TEST ("48 de 24") e da baseline ("46 de 23") divergem | evolution-state e diálogo dos dois filhos | `scripts/full-test-server.py:789-790` |
| **D-11 (persiste)** | Média | Baseline nunca medida: `npx jest` na cópia sem config de ts-jest ⇒ "Test suite failed to run" nas 23-24 suítes. A FULL-TEST (CLI) descobre o conserto (adiciona jest/ts-jest na cópia) mas ele não volta ao projeto nem ao repo, então P2P nunca existe e todo merge cairia em `confirm:"MERGE"` | `changed_files` do FTS; `baseline.status=error` nos dois | produto sem `jest.config`; ou card de bootstrap; ou baseline com config padrão ts-jest |
| D-15 | Baixa | O CLI da FULL-TEST **subiu MongoDB em Docker no host** e criou `project/start.sh` (na cópia) no TK-0008; efeito colateral fora da cópia gravável (nenhum container sobrou ao fim) | `QA_REPORT_TSK-FULL-TEST.md` do TK-0008 | `project/full-test-prompt.md` (restringir uso do Docker do host) |
| D-16 | Baixa | Texto do diálogo diz "enviadas ao Dev via **Foundry**" com o backend em Bedrock | diálogo 01:48:18, 02:06:11 | `cyborg_v3.py` (mensagem fixa) |
| D-17 | Baixa | Card criado com `projectId` = v7 (HEAD vivo) e promovido depois da recusa do TK-0008 sobre **v6**: não houve `CARD_BASE_STALE` (o card guarda v7, o filho nasce de v6). Inofensivo aqui (o RFC não depende do v7), mas o `base-spec`/validação do card foi feita sobre uma base que deixou de existir | `projectId` do TK-0009 `66c3ff7c` × `parentProjectId` do filho `65e77ab2` | `services/cardPromote.ts` / `cardRevalidate.ts` (revalidar quando a base do card foi arquivada por recusa) |
| D-9, D-10 (persistem) | Baixa | QA não roda testes; teste intermitente `circuit-breaker … HALF_OPEN` gera falsa regressão por medição | ver 4.5c | pipeline Dev/QA; `circuit-breaker.util.spec.ts:23-33` |

Registro de comportamento (não é defeito): promover o card 2 enquanto o filho do card 1 estava `blocked_cyborg` devolveu **409 `EVOLUTION_IN_FLIGHT`**, não `CARD_PREVIOUS_UNMERGED` (este último só vale com filho `accepted` sem merge). Isso confirma a sequência obrigatória "card 1 terminal antes do card 2".

## 8. O que ficou provado e o que não (gate F4)

| Item | Estado após a 4.5d |
|---|---|
| D-1 (aceite fail-open) | **Provado corrigido ao vivo**: 5/5 análises válidas, `validity` no `audit.json`, 0 `REPEAT_PAYLOAD`; Cyborg **não aceita** auditoria com BLOCKER/build falho |
| D-2/BB item 5 (gate de build e de rodada) | **Provado fail-closed** (6 rodadas revertidas, "tipos NÃO verificados"), **mas inoperante neste produto** (D-12): não foi possível provar que ele deixa passar código bom |
| D-3 (aprovação por substring) | **Provado**: `FULL_TEST_VERDICT: REJECTED` ⇒ `approved=False` |
| D-4/BC (`disk-copy`, base) | **Provado**: duas promoções por `git-clone`, `evolutionSourceError: null` |
| BD (saída do card pendurado) | **Provado em execução real**: `reject` de card `in_factory` com filho `blocked_cyborg` ⇒ 200, filho `archived`, base volta a v6 |
| Baseline medida / P2P | **Não provado** (erro explícito, D-11/D-5) |
| Texto do PR com 5 gates reais | **Não exercitado** (sem PR); os `factoryGates` na API estão coerentes |
| `delivered` só com PR mergeado | **Não exercitado** (corretamente não entregue) |
| Entrega ponta a ponta com qualidade (F4) | **NÃO fechado**: 0 de 2 chegaram a PR. A correção do produto estava certa nos dois casos; o impedimento é D-12 (e, depois dele, D-13) |

Recomendação mínima antes de uma nova rodada: (1) fallback `--legacy-peer-deps` em `_pick_node_pm`/`_cyborg_build_core` (D-12; ou alinhar o `package.json` do produto); (2) escopo do veredito do Cyborg ao delta do card (D-13) — sem isso, a dívida antiga do SPEC-02 reprovaria qualquer card; (3) curto-circuito do laço de rodadas quando o build não é executável (D-14); (4) config de jest do produto/baseline (D-11). Reaproveitar os dois cards: **o código dos filhos está correto**, mas os filhos são `blocked_cyborg` e o TK-0008 foi recusado (o filho dele, v7 `66c3ff7c`, está arquivado).

## 9. Estado final deixado

- **Cards (tenant e2e):** TK-0008 `ac1c54e6-0746-43c1-98d0-77ce874b2cef` **rejected** (filho v7 `66c3ff7c` arquivado; sem PR). TK-0009 `5d7f2404-c366-4943-97be-512fc1cc0037` **in_factory** (filho v7 `217cf240-5675-4485-9a10-de2fca88a23f` **`blocked_cyborg`**, sem PR). **Decisão para o orquestrador:** recusar o TK-0009 (`POST /api/cards/:id/reject`, BD) para liberar a linhagem, ou corrigir D-12 e retomar; **não recusei** para não decidir por você.
- **PRs:** nenhum novo. #7 mergeado (`0f69b51`); #8 e #9 fechados sem merge (da 4.5c).
- **Repositório:** `dev = 0f69b51`, `main = ebc46cb`, intactos; nenhuma branch `evolution/*` nova publicada.
- **Linhagem:** HEAD v6 `65e77ab2` `accepted`; v7 `217cf240` `blocked_cyborg` (em voo, bloqueia novas promoções com `EVOLUTION_IN_FLIGHT`).
- **Orçamento:** dono `8c84633f` US$ 60, gasto US$ 49,54, saldo US$ 10,46, sem pausa. Ledger do tenant US$ 49,543.
- **Guard:** `kill_switch=off`; global e tenant US$ 20/h, global US$ 75/dia; gasto da última hora US$ 8,29 no fim.
- **Flags:** inalteradas. **FTS `:7878`:** no ar, não reiniciado por mim.
- **Limpeza:** token GitHub apagado; `/tmp/ta.tok` e `/tmp/adm.tok` são do orquestrador (expiram sozinhos). Permanecem em `/tmp/r45d` scripts, cópias e medições.
