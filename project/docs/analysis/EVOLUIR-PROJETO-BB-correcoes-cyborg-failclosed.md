> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-BB — Correções fail-closed do Cyborg e do full-test-server (achados da rodada real 4.5c)

Branch `evo/u1`. Origem: `EVOLUIR-PROJETO-BA-execucoes-reais-4-5c.md` (D-1 a D-5). Sem chamadas reais a LLM.

## O que mudou no comportamento

| # | Defeito (4.5c) | Correção | Onde |
|---|----------------|----------|------|
| 1 | Aceite fail-open: 4 de 5 análises com 402 `REPEAT_PAYLOAD` eram excluídas da média e contadas como "0 BLOCKER" | Análise que não executou (erro/402/vazia) é **inválida**: não entra na média nem na contagem. Aceite exige **mínimo de 4 de 5 válidas** (`CYBORG_AUDIT_MIN_VALID`); abaixo disso `needs_human` com `AUDITORIA INSUFICIENTE: só N/5 válidas… não executaram: <análise (erro)>`. `audit.json` ganha o bloco `validity`. Re-auditoria insuficiente dentro do rework **reverte a rodada**. | `cyborg_v3.py`: `analysis_is_valid`, `audit_validity`, `evaluate_audit_acceptance`, `_run_cyborg_v3_impl`, `autonomous_rework` |
| 1b | Reenvio idêntico (REPEAT_PAYLOAD): `repeat_max_per_6h=4` no Guard (`llmGuard.ts:415`), hash = modelo+system+user (`agents/llm_guard.py:85`). Após reverter uma rodada a árvore voltava ao mesmo hash e as 5 análises eram reenviadas iguais | Cache em memória do **veredito válido** por (projeto, análise, modelo, prompt, contexto): mesma pergunta ⇒ reaproveita a resposta, não paga nem reenvia. Só vereditos válidos são guardados; um 402 continua 402 e a análise continua inválida. **O Guard não foi tocado nem contornado**; nenhum "ruído" é injetado no payload. | `cyborg_v3.py`: `_AUDIT_CACHE`, `run_prior_audit._one` |
| 2 | `/cyborg-build` sem `node_modules` devolvia `build_rc=0` (`nest: not found`) | O `| tail` mascarava o exit code (rc do `tail`); comandos sem pipe, recorte em Python. Roda em **cópia gravável** (como `/run-tests`). Install falho/timeout ⇒ build não roda, `build_rc` = rc do install (124 no timeout). `not found` na saída com rc 0 ⇒ 127. Install "ok" sem `node_modules` em projeto com dependências ⇒ 127. `tsc` ausente em projeto com `tsconfig` ⇒ `type_check_rc≠0`. `-1` só significa "não aplicável". Fallback local do Cyborg propaga o mesmo. | `full-test-server.py`: `_cyborg_build_core`, `_pick_node_pm`; `cyborg_v3.py` (fallback local) |
| 3 | `/run-full-test` aprovava por substring ("PASSED", "APPROVED"…) mesmo com relatório "bloqueado" | Aprovação **só** pela linha inteira `FULL_TEST_VERDICT: APPROVED` (a última vale) **e** rc 0. O prompt do CLI agora exige essa linha. Resposta traz `verdict` com o motivo. Chamadores com `prompt_path` próprio recebem o contrato anexado ao prompt. | `full-test-server.py`: `parse_full_test_verdict` |
| 4 | `/run-full-test` rodava no diretório do projeto (root) ⇒ EACCES | Roda numa **cópia gravável** (`_prepare_full_test_workdir`, mesmo `_copy_project_for_tests` do N-2). Resposta ganha `workdir`, `changed_files` (diferenças vs. original) e o `QA_REPORT_TSK-FULL-TEST.md` é copiado de volta ao original quando gravável (senão vai em `qa_report_text`). **As correções do CLI NÃO são reaplicadas ao original** (ver limitações). | `full-test-server.py`: `_handle_run_full_test` |
| 5 | Rodadas de correção reescreveram o construtor do `CircuitBreaker` (TS2554) sem gate | **Gate de integridade por rodada**, antes de aceitar a alteração e antes de pagar a re-auditoria: (a) gate de árvore/escopo (`audit_apps_tree_changes`), (b) build + `tsc --noEmit` pelo executor, comparados ao estado anterior (baseline medida no início e atualizada a cada rodada aceita). Piorou build/tipos, mais erros TS, ou build/tipos **não verificáveis** (tsc indisponível, executor caído, build rc -1) ⇒ rodada **revertida**, registrada em `gate_reverts` e no diálogo; a causa vai no prompt da rodada seguinte (a Dev sabe o que não repetir). Projeto sem `apps/package.json` não tem o que construir ⇒ passa. | `cyborg_v3.py`: `round_integrity_gate`, `summarize_build_check`, `evaluate_round_gate`, `_revert_snapshot`, `autonomous_rework` |

## Variáveis de ambiente

| Variável | Padrão | Efeito |
|----------|--------|--------|
| `CYBORG_AUDIT_MIN_VALID` | `4` | Mínimo de análises válidas (de 5) para aceitar por auditoria. Piso 1. |
| `CYBORG_ROUND_GATE` | `on` | `off` desliga o gate de integridade por rodada (volta ao legado). |
| `FTS_BUILD_INPLACE` | `0` | `1` faz o `/cyborg-build` rodar no diretório do projeto (antigo). |
| `FTS_BUILD_INSTALL_TIMEOUT` | `600` | Timeout (s) do install do `/cyborg-build` (antes fixo em 180). |
| `FTS_TESTS_INPLACE` | `0` | Já existia para `/run-tests`; agora também faz o `/run-full-test` rodar no diretório do projeto. |

## Efeitos colaterais a saber

- Com o gate ligado, a **janela de recuperação de build (#53)** e o acúmulo transitório do **modo feature (#50-bis)** deixam de se aplicar a rodadas que quebram build/tipos: build/tipos quebrados nunca são mantidos (o build já era gate inviolável #38 na aceitação). Para o comportamento anterior: `CYBORG_ROUND_GATE=off`.
- O `/cyborg-build` agora reinstala dependências a cada chamada (cópia sem `node_modules`); usa `--prefer-offline`.
- Dicionários de auditoria com chaves fora do padrão `a1…a5` (fixtures) usam o próprio tamanho como total.

## Testes

- `applications/orchestrator/tests/test_cyborg_failclosed_4_5c.py` (13): D-1 e D-5.
- `scripts/tests/test_fts_4_5c_build_verdict_workdir.py` (20): D-2, D-3, D-4 (handler HTTP real com CLI falso e pasta `0555`).
- Baseline (worktree limpo): `applications/orchestrator` 23 falhas / 1344 passam; `scripts/tests` 31 passam.
- Depois: `applications/orchestrator` **23 falhas (lista idêntica, `diff` vazio) / 1357 passam**; `scripts/tests` **51 passam**.
- As 23 falhas são de ambiente (`test_connect_contracts`, `test_prompt_census_invoke_raw_gap146`, `test_spec_dossier_downstream`, `test_spec_validator`, `test_thinking_arm_gap144`, `test_workbench_llm_config`).

## Mutação (cada teste novo falha sem a correção)

13 mutações aplicadas uma a uma e revertidas; todas derrubaram pelo menos 1 teste: cache de veredito (1), mínimo de válidas (3), re-auditoria insuficiente no rework (1), gate desligado (2), tsc indisponível fail-closed (3), regressão de build (1), install falho propaga rc (1), `not found` com rc 0 (1), `node_modules` ausente (1), pipe `| tail` (1), cópia gravável do build (1), veredito por substring (9), full-test na cópia (1).

## Limitações / não feito

- O Guard (`REPEAT_PAYLOAD`) é soberano e não foi alterado. O cache evita só o reenvio idêntico legítimo na mesma instância do orchestrator; ele é **em memória** (reinício do processo ou outro worker reenvia). Contexto com saída de build com timestamps variáveis não casa o cache.
- `/run-full-test` na cópia: correções que o CLI fizer não voltam automaticamente ao projeto original (ele é de root e não deve ser poluído); ficam listadas em `changed_files`. Aplicá-las ao original é decisão do chamador (decisão pendente do Jean se isso deve virar sincronização opt-in).
- Não validado contra o runner real nem com `npm install` de rede (testes usam comandos de install falsos); o servidor de testes em execução (7878) não foi reiniciado, então o código novo só vale após o deploy dele.
- O gate por rodada usa o `/cyborg-build` (install+build+tsc) uma vez por rodada além da auditoria; custo de tempo maior por rodada.
