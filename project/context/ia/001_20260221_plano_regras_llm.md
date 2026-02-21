# Contexto IA — Implementação das Novas Regras (AGENT_LLM_COMMUNICATION_ANALYSIS)

**Data**: 2026-02-21  
**Fonte**: project/docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md (Claude Opus)  
**Objetivo**: Implementar na íntegra as regras para corrigir a comunicação agente→LLM.

---

## Prioridades (P0 primeiro)

| # | Item | Onde | Status |
|---|------|------|--------|
| 1 | JSON-only mata raciocínio → thinking + response tags | envelope.py, runtime, SYSTEM_PROMPTs | Em execução |
| 2 | Context window completo → build_user_message | runtime.py | Em execução |
| 3 | System prompts = 60% papel/raciocínio, 25% exemplos, 15% formato | SYSTEM_PROMPT por agente | Pendente |
| 4 | Golden examples reais | SYSTEM_PROMPT | Pendente |
| 5 | Templates injetados (PRODUCT_SPEC, backlog) | runtime build_system_prompt | Em execução |
| 6 | Cadeia de contexto (PipelineContext) | runner + pipeline_context.py | Em execução |
| 7 | Instruções operacionais por agente | skills.md / SYSTEM_PROMPT | Pendente |

---

## Checklist de implementação

### Fase 1 — Runtime e parse
- [x] envelope.py: extrair JSON de `<response>...</response>` em extract_json_from_text
- [ ] runtime.py: build_user_message(envelope) — contexto estruturado (Tarefa, Modo, Spec, inputs, artefatos, limites)
- [ ] runtime.py: build_system_prompt(path, role, mode) — injetar PRODUCT_SPEC_TEMPLATE (CTO), backlog template (PM)
- [ ] runtime.py: usar build_user_message no lugar do JSON bruto; usar build_system_prompt
- [ ] runtime.py: max_tokens generoso (16000)
- [ ] pipeline_context.py: classe PipelineContext; runner usar para montar inputs

### Fase 2 — System prompts
- [ ] CTO: remover "Output ONLY valid JSON"; adicionar "Think in <thinking>, output in <response>"; 60/25/15
- [ ] Engineer, PM, Dev, QA, Monitor: mesmo padrão + comunicação permitida + tabela status

### Fase 3 — Validação e retry
- [ ] validate_response(agent, response) no runner (artefatos não vazios, sem "...", sem "// TODO")
- [ ] Retry com feedback quando validate_response falhar

### Fase 4 — Testes
- [ ] Teste parse <response> em test_envelope.py
- [ ] Smoke: CTO spec_intake com user message estruturado

---

## Arquivos tocados

- `applications/orchestrator/envelope.py` — extract_json_from_text: prioridade `<response>`
- `applications/orchestrator/agents/runtime.py` — build_user_message, build_system_prompt, uso
- `applications/orchestrator/pipeline_context.py` — novo
- `applications/orchestrator/runner.py` — PipelineContext, validate_response, retry
- `applications/agents/*/SYSTEM_PROMPT.md` — comportamentos thinking/response, proporção 60/25/15

---

*Atualizado conforme progresso.*
