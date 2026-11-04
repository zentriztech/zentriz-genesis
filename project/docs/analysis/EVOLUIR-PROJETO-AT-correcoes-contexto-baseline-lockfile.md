> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AT — correções dos defeitos da execução real 4.5b (N-1 a N-7 + TSK-FULL-TEST)

Branch `evo/r1` (worktree `g-r1`), escopo `applications/orchestrator/**` e `scripts/full-test-server.py`. Origem: relatório AS (`EVOLUIR-PROJETO-AS-execucao-real-4-5b.md`). Nada foi reiniciado, nenhum push, `applications/services/api-node` intocado.

## Resumo

| Item | Severidade | Correção | Prova (teste) |
|---|---|---|---|
| N-1 | Alta | Módulo único `context_files.py`: poda `node_modules/.next/dist/build/.venv/__pycache__/coverage…` e lockfiles/binários antes de descer; teto defensivo (`CONTEXT_MAX_TOTAL_BYTES` 1,5 MB, `CONTEXT_MAX_FILES` 3000) que levanta `ContextTooLargeError` com mensagem acionável. Usado no contexto do Dev (`runner.py` ~5061), no contexto do DevOps (~5373), na árvore de arquivos (~2844) e nos `rglob` de contexto do Cyborg v2/v3/zentriz_cyborg | `test_context_files_n1.py` |
| N-2 | Alta (ambiente+código) | `/run-tests` instala e roda numa **cópia gravável** do projeto (`_copy_project_for_tests`, sem `node_modules/.git/.venv*`), apagada no `finally`. `FTS_TESTS_INPLACE=1` restaura o modo antigo | `test_fts_n2_n3_n4_n7.py` (servidor HTTP real, pasta `0555`) |
| N-3 | Alta | (a) `/cyborg-build` escolhe o gerenciador pelo lockfile existente (npm/yarn/pnpm) e **remove lockfile que o build criou**; (b) `run_cyborg_v3` agora fotografa `apps/` antes e audita depois (`snapshot_apps_tree`/`audit_apps_tree_changes`): lockfile novo é removido, lockfile reescrito é restaurado, qualquer arquivo novo/alterado/removido fora de `files_allowed` vira violação persistida em `docs/cyborg/scope_violations.json` e rebaixa `delivered` para `needs_human`. `CYBORG_TREE_GATE=off` desliga | `test_n3_n4_n5_n7_orchestrator.py` (fixture do PR #5) |
| N-4 | Média | Runner: `no_tests` deixa de ser baseline confiável (`_evo_p2p_unmeasured_reason` reprova alto; saída explícita `EVOLUTION_P2P_REQUIRED=0`). FTS: jest/vitest com exit≠0 e 0 testes por suítes quebradas (23 de 23 no Babel) devolve `status=error`, não `no_tests` (`_jest_zero_tests_error`) | idem + `test_aq_correcoes_qa_escopo_baseline.py` (atualizado) |
| N-5 | Baixa | `_evo_baseline_needs_measure`: baseline ausente ou `status=error` é remedida ao retomar (não se apaga mais checkpoint à mão); `ok`/`no_tests` não se repetem | idem |
| N-7 | Baixa | Diagnóstico abaixo; código agora explica o motivo (`_slot_unusable_reason`), no log, no corpo do 502 e no NOT_RUN | idem |
| TSK-FULL-TEST 502 | Média | Mesma causa do N-7; o runner agora registra e publica o motivo real (`_full_test_failure_reason`) em vez de "indisponível" | idem |

## Evidências e causa-raiz

**N-1.** `runner.py:5061` (antes) `_apps_root.rglob("*")` sem poda; `_EVO_SKIP_DIRS` existia só no repo map. Com a baseline passando a instalar dependências em `apps/` (216 MB de `node_modules`), o Dev carregou tudo que tinha < 50 KB. A poda é feita com `os.walk` (nunca lista o conteúdo de `node_modules`). Limitação: o teste do runner é por inspeção do código-fonte (`"_apps_root.rglob(" not in source`) mais o teste comportamental do coletor; o laço do Monitor não é exercitável em unidade. O agravante do lado do `llmGuard.ts` (pausar o dono por uma estimativa isolada) é do `api-node` e **não foi tocado**.

**N-2.** Causa: pasta do projeto criada como root pelo runner; FTS como `ubuntu`. O teste reproduz com `chmod 0555`: com `FTS_TESTS_INPLACE=1` o resultado é `error: npm install falhou`; com o padrão (cópia) é `passed` e a pasta do projeto fica sem `node_modules`/`package-lock.json`. Alternativa documentada (não adotada): `chown`/`umask` no runner, que exige mexer em ownership de volume compartilhado e não evita a poluição do projeto. **Ambiente local:** não é mais necessário `sudo chown`; o servidor do host (porta 7878, em execução) precisa ser **reiniciado por quem opera** para carregar o código novo; a primeira medição de cada run reinstala as dependências (sem cache no projeto; o cache global do npm segue valendo). Testes em Python recriam o venv na cópia.

**N-3.** `scripts/full-test-server.py` (`_handle_cyborg_build`) rodava sempre `pnpm install --no-frozen-lockfile` e o arquivo gerado ia parar no PR. Defesa em duas camadas (produtor e auditor). **Fora deste escopo e pendente (api-node, frente r2):** o publicador (`evolutionAccept`/`publishing`) continua sem filtro próprio de `node_modules`/`dist`/lockfile estranho; as camadas daqui impedem que o arquivo exista em `apps/` na hora da publicação, mas um filtro no publicador é a defesa em profundidade correta. `node_modules`/`dist` gerados pelo build continuam no disco (cache), fora de contexto (N-1) e fora da fotografia do gate; o gate só os trata como artefato, não os apaga.

**N-4/N-5.** Mudança de comportamento intencional: evolução com baseline `no_tests` agora reprova `TSK-FULL-TEST` (`QA_FAIL` com motivo) em vez de seguir. Em projeto sem nenhuma suíte, use `EVOLUTION_P2P_REQUIRED=0` ou adicione a suíte. Ressalva do N-5: se a retomada ocorrer depois de o Dev já ter alterado o código, a remedição mede o código alterado, não a versão original; hoje o bloco só roda na abertura da evolução (antes do CTO), então o caso prático é o reinício precoce.

**N-7 / TSK-FULL-TEST (502).** Evidência (`~/.local/state/genesis-dev/fts.log`, somente leitura, 20:16:55): `[slot] bedrock/us.anthropic.claude-sonnet-5-5 não dirige o executor — pulado` seguido de `POST /run-full-test 502`. Causa-raiz: `_cli_env_from_slot` (`full-test-server.py` ~L295-300) devolve `None` para slot Bedrock sem `aws_access_key_id`/`aws_secret_access_key`; o runner só repassa essas chaves se estiverem no env do processo (`runner.py` `_llm_envelope_do_run`, bloco `_provider == "bedrock"`), e no dev o Bedrock roda por instance role. A LEI dos slots (2026-09-10) proíbe executar na identidade do host, então o 502 é **fail-closed deliberado**, não defeito do CLI. Não foi contornado. Para executar de fato no dev: cadastrar as chaves AWS no slot do tenant (ou exportá-las no env do runner do dev) **ou** usar slot Anthropic/Foundry com chave. O NOT_RUN anterior estava correto; o que faltava era dizer o porquê, agora presente em três pontos. O 502 do `/cyborg-engineer` ("sem GENESIS_API_TOKEN no FTS") é outra causa de ambiente, vista no mesmo log, fora do pedido.

## Contagens (pytest `applications/orchestrator tests/python`, venv `/tmp/pyv`)

| | Falhas | Passam | Puladas |
|---|---|---|---|
| Baseline (worktree antes de editar) | 23 | 1250 | 2 |
| Depois | 23 | 1271 | 2 |

A lista das 23 falhas é **idêntica** (diff vazio; são as de `applications/orchestrator/tests/known-env-failures.txt`: slots de LLM e `zentriz-connect` ausentes). +21 testes novos (4 + 7 + 10) e 1 teste existente atualizado (`test_d4_casos_que_nao_reprovam`, pela nova regra N-4).

## Mutação

Revertendo `full-test-server.py`, `runner.py` e `cyborg_v3.py` ao estado anterior (testes mantidos): 18 falhas nos testes dos itens N-2..N-7 (+ 1 em N-1 pela volta do `rglob`). Mutação comportamental do N-1: trocar a coleta do Dev por `rglob` sem poda faz `test_runner_monta_contexto_do_dev_sem_node_modules` falhar. No N-2, o próprio teste mostra o defeito no modo `FTS_TESTS_INPLACE=1`.

## O que depende de ambiente

- Reiniciar o full-test-server do host para valer N-2/N-3/N-4/N-7 (não feito, conforme instrução); rebuild/restart do runner para N-1/N-3/N-4/N-5.
- N-7: chaves AWS no slot (decisão de política do Jean) para o `TSK-FULL-TEST` executar de verdade.
- N-3 completo: filtro no publicador (api-node, `evo/r2`).
- Variáveis novas: `CONTEXT_MAX_FILE_BYTES`, `CONTEXT_MAX_TOTAL_BYTES`, `CONTEXT_MAX_FILES`, `FTS_TESTS_INPLACE`, `CYBORG_TREE_GATE`.
