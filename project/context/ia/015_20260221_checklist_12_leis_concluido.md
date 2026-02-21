# 015 — Checklist das 12 Leis (concluído)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § 12.2

## Status

As 12 Leis do documento foram implementadas. O checklist em §12.2 do ANALYSIS foi atualizado para [x] com referência aos contextos em `project/context/ia/`.

| LEI | Resumo | Contexto |
|-----|--------|----------|
| 1 | AGENT_TEMPERATURE no runtime | 006 |
| 2 | Regras críticas no início e fim do system prompt | 007 |
| 3 | calculate_token_budget antes de cada chamada; warning >60% | 008 |
| 4 | resilient_json_parse com 3 níveis + regra escaping 3.3 | 009 |
| 5 | build_repair_feedback_block; retry nunca mesmo prompt | 010 |
| 6 | spec_raw em &lt;user_provided_content&gt; + 1.2 anti-injection | 011 |
| 7 | get_dependency_code com MAX_TOTAL e _extract_interfaces | 012 |
| 8 | PM máx. 3 arquivos; validate_backlog_tasks_max_files no runner | 012 |
| 9 | TaskStateMachine (VALID_TRANSITIONS, rework, BLOCKED) | 013 |
| 10 | log_agent_call em run_agent | 013 |
| 11 | save_checkpoint/load_checkpoint; runner integrado | 014 |
| 12 | QA ceticismo no SYSTEM_PROMPT | 006 |

## Pendências opcionais (documento)

- **Seção 11 / Golden examples**: CTO já tem golden example completo (loja de veículos); outros agentes podem ganhar 1 golden example completo cada (input + output real) em futuras iterações.
- **invoke_with_retry** como função nomeada: o comportamento (retry com feedback) está no loop de repair do `run_agent`; extrair para uma função `invoke_with_retry` é opcional.

## Referência

- Checklist atualizado em: `project/docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md` (final do §12.2).
