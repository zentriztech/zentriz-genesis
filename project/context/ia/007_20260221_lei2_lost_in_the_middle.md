# 007 — LEI 2: Regras críticas no início e no fim do system prompt (Lost in the Middle)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 2

## Objetivo

LLMs prestam mais atenção ao **início** e ao **fim** do prompt ("lost in the middle"). As proibições mais importantes devem aparecer **duas vezes** — no início e no fim do system prompt.

## Implementação

1. **Arquivo de regras críticas**  
   - `applications/contracts/SYSTEM_PROMPT_CRITICAL_RULES_LEI2.md`: bloco único com 5 regras (NUNCA abrevie com "...", NUNCA invente, SEMPRE `<response>`, evidence quando OK, sem TODO/placeholders).

2. **Runtime**  
   - `applications/orchestrator/agents/runtime.py`:
     - `CRITICAL_RULES_LEI2_PATH` aponta para o arquivo acima.
     - `_load_critical_rules_lei2()` carrega o conteúdo.
     - `build_system_prompt()`: após montar o `base` (load_system_prompt + templates CTO/PM), **prependa** `## INÍCIO — Regras críticas (LEI 2)` + conteúdo + `---` e **append** `---` + `## LEMBRETES FINAIS (LEI 2 — leia com atenção)` + mesmo conteúdo.
   - Assim, **todos** os agentes que usam `build_system_prompt` passam a ter regras críticas no início e no fim (CTO, Engineer, PM, Dev, QA, Monitor, DevOps).

3. **Teste**  
   - `orchestrator/tests/test_runtime_build_user_message.py`: `test_build_system_prompt_lei2_critical_rules_at_start_and_end` — verifica presença de "INÍCIO — Regras críticas", "LEMBRETES FINAIS" e "NUNCA"/"<response>".

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Criar SYSTEM_PROMPT_CRITICAL_RULES_LEI2.md | Concluído |
| 2 | build_system_prompt: prepend + append regras críticas | Concluído |
| 3 | Teste LEI 2 | Concluído |

## Próximos (documento)

- LEI 3: `calculate_token_budget()` antes de cada chamada; warning se > 60%.
- LEI 4: `resilient_json_parse()` com 3 níveis de fallback.
- LEI 5: `invoke_with_retry()` com feedback; nunca reenviar prompt idêntico.
