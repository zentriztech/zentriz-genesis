# Contexto IA — PM depends_on_files e consistência (próximo passo)

**Data**: 2026-02-21  
**Referência**: [004_20260221_runner_context_e_monitor.md](004_20260221_runner_context_e_monitor.md), AGENT_LLM_COMMUNICATION_ANALYSIS.md §9.7

---

## Objetivo

1. **PM**: Instrução explícita e obrigatória para gerar `depends_on_files` por task no backlog (o Dev recebe contexto seletivo via `get_dependency_code(depends_on_files)`).
2. **Teste**: PipelineContext `get_dependency_code` e `register_artifact`.
3. **Monitor**: Menção a contexto seletivo e `depends_on_files` no prompt (orquestração tarefa-a-tarefa).

---

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Criar 005 | Concluído |
| 2 | PM: depends_on_files obrigatório por task; formato e exemplo no SYSTEM_PROMPT | Concluído |
| 3 | Teste pipeline_context: get_dependency_code, register_artifact | Concluído |
| 4 | Monitor: seção ou gate sobre depends_on_files / contexto seletivo | Concluído |

---

## Alterações

- **PM (backend)**: Em "Como gerar o backlog", depends_on_files obrigatório por task; primeira task `[]`; formato sugerido (path relativo). Em MODE SPECS generate_backlog, gate: every task MUST have depends_on_files.
- **Monitor (backend)**: Bloco "Contexto seletivo (tarefa-a-tarefa)": runner envia ao Dev só código de depends_on_files; backlog deve ter depends_on_files; se faltar, escalar PM/CTO.
- **Testes**: `orchestrator/tests/test_pipeline_context.py` — register_artifact + completed_tasks; get_dependency_code retorna só solicitados; truncamento por max_per_file; path ausente omitido.

---

*Atualizado em 2026-02-21.*
