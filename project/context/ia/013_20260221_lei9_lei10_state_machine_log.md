# 013 — LEI 9 (TaskStateMachine) e LEI 10 (log_agent_call)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 9, LEI 10

## LEI 9: State machine de tasks

Cada task segue ciclo de vida rígido: PENDING → IN_PROGRESS → IN_REVIEW → DONE | QA_FAIL (rework); após max reworks → BLOCKED.

### Implementação
- **orchestrator/task_state_machine.py**:
  - **VALID_TRANSITIONS**: PENDING/ASSIGNED → IN_PROGRESS; IN_PROGRESS → IN_REVIEW, BLOCKED; IN_REVIEW → DONE, QA_FAIL; QA_FAIL → IN_PROGRESS, BLOCKED; DONE terminal; BLOCKED → PENDING, ASSIGNED.
  - **MAX_REWORK_BEFORE_BLOCKED = 2** (após 3ª falha QA → BLOCKED).
  - **TaskStateMachine(task_id, initial_state)**: transition(new_state, reason) valida transição, grava history, em QA_FAIL incrementa rework_count e, se > 2, define state = BLOCKED; senão state = IN_PROGRESS. can_transition(new_state) para consulta.

### Testes
- **orchestrator/tests/test_task_state_machine.py**: transições válidas (PENDING → IN_PROGRESS → IN_REVIEW → DONE); QA_FAIL rework até BLOCKED; transição inválida rejeitada.

---

## LEI 10: Observabilidade (log estruturado por chamada)

Cada chamada ao Claude deve produzir log que permita reconstruir o que aconteceu.

### Implementação (runtime.py)
- **log_agent_call(agent_name, mode, budget, response, duration_ms, request_id)**:
  - Monta log_entry com event="agent_call", agent, mode, request_id, timestamp, duration_ms, input (system_tokens, user_tokens, total_input_tokens, utilization_pct), output (status, summary[:200], artifact_count, artifact_sizes, has_thinking, evidence_count, questions).
  - logger.info(json.dumps(log_entry, ensure_ascii=False)).
- **run_agent**:
  - t0_run = time.perf_counter() no início; last_thinking = "" no loop.
  - Após extrair thinking, last_thinking = extract_thinking(raw_text) ou "".
  - Nos retornos (sucesso, BLOCKED por enforcer, circuit breaker): out["_thinking"] = bool(last_thinking), duration_ms = (time.perf_counter() - t0_run) * 1000, log_agent_call(agent_name, mode, budget, out, duration_ms, request_id).

### Teste
- **test_log_agent_call_lei10_structured(caplog)**: chama log_agent_call, verifica em caplog que o último record é JSON com event, agent, mode, duration_ms, input, output (status, artifact_count).

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | TaskStateMachine + VALID_TRANSITIONS + testes | Concluído |
| 2 | log_agent_call + integração em run_agent + teste | Concluído |

## Próximos

- LEI 11: save_checkpoint / load_checkpoint no PipelineContext (pipeline resumível).
