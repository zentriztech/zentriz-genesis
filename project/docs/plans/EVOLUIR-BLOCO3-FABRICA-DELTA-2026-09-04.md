> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir — Bloco 3: fábrica por delta, itens profundos (plano v1, 2026-09-04)

| Campo | Valor |
|---|---|
| Status | **v2 — adversarial do plano incorporada (§ Adversarial); pesquisa em § Pesquisa; ordem aprovada F4 → F1 → F2 → F3a → F3b** |
| Base | Fases 1+2 + bloco 2 do Evoluir em `dev` (até `8131fe3`); RFC-0005 completo |
| Fora | bloco 4 (merge automático, redeploy cloud, Deadpool pós-merge, Dev em diff) |

## Fatos (código, 2026-09-04)
- **DevOps roda sempre** ao fim das tasks (`runner.py` ~3835: "Always run DevOps when all tasks are done"); `TSK-DEVOPS-001` é semeada no portal (GAP-P5). O filho de evolução já traz `Dockerfile`/compose no `apps/` (clone do repo achatado do pai).
- **Reconciliação Connect** (`connect_contracts.py:_code_corpus`) lê **só `ctx.artifacts`** (o que os agentes geraram nesta run) — em evolução, o código herdado do pai nunca entra → `declared_but_missing` falso para tudo que já existia.
- **TSK-FULL-TEST** embarca o projeto (tar) ao executor isolado via `executor_bridge` (`ship_project`/`prepare_untrusted_job`) e roda ao final; não há baseline "antes das mudanças" nem comparação por teste (SWE-bench `PASS_TO_PASS`).
- **Estado do gate de evolução** (`evolution_scope`, `evolution_violations`, `evolution_violation_rounds`) vive no `checkpoint.json` do runner (`STATE_DIR`) — **corrigido na adversarial: o diretório é um volume compartilhado** (`.runner-state`) legível pela API em `/project-files/.runner-state/<id>/checkpoint.json`. O portal hoje só vê os `project_dialogue` "⛔ Gate de escopo…". `pushEvolutionToGitHub` devolve `prUrl/compareUrl/branch`, mas nada disso é gravado em `extra`.
- **TSK-FULL-TEST NÃO executa a suíte de testes** (corrigido na adversarial): despacha um agente Claude Code (`scripts/full-test-server.py`, 3 fases) e aprova por substring no texto livre — não há saída estruturada por teste.
- Portal: página do projeto tem abas; não existe aba de evolução.

## Itens

| # | Item | Desenho v1 | Aceite |
|---|---|---|---|
| F1 | **DevOps condicional** | Em evolução (`pipeline_ctx.evolution_scope` presente): antes de disparar `call_devops`, calcular `infra_changed = ∃ arquivo tocado pelo Dev ∈ INFRA_PATTERNS` (`Dockerfile*`, `docker-compose*.yml`, `.github/workflows/**`, `infra/**`, `terraform/**`, `k8s/**`, `helm/**`, `*.tf`, `serverless.yml`, `package.json`/`requirements.txt`/`go.mod`/`pyproject.toml` **só se dependências mudaram**, `.env.example`, `infra-deploy.md` da spec). Se **não** mudou → `TSK-DEVOPS-001` marcada `DONE` com evidência "infra inalterada — reaproveitado da versão anterior" (sem chamada LLM); se mudou → fluxo normal. Flag `EVOLUTION_DEVOPS_CONDITIONAL=on`. | evolução que só toca `apps/api/src/**` não chama DevOps; que toca `Dockerfile` chama |
| F2 | **Reconciliação sobre o `apps/` resultante** | `_code_corpus(ctx)`: além de `ctx.artifacts`, ler do disco `PROJECT_FILES_ROOT/<id>/apps/**` (extensões de código, cap 2 MB, skip `node_modules/.git/dist`) — vale para **todo** projeto (não só evolução): o corpus passa a ser o código FINAL. Baseline: em evolução, registrar no `reconciliation.json` `baseline: "parent-apps+delta"`. | evolução com `connect.yaml` herdado não gera `declared_but_missing` para interfaces que já existiam no pai |
| F3 | **PASS_TO_PASS real** | Em evolução: (a) **baseline** — logo após o clone (antes do Dev), rodar a suíte via executor (`run-full-test`) e guardar `evolution_baseline = {passed, failed, ids?}` no checkpoint + `extra`; se a baseline já falha, registrar (não bloquear — legado vermelho é fato, não regressão). (b) **após cada task Dev aprovada pelo QA** (ou só no TSK-FULL-TEST — decisão D-F1), rodar de novo e comparar: testes que passavam e agora falham = **regressão** → `QA_FAIL` da task com a lista (1ª vez) / `blocked_regression` (2ª). Parser por stack: jest `--json`/`vitest --reporter=json`, pytest `-q` + `--junitxml`, go `test -json` — v1 com **contagens + nomes quando disponíveis**. Custo: 1 execução extra por task → limitar por `EVOLUTION_P2P_MODE=final|per-task` (default `final` = só no TSK-FULL-TEST, comparando com a baseline). | baseline registrada; regressão detectada e listada; suíte legada verde mantém verde |
| F4 | **Painel E6 (portal)** | Runner passa a **espelhar o estado do gate na API**: `_patch_project({extra: {evolution_gate: {scope, rounds, violations[-20:], touched_files[], last_update}}})` a cada violação e ao fim; aceite grava `extra.evolution_pr_url/evolution_compare_url/evolution_branch`. Nova aba **"Evolução"** na página do projeto (só se `extra.evolution`): RFC/ADR/CHANGELOG (da `spec-tree` do filho, com link para a Bancada), escopo permitido × arquivos tocados (verde dentro / vermelho descartado), violações por task, baseline × resultado (F3), linhagem (`/versions` com corrente/substituída), PR/branch. | humano vê o porquê de cada corte e o diff antes de aceitar; nenhuma chamada LLM |

## Adversarial do plano (2026-09-04) — fatos corrigidos e GAPs fechados na v2

| # | Achado | Fechamento |
|---|---|---|
| A (P1) | **F3 partia de fato errado**: TSK-FULL-TEST despacha um agente Claude Code (`scripts/full-test-server.py`) e aprova por substring `APROVADO|PASSED|QA_PASS` no texto livre — não existe execução estruturada de suíte | **F3a**: novo endpoint determinístico no executor (`POST /run-tests`: detecta stack por `package.json scripts.test`/`pytest.ini`/`go.mod`, roda com reporter JSON/junit, devolve `{stack, cmd, exit_code, passed, failed, skipped, tests[] {id,status}, no_tests}`), rota B/Lei 8 (Host B, token escopado, tar ≤300 MB); **F3b**: baseline (após clone) + comparação no final (`EVOLUTION_P2P_MODE=final` obrigatório como default; `per-task` opcional); `no-tests` explícito → comportamento atual; flaky: reexecutar 1× só os que falharam |
| B (P1) | `_patch_project({extra})` é ignorado — o PATCH genérico só aceita status/datas/sumários; `PATCH …/extra` é admin-only | F4 **não** grava via PATCH: a API lê o checkpoint read-only (C) e o aceite grava `evolution_pr_url/compare_url/branch` no `extra` pelo próprio serviço |
| C (P1, a favor) | checkpoint É legível pela API: compose mapeia `${HOST_PROJECT_FILES_ROOT}/.runner-state:/orchestrator/state` (runner) e `${HOST_PROJECT_FILES_ROOT}:/project-files` (API) → `/project-files/.runner-state/<id>/checkpoint.json` | `GET /api/projects/:id/evolution-state` projeta só `evolution_scope/violations/violation_rounds/touched_files/baseline` (nunca `artifacts`); confirmar o mesmo mapeamento no compose de PROD antes do deploy |
| D (P1) | "pular DevOps" pularia também artefatos Connect do estágio devops, `start.sh/RUNBOOK`, TSK-FULL-TEST e `pending_cyborg` (mesmo bloco `if True`) | F1 pula **só** `call_devops` e semeia `TSK-DEVOPS-001` DONE com evidência; tudo o mais permanece |
| E (P2) | não há lista de "arquivos tocados pelo Dev"; `git status` só no modo git-clone | acumular `pipeline_ctx.evolution_touched_files` no ponto do gate com os `allowed` (checkpointado); git só cross-check |
| F (P2) | corpus de disco aumenta falso "found" (substring em testes/mocks) | excluir `tests/**`, `*.test.*`, `*.spec.*`, `fixtures/`, minificados; evidência por arquivo no report; em evolução baseline = `reconciliation.json` do pai e só divergências NOVAS; `_pick_project_root`; cap 200 KB/arquivo |
| G (P2) | pai sem testes → nada a comparar | `baseline: "no-tests"` registrado; F3b vira no-op com aviso |
| H (P3) | abas do portal são índices fixos com layout persistido | aba "Evolução" entra nos defaults/layout e só renderiza com `extra.evolution` |
| I (P3) | custo/segurança F3 | código do tenant sempre no executor (Lei 8); `final` default |

## Pesquisa (2026-09-04) — grounding e o que muda

Fontes: SWE-bench (paper + `harness/grading.py`/`log_parsers`: `FULL` só com F2P=1.0 e P2P=1.0; **teste ausente no log = falha**; skip conta como sucesso só em P2P; timeout 1800 s = erro, sem retry de flaky; anti-spoof grava `exit_code=$?` e cruza com o log; SWE-bench Verified), reporters (Jest/Vitest `--json` `fullName`+`testFilePath`; pytest `--junitxml`/`--report-log` `nodeid`, exit 5 = sem testes; `go test -json` evento `skip` sem `Test` = sem testes; Mocha json; .NET trx), skip de deploy (Vercel `ignoreCommand` exit 1 = builda; Netlify inverso; GH Actions `paths`; Nx/Turbo: lockfile invalida tudo; **nenhuma ferramenta tem lista "infra" embutida**), drift de API (oasdiff spec×spec; Schemathesis spec×runtime detecta rota sem handler, não handler sem rota; Optic arquivado).

| Lição | Aplicação |
|---|---|
| Grade por conjunto de IDs; ausente = falha; timeout/crash = erro (nem pass nem fail) | F3b: `regression = baseline.passed_ids − final.passed_ids` (ausente conta como regressão); `exit_code`/timeout → `status: error` sem QA_FAIL |
| Exigir JSON/JUnit + `total>0` + exit code específico | F3a: reporter por stack; `no_tests` explícito (pytest 5, Go skip sem Test, Jest `numTotalTests=0`) |
| ID estável = arquivo + fullName/nodeid | F3a: `tests[].id = "<file>::<fullName>"` |
| Anti-spoof | F3a: executor grava `exit_code` do comando e devolve junto com o parse; runner cruza |
| Convenção explícita de paths de infra; lockfile/root manifests invalidam tudo | F1: `INFRA_PATTERNS` explícita + lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `go.sum`) sempre = infra; `package.json` diff por chave (`dependencies|devDependencies|peerDependencies|engines`) |
| Drift por método+path-template, não substring | F2: manter `_CODE_HINTS` por substring só como sinal de "shape existe"; evidência por arquivo; baseline do pai; extração de rotas fica para v2 |

## Decisões (com recomendação)
- **D-F1** PASS_TO_PASS por task (caro, feedback cedo) × só no final (barato): **recomendado `final` por padrão** com flag para `per-task`.
- **D-F2** Reconciliação lendo o disco vale para todo projeto (recomendado) × só evolução.
- **D-F3** DevOps condicional também para projetos normais quando o Dev não tocou infra? **Não** na v1 (o primeiro deploy sempre precisa de DevOps).

## Riscos a validar na adversarial
- F1: "tocado pelo Dev" — usar os artefatos gravados (`storage.write_apps_artifact`) ou `git status` do `apps/`? Dependências: diff de `package.json` só nas chaves `dependencies/devDependencies`.
- F2: corpus de disco grande → tokens de framework por substring (`_CODE_HINTS`) ficam mais permissivos (falso "found"); cap e só `apps/`.
- F3: executor remoto (Host B) por task = latência/custo; baseline em projeto sem testes → `passed=0` (nada a comparar); saída não determinística (flaky) → exigir 2 falhas consecutivas? nomes de teste por stack.
- F4: `extra` cresce (violations cap 20; touched cap 200); `_patch_project` é PATCH merge de `extra`? (verificar se a rota mescla ou substitui).
