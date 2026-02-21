# Contexto IA — Continuação das Regras (AGENT_LLM_COMMUNICATION_ANALYSIS)

**Data**: 2026-02-21  
**Referência**: [002_20260221_implementacao_concluida.md](002_20260221_implementacao_concluida.md) e project/docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md

---

## Objetivo desta sessão

Implementar as recomendações pendentes do documento, na ordem de impacto:

1. **Comunicação Permitida + Tabela status + Qualidade do Output** (§3.1, 3.2, 3.3) — em SYSTEM_PROMPT_PROTOCOL_SHARED e/ou por agente
2. **CTO**: Seção Papel/Raciocínio (60/25/15) + Golden example completo (loja de veículos)
3. **Instruções operacionais** por agente (Dev, CTO, PM, QA, Engineer) — §2.7
4. **PipelineContext**: get_dependency_code, completed_artifacts; runner usar build_inputs onde possível
5. **build_dev_user_message** com contexto seletivo (dependency_code, current_task) quando inputs tiverem esses campos

---

## Checklist desta sessão

| # | Item | Status |
|---|------|--------|
| 1 | Criar 003 e manter checklist atualizado | Concluído |
| 2 | SYSTEM_PROMPT_PROTOCOL_SHARED: tabela "Quando usar cada status" + "Qualidade do Output" + thinking/response | Concluído |
| 3 | Por agente: seção "Comunicação Permitida" (CTO, Engineer, PM, Dev, QA, Monitor) | Concluído |
| 4 | CTO: "Seu Papel" / "Como você pensa" + golden example loja veículos | Concluído |
| 5 | Instruções operacionais: Dev, Engineer, PM, QA (seções nos SYSTEM_PROMPT) | Concluído |
| 6 | PipelineContext: get_dependency_code, register_artifact | Concluído |
| 7 | runtime build_user_message: current_task + dependency_code + previous_attempt (Dev) | Concluído |

---

## Arquivos tocados

- project/context/ia/003_20260221_continuacao_regras_llm.md (este)
- applications/contracts/SYSTEM_PROMPT_PROTOCOL_SHARED.md — §7 Quando usar cada status, §8 Qualidade do Output, §1.1 thinking/response
- applications/agents/cto/SYSTEM_PROMPT.md — Comunicação Permitida, Seu Papel e Como Pensar, Golden example loja veículos
- applications/agents/engineer/SYSTEM_PROMPT.md — Comunicação Permitida, Como Analisar a Spec
- applications/agents/pm/backend/SYSTEM_PROMPT.md — Comunicação Permitida, Como Gerar o Backlog
- applications/agents/dev/backend/nodejs/SYSTEM_PROMPT.md — Comunicação Permitida, Instruções Operacionais (implement_task)
- applications/agents/qa/backend/nodejs/SYSTEM_PROMPT.md — Comunicação Permitida, Como Validar
- applications/agents/monitor/backend/SYSTEM_PROMPT.md — Comunicação Permitida
- applications/orchestrator/pipeline_context.py — get_dependency_code(), register_artifact()
- applications/orchestrator/agents/runtime.py — build_user_message: current_task, dependency_code, previous_attempt

## Próximos passos (opcional)

- Runner usar pipeline_ctx.build_inputs_for_cto/engineer/pm ao montar chamadas (substituir construção manual).
- TaskExecutionLoop no Monitor (tarefa por tarefa com depends_on_files).
- Testes Fase 4: CTO spec loja, cadeia CTO→Engineer→CTO, qualidade Dev sem placeholders.

---

*Atualizado em 2026-02-21.*
