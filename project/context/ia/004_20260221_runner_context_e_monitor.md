# Contexto IA — Runner com PipelineContext e Monitor (continuação)

**Data**: 2026-02-21  
**Referência**: [003_20260221_continuacao_regras_llm.md](003_20260221_continuacao_regras_llm.md), AGENT_LLM_COMMUNICATION_ANALYSIS.md

---

## Objetivo

1. Runner usar `pipeline_ctx.build_inputs_*` em call_cto, call_engineer, call_pm quando `pipeline_ctx` estiver disponível.
2. Monitor Loop: receber `pipeline_ctx`; após QA_PASS registrar artefatos no contexto; ao acionar Dev, passar `current_task` e `dependency_code` (contexto seletivo).
3. Testes Fase 4: pelo menos um teste de integração/parse e validação de qualidade.

---

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Criar 004 | Concluído |
| 2 | call_cto/call_engineer/call_pm: parâmetro opcional pipeline_ctx; usar build_inputs quando presente | Concluído |
| 3 | _run_monitor_loop: parâmetro pipeline_ctx; registrar artefatos após QA_PASS; call_dev com current_task + dependency_code | Concluído |
| 4 | call_dev: aceitar task_dict, dependency_code, pipeline_ctx para montar inputs Dev | Concluído |
| 5 | Teste: build_user_message com current_task/dependency_code e previous_attempt | Concluído |

---

## Alterações feitas

- **call_cto**: parâmetro `pipeline_ctx`; quando presente, inputs = `pipeline_ctx.build_inputs_for_cto(mode, backlog_summary, validate_backlog_only)` + overrides.
- **call_engineer**: parâmetro `pipeline_ctx`; quando presente, inputs = `pipeline_ctx.build_inputs_for_engineer(cto_questionamentos)`.
- **call_pm**: parâmetro `pipeline_ctx`; quando presente, `current_module` atualizado e inputs = `pipeline_ctx.build_inputs_for_pm(cto_questionamentos)`.
- **call_dev**: parâmetros `task_dict`, `dependency_code`, `pipeline_ctx`; inputs passam a incluir `current_task`, `dependency_code` e `completed_summary` quando fornecidos.
- **_run_monitor_loop**: parâmetro `pipeline_ctx`; após QA_PASS, artefatos do Dev registrados em `pipeline_ctx.register_artifact()`; na chamada a call_dev, `dep_code = pipeline_ctx.get_dependency_code(depends_on_files)`, `task_dict=dev_task`, `existing_artifacts=last_dev_artifacts` em rework (QA_FAIL).
- **Testes**: `orchestrator/tests/test_runtime_build_user_message.py` — build_user_message com current_task + dependency_code e com previous_attempt.

---

*Atualizado em 2026-02-21.*
