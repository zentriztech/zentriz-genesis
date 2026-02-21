# Contexto IA — Implementação Concluída (Regras AGENT_LLM_COMMUNICATION_ANALYSIS)

**Data**: 2026-02-21  
**Referência**: [001_20260221_plano_regras_llm.md](001_20260221_plano_regras_llm.md) e project/docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md

---

## Resumo do que foi feito

### 1. Parse e raciocínio (thinking/response)
- **envelope.py**: `extract_json_from_text()` passa a priorizar conteúdo dentro de `<response>...</response>`; dentro do bloco aceita ```json, ``` ou JSON bruto. Permite que a LLM raciocine em `<thinking>` antes do JSON.
- **Teste**: `test_parse_response_extracts_json_from_response_tags` em test_envelope.py.

### 2. Context window completo (build_user_message)
- **runtime.py**: `build_user_message(message)` monta a mensagem do usuário com seções claras: Tarefa, Modo, Spec do Projeto, Product Spec, Proposta Engineer, Charter, Backlog, Artefatos Existentes, Restrições, Limites, Instrução (thinking + response). O runtime usa essa mensagem em vez do JSON bruto do envelope.

### 3. Injeção de templates (build_system_prompt)
- **runtime.py**: `build_system_prompt(path, role, mode)` carrega o SYSTEM_PROMPT base e injeta:
  - **CTO**: conteúdo de PRODUCT_SPEC_TEMPLATE (project/spec/PRODUCT_SPEC_TEMPLATE.md).
  - **PM** (modo generate_backlog): template de backlog se existir em contracts (pm_backlog_template.md ou BACKLOG_TEMPLATE.md).
- `_load_product_spec_template()` procura o template em repo root e applications.

### 4. PipelineContext (cadeia de contexto)
- **pipeline_context.py** (novo): classe `PipelineContext(project_id)` com setters para spec_raw, product_spec, engineer_proposal, charter, backlog e métodos `build_inputs_for_cto()`, `build_inputs_for_engineer()`, `build_inputs_for_pm()`, `build_inputs_for_dev()`, `get_relevant_artifacts_for_task()`.
- **runner.py**: no início do fluxo V2 cria `pipeline_ctx = PipelineContext(project_id)`; atualiza após cada etapa (set_product_spec após CTO spec, set_engineer_proposal após Engineer, set_charter após Charter, set_backlog após PM). Contexto fica disponível para futura troca dos call_* para usar ctx.build_inputs_for_*.

### 5. System prompts (thinking + response)
- **Todos os SYSTEM_PROMPT** (CTO, Engineer, PM backend/mobile/web, Dev backend/nodejs, web, mobile, QA backend/nodejs/lambdas, web, mobile, Monitor backend/web/mobile, DevOps docker/aws/azure/gcp):  
  - Substituído "Output ONLY valid JSON ResponseEnvelope" por: "Think step-by-step inside <thinking> tags...", "After reasoning, output valid JSON ResponseEnvelope inside <response> tags", "The JSON must be parseable...".  
  - Substituído "No text outside JSON ResponseEnvelope" por: "Output JSON inside <response>...</response> (thinking in <thinking>...</thinking> is encouraged)".

### 6. Validação de qualidade e retry
- **envelope.py**: `validate_response_quality(agent, response)` — verifica artefatos com conteúdo muito curto (<100 chars quando status=OK), reticências/"[...]", "// TODO"; status=OK sem evidence e summary muito curto. Retorna (ok, list_of_errors).
- **runtime.py**: após parse e gates, chama `validate_response_quality(role, out)`; se falhar, trata como all_errors e entra no fluxo de repair (repair_attempt), que reenvia com mensagem de correção.
- **runner.py**: `_validate_response_quality` delega para envelope.validate_response_quality (para uso futuro em logging ou decisões).

### 7. Outros ajustes
- **runtime.py**: `max_tokens` configurável via `CLAUDE_MAX_TOKENS` (default 16000).
- **runtime.py**: usa `message.get("inputs") or message.get("input")` para compatibilidade.

---

## Arquivos modificados/criados

| Arquivo | Alteração |
|---------|-----------|
| project/context/ia/001_20260221_plano_regras_llm.md | Criado — plano e checklist |
| project/context/ia/002_20260221_implementacao_concluida.md | Criado — este resumo |
| applications/orchestrator/envelope.py | extract_json_from_text (<response>), validate_response_quality |
| applications/orchestrator/agents/runtime.py | build_user_message, build_system_prompt, uso no run_agent, validação qualidade, max_tokens |
| applications/orchestrator/pipeline_context.py | Novo — PipelineContext |
| applications/orchestrator/runner.py | PipelineContext no fluxo V2, _validate_response_quality |
| applications/orchestrator/tests/test_envelope.py | test_parse_response_extracts_json_from_response_tags |
| applications/agents/cto/SYSTEM_PROMPT.md | behaviors e quality_gates (thinking/response) |
| applications/agents/engineer/SYSTEM_PROMPT.md | idem |
| applications/agents/pm/backend/SYSTEM_PROMPT.md | idem |
| applications/agents/pm/mobile/SYSTEM_PROMPT.md | idem |
| applications/agents/pm/web/SYSTEM_PROMPT.md | idem |
| applications/agents/dev/*/SYSTEM_PROMPT.md | idem (backend/nodejs, web, mobile) |
| applications/agents/qa/*/SYSTEM_PROMPT.md | idem |
| applications/agents/monitor/*/SYSTEM_PROMPT.md | idem |
| applications/agents/devops/*/SYSTEM_PROMPT.md | idem |

---

## Próximos passos (opcionais, do documento de análise)

- Golden examples completos (1 exemplo real por agente) nos SYSTEM_PROMPT.
- Proporção 60% papel/raciocínio, 25% exemplos, 15% formato nos prompts (reestruturação mais profunda).
- Uso explícito de `pipeline_ctx.build_inputs_for_cto()` etc. nas chamadas do runner (substituir construção manual de inputs).
- Tabela “Quando usar cada status” nos SYSTEM_PROMPT.
- Seção “Comunicação permitida” por agente.

---

*Implementação feita em 2026-02-21. Testes test_envelope: 16 passed.*
