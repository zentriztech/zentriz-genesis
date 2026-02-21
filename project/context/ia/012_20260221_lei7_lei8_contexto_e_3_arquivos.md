# 012 — LEI 7 (contexto seletivo) e LEI 8 (máx. 3 arquivos por task)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 7, LEI 8

## LEI 7: Contexto seletivo

Cada agente deve receber apenas o que precisa. Para `get_dependency_code`: limite total e, para arquivos muito grandes, apenas interfaces.

### Implementação (pipeline_context.py)
- **MAX_TOTAL_DEPENDENCY_CHARS = 60_000** (~15K tokens).
- **\_extract_interfaces(code)**: extrai linhas com export, import, interface, type, enum, class, function, const, extends, implements, etc.; retorna bloco "// [INTERFACE RESUMIDA — ...]".
- **get_dependency_code**:
  - Se um arquivo excede 20K chars, usa _extract_interfaces em vez de truncar.
  - Acumula total_chars; quando total excederia MAX_TOTAL_DEPENDENCY_CHARS, interrompe e loga warning (LEI 7).

### Testes
- test_pipeline_context_lei7_extract_interfaces_for_large_file
- test_pipeline_context_lei7_caps_total_chars

---

## LEI 8: Máximo 3 arquivos por task

Se uma task produz mais de 3 arquivos, decompor em sub-tarefas.

### Implementação
1. **PM SYSTEM_PROMPT (backend)**: nova regra 3 — "LEI 8 — Regra de decomposição (OBRIGATÓRIA): Cada task deve produzir NO MÁXIMO 3 arquivos..."; numeração 4–6 ajustada.
2. **pipeline_context.py**: **validate_backlog_tasks_max_files(tasks, max_files_per_task=3)** — para cada task com estimated_files ou files_to_create, se len > 3, adiciona issue; retorna lista de mensagens.
3. **runner.py**: no Monitor Loop, após _get_tasks(project_id), chama validate_backlog_tasks_max_files(tasks) e loga warning com as primeiras 5 issues (LEI 8).

### Testes
- test_validate_backlog_tasks_max_files_lei8_ok
- test_validate_backlog_tasks_max_files_lei8_fail

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | LEI 7: _extract_interfaces + cap total em get_dependency_code | Concluído |
| 2 | LEI 8: regra no PM + validate_backlog_tasks_max_files + log no runner | Concluído |
| 3 | Testes LEI 7 e LEI 8 | Concluído |

## Próximos

- LEI 9: TaskStateMachine formal (rework, BLOCKED após 3 falhas).
- LEI 10: log_agent_call completo (tokens, duração, status).
