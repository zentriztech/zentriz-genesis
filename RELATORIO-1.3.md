> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório da tarefa 1.3 — ledger por papel (transversal)

Branch `evo/p1-13` (repositório zentriz-genesis, worktree `.worktrees/g-13`), derivada de `53f7c1b` (tarefas 1.1/1.2). Sem push, sem deploy, sem acesso a produção, `docker-compose*` intocado.

Commits:
- `70ab1ed` — api-node: migration 135, `LLM_ROLES_MODE`, `recordCall`, rota de métricas, testes vitest.
- `7ab367f` — orquestrador Python: helper da flag, propagação do papel, testes pytest, consulta SQL.

## 1. O que mudou

### api-node (`applications/services/api-node/src`)
- `db/migrations/135_llm_role_ledger.sql`: 134 era a última. Colunas nullable `llm_role`, `effective_role`, `escalated_from` em `llm_call_ledger`; `llm_role` em `project_agent_metrics`; índice `idx_llm_ledger_role`. Sem backfill, sem CHECK, sem `DO $$`, sem `;` em literais ou comentários (verificado por grep). Nomes de tabela e colunas confirmados na migration 131 (`llm_call_ledger`) e na 003 (`project_agent_metrics`).
- `lib/llmRoles.ts` (novo): helper único da flag `llmRolesMode()` (off|shadow|on, padrão off; valor inválido vira off) e `normalizeLlmRole()` (papel desconhecido vira NULL).
- `services/llmGuard.ts`: `RecordInput` ganha `llmRole`, `effectiveRole`, `escalatedFrom`. Em `recordCall`, com `off` o INSERT e os 15 parâmetros são os mesmos de antes, byte a byte. Com `shadow` ou `on`, usa INSERT com 18 parâmetros; `effective_role` cai em `llm_role` se vier vazio.
- `routes/projects.ts` (rota `POST /api/projects/:id/agent-metrics`): mesmo desenho. Ramo `off` usa o SQL antigo literal; ramo `shadow` ou `on` grava `llm_role`.
- `routes/llmGuard.ts` não precisou mudar: já repassa o corpo (`...body`) a `recordCall`. O preflight ignora os campos novos.

### Orquestrador Python (`applications/orchestrator`)
- `agents/llm_guard.py`: `roles_mode()`, `normalize_role()` e `role_kwargs(escalated, staff)`. Este último devolve `{}` com a flag off, então os chamadores não passam argumento novo algum. `check()` ganha `llm_role` e `escalated_from` e só põe `llmRole`, `effectiveRole` e `escalatedFrom` no contexto se a flag não for off e o papel for válido. `record()` já espalha o contexto, então não precisou mudar.
- `agents/runtime.py`:
  - `_stamp_role` marca `_llm_role` na resposta (só com a flag ligada).
  - Caminho Anthropic/Bedrock/Foundry de `run_agent`: `_role_escalated` vira True só quando o modelo de rework (`model_rework` ou `CLAUDE_MODEL_REWORK`) substitui de fato o principal, e então a chamada é advisor.
  - Caminho OpenAI/Azure/Gemini: orchestrator.
  - `call_bedrock_direct` aceita `llm_role` e `escalated_from` e só os repassa ao `check` se vierem preenchidos.
- `agents/server.py`: `splitter` e `spec_split` viram orchestrator. `/invoke/raw`: o modelo principal do slot vira orchestrator, e o fallback do slot (`_fb`) vira advisor com `escalated_from=orchestrator`.
- `cyborg_v3.py`: a sessão do engenheiro vira advisor com `escalated_from=orchestrator`. Decisão de interpretação: o Cyborg só roda depois de o pipeline falhar e usa o modelo mais forte do slot (`strategy=strongest`), então foi tratado como escalada, como pedido no enunciado.
- `runner.py`: `_record_agent_metrics` só inclui `llmRole` com a flag ligada. As 3 chamadas de LLM cruas (`runner:backend_language`, `runner:module`, `runner:autonomous_monitor`) viram orchestrator.

## 2. Pontos de chamada

### Cobertos
| Ponto | Papel em shadow |
|---|---|
| `runtime.py` `run_agent` (Anthropic/Bedrock/Foundry/Vertex) | orchestrator; advisor se houve troca por rework |
| `runtime.py` `_run_agent_openai` | orchestrator |
| `runtime.py` `call_bedrock_direct` (via `server.py`: `splitter`, `spec_split`, `/invoke/raw` principal e fallback) | orchestrator / advisor |
| `cyborg_v3.py` (`engineer_session`) | advisor |
| `runner.py` (3 chamadas cruas) | orchestrator |
| `runner.py` `_record_agent_metrics` e `POST /agent-metrics` | `llm_role` |
| api-node `recordCall` (rota `/api/internal/llm-guard/record`) | grava as 3 colunas |

### NÃO cobertos (ficam com papel NULL = "não medido")
- `call_bedrock_direct` em `spec_validator.py` (inclui a triagem `SPEC_VALIDATOR_TRIAGE_MODEL`, que é env-configurável e não é Haiku inequívoco, então não foi marcada `staff`), `lesson_extractor.py` e `probe_slot` (sonda de slot, não é trabalho de produção).
- `server.py`: os dois blocos `except` de `/invoke/raw` seguem como estavam. Servem só de plumbing.
- `runtime._report_direct_usage` (métricas das chamadas diretas): não leva `llmRole`. O ledger cobre essas chamadas quando o chamador passa o papel.
- Os outros 4 INSERTs em `project_agent_metrics` no api-node (`products.ts`, `productNormalizer.ts`, `specChatJobs.ts`, `promotionPlanner.ts`): não escrevem `llm_role`.
- Deadpool: não vive neste repositório (nenhuma referência ao Guard aqui). O corpo do `/record` já aceitaria os campos, mas o cliente do Deadpool precisa ser alterado no repositório dele.
- api-node não faz chamada de LLM própria (só `checkProjectBudgetGate`, que é gate de orçamento, sem papel): `runnerDispatch.ts`, `watchdog.ts`, `specAutonomy.ts`, `specJudgeRecall.ts`, `pipeline.ts`. Nada a propagar ali.
- Staff nunca é gravado (ainda não existe). `role_kwargs(staff=True)` existe mas nenhum chamador o usa.
- Rebaixa de modelo por indisponibilidade na conta (`CLAUDE_MODEL_FALLBACK`): é contingência do mesmo papel e não foi tratada como escalada. A chamada fica com o papel do pedido. Em shadow, `llm_role` e `effective_role` são iguais por construção.

Convenção de `escalated_from`: é o papel de origem (`orchestrator`), não o modelo. O modelo já está em `llm_call_ledger.model`.

## 3. Resposta ao item (d) — `prompt_hash` inclui o modelo?
Sim. `llm_guard.prompt_hash(model, system, user)` faz SHA-256 de `model \0 system \0 user` (`agents/llm_guard.py`, função `prompt_hash`). Nada foi alterado. Efeito colateral: o mesmo prompt em modelos diferentes (orchestrator e advisor) tem hash diferente, então a escalada não dispara o disjuntor de payload repetido.

## 4. Consulta de custo por papel x agente x semana
`applications/services/api-node/scripts/sql/custo_por_papel_agente_semana.sql`. Agrupa `llm_call_ledger` por semana, `COALESCE(effective_role, llm_role, 'nao_medido')` e prefixo de `purpose` (agente), com chamadas, escaladas, tokens, USD e % da semana. Não foi executada contra um Postgres real (não há banco neste ambiente): só revisada, validada pela leitura do esquema.

## 5. Testes
- Antes (vitest, base, comando `npx vitest run` em `applications/services/api-node`): `Test Files 183 passed (183)`, `Tests 3312 passed | 1 skipped (3313)`. A rodada coincidiu com o início das minhas edições, então o número é aproximado (o enunciado dizia 3310).
- Depois (mesmo comando): `Test Files 184 passed (184)`, `Tests 3321 passed | 1 skipped (3322)` (+9 testes novos).
- Novo `src/services/llmGuard.roles.test.ts` (9 testes): flag, snapshot literal do SQL legado em `off` (SQL e 15 parâmetros), `shadow` grava as 3 colunas, `effective_role` cai no `llm_role`, papel ausente ou inválido vira NULL sem quebrar, custo inalterado pelo papel, preflight negado idêntico em off e shadow e sem ledger, e o ramo `off` de `/agent-metrics` preservado literalmente.
- `npx tsc --noEmit -p .`: sem erros.
- Pytest com `/home/ubuntu/.venvs/genesis-py/bin/python -m pytest applications/orchestrator -q`: `23 failed, 899 passed, 2 skipped`. As 23 falhas são as conhecidas de ambiente (`test_spec_validator`, `test_prompt_census_invoke_raw_gap146`, `test_thinking_arm_gap144`, `test_connect_contracts`, `test_spec_dossier_downstream`, `test_workbench_llm_config`), nenhuma em arquivo tocado. Não rodei a base de novo com pytest, só comparei com o número conhecido (23).
- Novo `orchestrator/tests/test_llm_roles.py`: 11 testes passam (`11 passed`). Cobrem a flag, o snapshot de chaves do preflight/record em `off` mesmo com papel pedido, orchestrator em shadow, escalada com `escalatedFrom`, papel ausente ou inválido sem quebrar, negativa do guard sem record e sem mudar papel, `run_agent` com `rework_attempt` 0 (modelo principal, orchestrator) e 1 (`claude-opus-4-8`, advisor; os modelos usados são os mesmos de antes), e `_record_agent_metrics` sem `llmRole` em off.

## 6. Estado
- Preparado e criado: migration 135 (não aplicada em nenhum banco), flag, propagação, testes e consulta.
- Validado: por testes unitários e de contrato descritos acima. Não houve execução de ponta a ponta contra Postgres nem contra a api real.
- Funcional: ainda não. Com `LLM_ROLES_MODE=off` (padrão) o comportamento é idêntico ao anterior. Para produzir a base do G0.5/G1 é preciso: aplicar a migration (boot da api), ligar `LLM_ROLES_MODE=shadow` na api e no orquestrador (a flag é lida do ambiente, global; "por tenant" fica para depois), e a flag precisa estar nos DOIS lados, senão a api descarta o papel.

## 7. Riscos
1. A migration roda no boot da api; as colunas são nullable e aditivas, mas `ALTER TABLE ... ADD COLUMN` em `llm_call_ledger` grande tem lock curto. Rollback por flag, não por migration.
2. Flag só de um lado: orquestrador em shadow e api em off descarta o papel (sem erro); api em shadow e orquestrador em off grava NULL. Ligar nos dois.
3. Os 3 `runner:*` classificadores pequenos aparecem como orchestrator em shadow, embora o doc 06 possa classificá-los como staff futuramente. Isso reflete o comportamento atual (modelo principal), como pedido, mas infla o custo "orchestrator" até a Fase 2A.
4. O Cyborg como advisor é uma interpretação (ver seção 1), pois ele usa o primário do slot mais forte e não o `model_rework`.
5. A base de custo por papel terá lacunas até cobrir `spec_validator`, `lesson_extractor` e o Deadpool.
