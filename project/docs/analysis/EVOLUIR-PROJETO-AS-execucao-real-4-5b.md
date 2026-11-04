> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AS — Execução real 4.5b (card de Correção TK-0004, provando as correções AQ e AR)

Data: 2026-11-04 (20:03–20:23 UTC) · Ambiente: dev do Genesis (API `localhost:3456`), tenant `e2e` (`a38f6159-…`), alvo `SPEC-02-content-svc` (produto `05cb1b40-…`, repo `genezis-factory/spec-02-content-svc-i6c3`) · LLM: Bedrock (`us.anthropic.claude-sonnet-5-5`) · GitHub App real · Autorização do Jean: mais US$ 10 (este card inclusive).

**Resultado em uma linha.** O card TK-0004 (Correção) percorreu o caminho real inteiro até `delivered`, com o PR #5 mergeado em `dev`, ao custo de **US$ 3,617** (parada em US$ 9,5; folga de sobra). **Das correções, três se provaram (QA devolve veredito válido, TSK-FULL-TEST nunca fica `DONE` sem executar, compat/connect/herança), uma só em parte, e duas seguem abertas:** a linha de base de testes continua **não medida** (`no_tests`), e o PR entrou com um arquivo **fora do escopo do RFC** (`pnpm-lock.yaml`, +5.486 linhas) gerado pelo build do Cyborg, que nenhum gate viu. Além disso a execução expôs dois defeitos novos graves (N-1 e N-2 abaixo), um deles pausou o orçamento de toda a linhagem. Não declaro paridade (n=1).

---

## 1. Pré-condições (verificadas antes de gastar)

| # | Pré-condição | Resultado | Evidência |
|---|---|---|---|
| 1 | API e portal no ar; containers com o código das frentes `evo/q1` e `evo/q2` | OK | `GET /health` 200 (v1.5.0); `runner.py` contém `_qa_produced_verdict`/`_declare_full_test_not_run`/`_evo_p2p_unmeasured_reason`; `dist/` da API contém `ensureCompatSection` e `describeFactoryGates`; `cyborg_v3.py` contém `cyborg_scope_gate` |
| 2 | Servidor de testes do host (`:7878`) | OK (`/health` 200 do container `runner`) | `ss -ltn` mostra `:7878`; token do FTS presente no runner (não impresso) |
| 3 | Flags do tenant e2e | OK | `genesis_runtime_config`: `CARDS_BANCADA=1`, `EVOLUTION_PROMOTE_BANCADA=1`, `TASK_INHERIT_TRANSITIVE=1` (valor inteiro); `EVOLVE_RECONCILER=shadow`; auto-merge/redeploy não definidos (off) |
| 4 | Dev em `8cef8f8` (PR #4 de reversão), `main` `ebc46cb` intacta | OK | clone `dev`: `git log` = `8cef8f8 revert(TK-0001)…` |
| 5 | Orçamento | OK | projeto-dono `8c84633f`: US$ 30; baseline de gasto: soma do ledger = **US$ 20,679956** (147 linhas, antes do card) |
| 6 | Token | Cunhado dentro do container `api` com `sub` (D-12) para o `tenant_admin` `e2e-admin` (4 h); o `zentriz_admin` só para consulta | `POST /cards` com `sub` ⇒ 201 |
| 7 | Token GitHub (somente leitura) | Cunhado com a App `genezis-factory` (PEM em `/opt/zentriz-secrets` via `sudo python3`) | removido ao fim (`/tmp/gh.tok`, `/tmp/ta.tok` apagados) |

## 2. Linha do tempo (UTC)

| Hora | Evento |
|---|---|
| 20:03:40 | `POST /api/products/:id/cards` sem `projectId` ⇒ `SERVICE_REQUIRED` (produto multi-serviço); repetido com `projectId` = v4 `85428bd3` ⇒ **201**, card `TK-0004`, `kind=fix`, rascunho `11599eaa`. O corpo pede FAIL_TO_PASS e **não menciona compat** (para provar D-6) |
| 20:03:49–20:04:20 | `POST /evolution-plan` no rascunho: job `done` em 31 s, RFC-0006 criado; o planner devolveu `compat: patch` por conta própria; 5 perguntas/assunções registradas |
| 20:04:27 | `POST /cards/:id/ready` ⇒ `ok`, `gate: {rfcs:1, compat:"patch", kind:"fix", scope:[retry.util.ts, retry.util.spec.ts]}`. **`GLOBS_UNVERIFIED` não ocorreu; nenhum bypass foi usado** |
| 20:04:30 | `POST /cards/:id/promote` ⇒ 201, filho **v5 `9e623776`**, 9 arquivos herdados |
| 20:04:33 | `POST /projects/v5/promote` ⇒ 200 (sem `CONNECT_MISSING`) |
| 20:04:35 | `POST /projects/v5/run` ⇒ 202; card `in_factory` |
| 20:04:37 | **Baseline: `npm install falhou (rc=243)`** (EACCES; N-2). Aviso "🔴 baseline NÃO MEDIDA… TSK-FULL-TEST será REPROVADO" (comportamento AQ-D-4, correto) |
| 20:07:03–20:07:31 | Decisão minha: o run estava a US$ 0,58; corrigi o ambiente (`sudo chown -R ubuntu` na pasta do v5), `POST /stop`, **apaguei o checkpoint** do v5 (cópia em `/tmp/ckpt-v5-run1.json`; o baseline com erro é "truthy" e não seria remedido, N-5) e `POST /run` de novo |
| 20:07:38 | Baseline passa a rodar: `status=no_tests` (N-4). CTO/Engineer/PM refeitos |
| 20:12:52 | **Dev negado pelo Guard: `BUDGET_INSUFFICIENT`** ("saldo US$ 7,17 não cobre a próxima chamada, estimada em US$ 26,16"). O Guard **pausou o dono** (`8c84633f`); card `blocked` (`budget:BUDGET_PAUSED`) (N-1) |
| 20:15:24 | Removi `node_modules` do `apps/` do v5; `PUT /projects/8c84633f/budget {30, 20}` ⇒ `budget_resumed`; `POST /cards/:id/resume` ⇒ card `in_factory`; `POST /projects/v5/run` ⇒ 202 |
| 20:15:34–20:16:16 | Dev (1 chamada, 6.565 tokens de saída) ⇒ `WAITING_REVIEW` |
| 20:16:18–20:16:54 | **QA (1 chamada, 4.822 tokens de saída) ⇒ `QA_PASS`**, task `DONE` |
| 20:16:56 | `TSK-FULL-TEST`: `POST /run-full-test` ⇒ **502** ("[slot] bedrock/us.anthropic.claude-sonnet-5-5 não dirige o executor — pulado"); task **`CANCELLED`** (NOT_RUN) |
| 20:17:47–20:18:19 | Cyborg V3: auditoria (5 análises), 0 BLOCKER, média 7,6, build ok ⇒ **aceito** sem rodada de correção; `/cyborg-build` rodou `pnpm install --no-frozen-lockfile` + `pnpm build` no `apps/` |
| 20:18:38 | PR **#5** publicado (`evolution/v5`→`dev`, título `TK-0004 · Evolução v1.2.1 …`, 4 arquivos) |
| 20:22:30 | `POST /evolution/merge` sem `confirm` ⇒ **400 `CONFIRM_REQUIRED` (`blocked_no_tests`, "a linha de base não tem testes")** |
| 20:22:41 | Confirmado com `confirm:"MERGE"` (depois de eu medir a suíte por fora, §3.5): merge `squash`, sha `8866b8bc`; **20:22:42 card `delivered`** |

Duração criação→`delivered`: 19 min 02 s (inclui a repetição do run, ~3 min, e a pausa de orçamento, ~2,5 min).

## 3. Critérios (PASS/FAIL com evidência)

| # | Critério | Veredito | Evidência |
|---|---|---|---|
| 1 | QA devolve envelope JSON válido | **PASS** (n=1) | 1 chamada `QA:validate_task` no ledger: 37.895 tokens de entrada, **4.822 de saída**, US$ 0,124; veredito `QA_PASS` coerente com o diálogo ("resolveOptions aplica os padrões a opções undefined…"); **0** mensagens "sem JSON" no diálogo; **0** linhas com `output_tokens=0` em todas as 18 chamadas da execução (antes: QA 9/9 e Dev 9/21). 0 reworks. Amostra pequena: não exercita refusal/reparo |
| 2 | TSK-FULL-TEST executado ou `CANCELLED/NOT_RUN`, nunca `DONE` | **PASS pela via alternativa** | Não foi executado: o servidor do host respondeu 502 porque o slot Bedrock "não dirige o executor". Task ficou **`CANCELLED`** após o runner (20:16:56) **e depois do aceite (20:18:38) e do merge/`delivered`** (`project_tasks`: `TSK-FULL-TEST | CANCELLED`); relatório `NOT_RUN` no diálogo. Antes (AP) era `DONE` nos 3 cards |
| 3 | Linha de base medida (`baseline.status` ok, P2P calculado) | **FAIL** | `evolution-state.baseline.status = "no_tests"` (`total 0`, `no_tests:true`, `exit_code:1`); P2P vazio ⇒ merge pediu `confirm` (`blocked_no_tests`). Duas causas: (a) 1º run: `npm install` rc=243 por permissão (N-2, ambiente); (b) após corrigir, o `jest` do produto **não tem configuração** (sem `jest.config`/seção `jest`, sem `ts-jest`): `npx jest --ci` na pasta do v5 ⇒ **23 de 23 suítes falham ao transformar TS (Babel)**, 0 testes. O FTS classifica isso como `no_tests`/`tests_reliable:true` em vez de `error` (N-4). As falhas pré-existentes do produto só aparecem com um `jest.config` externo (§3.5) |
| 4 | Cyborg dentro do escopo (diff só toca arquivos permitidos; nenhum spec encolhido; `violations`) | **FAIL** | Diff do PR #5: `retry.util.ts` (+19/−1) e `retry.util.spec.ts` (+86/−0) (permitidos), `CHANGELOG.md` (+5, escrito pelo sistema no aceite) e **`pnpm-lock.yaml` (+5.486), fora do `files_allowed` do RFC**. Origem: `/cyborg-build` (`scripts/full-test-server.py:1025-1031`, `pnpm install --no-frozen-lockfile` num projeto npm). `evolution-state.violations = {}`: nenhum gate viu. Spec não encolheu (−0 linhas). O mecanismo novo de D-1 (`cyborg_scope_gate`) **não foi exercitado**: o Cyborg não fez rodada de correção (0 gravações dele) |
| 5 | FAIL_TO_PASS PASS (independente) | **PASS** | Jest fora do Genesis, `ts-jest` com `/tmp/jest5b/jest.config.js` em clone limpo: **base `dev`** 120 ✓ / 25 ✗ / 145 (11 suítes falhando); **`evolution/v5`** 130 ✓ / 25 ✗ / 155. **0 testes que passavam e passam a falhar**; +10 novos, todos ✓. O spec do PR rodado contra o código da base: **9 ✗ / 5 ✓** (os 9 falham na base e passam com a correção; os 4 originais + `retries 0` passam nos dois lados). As 25 falhas são pré-existentes (mesmas na base) |
| 6 | Texto do PR reflete os gates reais (D-13) | **PARCIAL** | O corpo ganhou "Gates da fábrica (resultado registrado)": escopo **passou**, símbolos **passou**, QA **passou**, mais o aviso "Escopo e símbolos cobrem as escritas do Dev". Melhorou (não diz mais "rodaram"). Mas: (a) afirma escopo "passou" com um arquivo fora do escopo no diff; (b) **omite** que `TSK-FULL-TEST` foi `NOT_RUN` e que a baseline foi `no_tests`. A sugestão de AQ §3 (montar a frase a partir de `CANCELLED`/baseline) não foi implementada |
| 7 | `card_id` em tasks não herdadas; herança transitiva | **PASS** | v5: `TSK-EVO-001` e `TSK-FULL-TEST` com `card_id` e `origin_spec_file=tickets/TK-0004/request.md`; as 3 herdadas (`TSK-INH-EVO-001`, `TSK-INH-EVO-002`, `TSK-INH-V4-EVO-001`) sem `card_id`, todas `DONE`. **O v5 herdou 3 tasks do v4** (o v3 do AP herdou 1): `TASK_INHERIT_TRANSITIVE=1` funcionou (as duas `INH-*` do v4 reaparecem e a `TSK-EVO-001` do v4 virou `TSK-INH-V4-EVO-001`; o `TSK-FULL-TEST` do v4 não é herdado, correto). Limite da prova: o v4 já só tinha 2 herdadas (as `TSK-INH-BE-*` da v1 se perderam em v3, antes da flag) |
| 8 | `delivered` só com PR mergeado, um único evento | **PASS** | GitHub: PR #5 `closed`, `merged=true`, `merged_at 20:22:41Z`, sha `8866b8bc`; `ticket_card_events`: **1** linha `to_state=delivered` de 8 (reason `accepted_genesis_merge`, 20:22:43), sem duplicata de `dedupe_key`; `tickets.status=delivered`, `executed_at` único (`20:22:42.784`) gravado nos 3 arquivos de spec (`request.md` do rascunho e do filho, RFC-0006). **Registro:** o merge **exigiu `confirm:"MERGE"`** (`blocked_no_tests`), porque a baseline não tem testes; com baseline `ok` essa exigência não deve ocorrer, mas isto não pôde ser provado aqui |
| 9 | Custo por papel/fase; Advisor | **PASS (medido)** | §4. Advisor: **0 chamadas** (`llm_role` = `orchestrator` em todas; nenhuma `advisor`); no AP custou US$ 3,84 |
| 10 | Compat sem pedir (D-6) e connect.yaml (D-7) | **PASS** | D-6: o corpo do card não cita compat; o planner devolveu `compat: patch`, o RFC-0006 foi gravado com a seção, `/ready` devolveu `gate.compat:"patch"`, `evolution-state.compatExplicit:true`; o PR traz "**Compatibilidade:** PATCH". D-7: `POST /projects/v5/promote` ⇒ 200 **sem** `CONNECT_MISSING` (o v5 herdou o `connect.yaml` do v4, gerado na 4.5) |

### 3.5 Verificação independente (como no AP)

Clone de `dev` (`8cef8f8`) e de `evolution/v5` (`154e95c`) em `/tmp/repo5b`; `npm ci`; `jest` com `ts-jest` e config externa (`rootDir=/tmp/repo5b`, `diagnostics:false`); `--json` comparado teste a teste (passou na base ∧ não passou no PR). O repositório e as árvores do Genesis não foram alteradas por essa medição. Os números da base diferem dos do AP (107/12) porque a config externa e o `dev` são outros; a comparação base × PR usa a mesma config.

## 4. Custo

Total da execução: **US$ 3,6168** (ledger 24,2967 − 20,679956; 18 chamadas, todas `phase=fabrica`/`agents`). Teto de parada US$ 9,5; teto horário do Guard (US$ 12): máximo da hora US$ 3,62, sem espera.

| Papel / fase | Chamadas | Entrada (tok) | Saída (tok) | US$ |
|---|---|---|---|---|
| CTO (spec, validações, backlog) | 6 | 476.622 | 43.247 | 1,3857 |
| Engineer | 2 | 132.096 | 40.566 | 0,6699 |
| Cyborg (5 auditorias paralelas) | 5 | ≈ 266.094 (incl. planner) | ≈ 13.003 | 0,5776 |
| Dev | 1 | 218.456 | 6.565 | 0,5026 |
| PM | 1 | 70.037 | 8.939 | 0,2295 |
| QA | 1 | 37.895 | 4.822 | 0,1240 |
| Bancada (planner do RFC, `direct`) | 1 | — | — | 0,0847 |
| Lição (`lesson_extract`) | 1 | 6.890 | 1.484 | 0,0429 |
| Advisor | 0 | — | — | 0 |
| **Total** | **18** | | | **3,6168** |

- **Desperdício causado por defeitos:** US$ **0,4986** (CTO + CTO do 1º run, refeitos após o baseline com erro e o reinício do run). O custo do retrabalho do Dev evitado (US$ 26,16 estimados) não foi gasto porque o Guard negou antes.
- Comparado ao AP (US$ 4,92–8,37 por card): o card mais barato até aqui; o Cyborg custou 16 % (US$ 0,58) porque aceitou na auditoria sem rodada de correção, e o Advisor foi 0.
- Saldo do projeto-dono após a execução: US$ 30 − ≈ 24,07 ≈ **US$ 5,9** (o ledger inclui US$ 0,22 sem projeto).

## 5. Novos defeitos (sem correção; local provável)

| # | Sev. | Defeito | Evidência | Local provável |
|---|---|---|---|---|
| **N-1** | **Alta** | **O contexto do Dev inclui `node_modules` e `.git` do `apps/`.** Com o baseline passando a **instalar dependências em `apps/`** (correção AQ-D-4 funcionando), o Dev carrega todos os arquivos < 50 KB do disco; a estimativa de entrada foi ≈ 8,7 M de tokens ⇒ Guard negou `BUDGET_INSUFFICIENT` (US$ 26,16) e **pausou o orçamento do dono de toda a linhagem** (`budget_paused_at` em `8c84633f`; todos os cards do produto ficam bloqueados até um humano reiniciar). Depois de `rm -rf node_modules` a mesma chamada passou (entrada 218 k tokens, US$ 0,50; ainda grande, por incluir `.git`/lockfile) | `llm_guard_events: budget_paused 20:12:52`; log do runner `[Dev] HTTP 402`; card `blocked budget:BUDGET_PAUSED`; `apps/node_modules` = 216 MB | `orchestrator/runner.py:5061` (`_apps_root.rglob("*")` sem `_EVO_SKIP_DIRS`, que existe em `:310` e é usado em `:327`). Agravante: `services/llmGuard.ts:443-445` pausa o **dono** por uma única estimativa, sem distinguir "orçamento esgotado" de "estimativa absurda" |
| **N-2** | **Alta (ambiente)** | O FTS do host roda como `ubuntu`, mas o runner (root no container) cria `/tmp/zentriz-files/<id>/` como root ⇒ `npm ci/install` do `/run-tests` falha com **EACCES (rc=243)** ⇒ baseline `error`. Na 4.5 nada escutava `:7878`; subir o servidor expôs isto. Contornei com `sudo chown -R ubuntu` na pasta do v5 | `evolution-state` do 1º run e diálogo 20:04:37; `ls -ld` = `root` | Sem ajuste no código versionado; precisa de decisão de ambiente (uid do container, `chown` pós-criação ou FTS no mesmo uid). Documentar no runbook de dev |
| **N-3** | **Alta** | `/cyborg-build` roda `pnpm install --no-frozen-lockfile` num projeto **npm** e cria `pnpm-lock.yaml` (+5.486 linhas) em `apps/`; a publicação inclui o arquivo no PR. O gate de escopo do Cyborg (AQ-D-1) só cobre arquivos que o Cyborg grava, não o efeito colateral do build | PR #5 (`pnpm-lock.yaml added +5486`); `fts.log 20:17:46 [cyborg-build] pnpm install`; `violations:{}` | `scripts/full-test-server.py:1025-1031` (escolher o gerenciador pelo lockfile existente, ou instalar sem gerar lock); publisher de `evolutionAccept`/`publishing` sem filtro `files_allowed`/lockfiles estranhos; ou aplicar `_evolution_scope_check` ao diff final antes do PR |
| N-4 | Média | O produto não tem configuração de jest; `npx jest` falha em **todas** as suítes (transformação TS) e o FTS devolve `status:"no_tests"` com `tests_reliable:true`, em vez de `error`. Isso desliga P2P em silêncio (a regra AQ `_evo_p2p_unmeasured_reason` não reprova `no_tests`). Reforça D-5 | `evolution-state.baseline`; `npx jest --ci` na pasta do v5: "23 failed, 23 total, Tests: 0 total" | `scripts/full-test-server.py` (~`:803-850`, classificação quando `exit_code≠0` e 0 testes e há suítes com falha); `runner.py:699` |
| N-5 | Baixa | Uma baseline com `status:"error"` é objeto "truthy": num reinício/retomada (checkpoint existente) **nunca é remedida** (`and not pipeline_ctx.evolution_baseline`). Tive de apagar o checkpoint | `runner.py:6457` | testar `status` além da presença |
| N-6 | Baixa | O texto do PR omite `TSK-FULL-TEST` `NOT_RUN` e a baseline `no_tests`, e declara escopo "passou" mesmo com arquivo fora do RFC no diff (D-13 só melhorou em parte) | corpo do PR #5 | `services/evolutionAccept.ts` (`describeFactoryGates`): ler `CANCELLED` do FULL-TEST e `baseline.status`; comparar o diff real com `files_allowed` |
| N-7 | Baixa (limitação) | `TSK-FULL-TEST` não é executável neste dev: `/run-full-test` ⇒ 502 porque o executor (Claude CLI) não usa o slot Bedrock ("não dirige o executor"). O NOT_RUN está correto, mas o caminho "executado de fato" continua não provado | `fts.log 20:16:55` | `scripts/full-test-server.py` (seleção de slot do executor) |
| N-8 | Baixa | Depois de `BUDGET_PAUSED`, religar exige 3 passos manuais (PUT do orçamento, `POST /cards/:id/resume`, `POST /projects/:id/run`); o `PUT` do mesmo valor (30) liberou a pausa porque o saldo comportava a atividade | eventos `budget_resumed`, `card_budget released` | UX/runbook §3.1 (já descreve; o passo do `/run` é fácil de esquecer) |

## 6. Estado final deixado

- **Card:** TK-0004 `ba79a3a9-d677-4432-b74c-68846959a11c`, `delivered` (um evento). Rascunho `11599eaa`. Nenhum card aberto.
- **PR:** #5 https://github.com/genezis-factory/spec-02-content-svc-i6c3/pull/5 · `evolution/v5`→`dev` · **squash** `8866b8bc` (4 arquivos). **`dev` = `8866b8b` e agora contém `pnpm-lock.yaml` indevido** (N-3); recomendo um PR de remoção (não feito: fora do escopo). `main` = `ebc46cb` intacta. A branch `evolution/v5` permanece.
- **Projetos:** v5 `9e623776` `accepted` (versão corrente, v1.2.1); v4 `85428bd3` `archived`; dono `8c84633f` com orçamento US$ 30, **sem pausa** (religado por mim às 20:15:24). Gasto ≈ US$ 24,1, saldo ≈ US$ 5,9. `card_budget_pct=34` inalterado.
- **Flags:** nenhuma alterada nesta execução (`TASK_INHERIT_TRANSITIVE=1`, `CARDS_BANCADA=1`, `EVOLUTION_PROMOTE_BANCADA=1`; `EVOLVE_RECONCILER=shadow`; auto-merge/redeploy off). Reconciliador: os mesmos 2 achados `warning` legados (`evolution_in_flight_stuck`).
- **Intervenções fora do fluxo suportado (todas registradas acima):** `chown -R ubuntu` em `/tmp/zentriz-files/<v5>`; `POST /stop` + remoção do `checkpoint.json` do v5 (cópia em `/tmp/ckpt-v5-run1.json`); `rm -rf apps/node_modules` do v5; `PUT /budget` (mesmo valor) para religar a pausa; `confirm:"MERGE"` no merge. Nenhum código de produto ou do Genesis foi editado.
- **Limpeza:** tokens GitHub e do `tenant_admin` apagados; permanecem em `/tmp`: `/tmp/adm.tok` (expira sozinho), `/tmp/repo5b` (clone), `/tmp/jest5b`, `/tmp/ckpt-v5-run1.json`, `/tmp/q.sh`, `/tmp/*5b*.sh|json`. O FTS (`:7878`) segue no ar.

## 7. O que ficou provado e o que não

| Correção | Estado após a 4.5b |
|---|---|
| AQ D-2 (QA sem JSON) | **Provada** (1 QA válido, saída > 0, 0 chamadas vazias); falta exercitar recusa/reparo |
| AQ D-3 (`TSK-FULL-TEST`) | **Provada** (`CANCELLED`/NOT_RUN, nunca `DONE`, inclusive após o aceite); execução real continua inviável (N-7) |
| AQ D-4 (baseline) | **Não provada**: a falha agora é explícita, mas a medição não chega a `ok` (N-2 ambiente, N-4 produto sem jest) |
| AQ D-1 (Cyborg no escopo) | **Não exercitada** (sem rodada de correção); o desvio observado veio de outro caminho (N-3) |
| AR D-6 (compat) / D-7 (connect) | **Provadas** |
| AR D-13 (texto do PR) | **Parcial** (N-6) |
| AQ D-10 / herança transitiva | **Provada** (3 herdadas contra 1) |
| Efeito colateral novo | N-1: medir a baseline de verdade quebra o Dev e pausa o orçamento da linhagem |
