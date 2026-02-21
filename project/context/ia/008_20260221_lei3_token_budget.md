# 008 — LEI 3: Gestão de token budget antes de cada chamada

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 3

## Objetivo

Calcular se system + user message cabem na context window e quanto sobra para output. Alertar se utilização > 60% (warning) ou > 80% (error). Usar `safe_max_tokens` para não exceder o espaço disponível.

## Implementação

1. **runtime.py**
   - `MODEL_LIMITS`: dicionário com `context` e `max_output` para claude-sonnet-4-6, claude-haiku-4-5, etc.; `_DEFAULT_LIMITS` para modelos desconhecidos.
   - `calculate_token_budget(system_msg, user_msg, model)`: estimativa 1 token ≈ 4 caracteres; retorna `system_tokens`, `user_tokens`, `input_total`, `available_for_output`, `safe_max_tokens`, `utilization_pct`. Loga WARNING se `utilization_pct > 60`, ERROR se `> 80`.
   - `run_agent`: dentro do loop de repair, antes de cada `messages.create`, chama `calculate_token_budget(system_content, user_content, model)` e usa `max_tokens = min(env_max, budget["safe_max_tokens"])` em `create_kw`. Log da solicitação inclui `max_tokens` e `utilization_pct`.

2. **Testes**
   - `test_calculate_token_budget_lei3`: estrutura do retorno e utilization_pct para input pequeno.
   - `test_calculate_token_budget_unknown_model_uses_default`: modelo desconhecido usa _DEFAULT_LIMITS.

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | MODEL_LIMITS + calculate_token_budget | Concluído |
| 2 | run_agent: budget antes de cada chamada, max_tokens seguro | Concluído |
| 3 | Testes LEI 3 | Concluído |

## Próximos

- LEI 4: `resilient_json_parse()` com 3 níveis de fallback.
- LEI 5: `invoke_with_retry()` com feedback; nunca reenviar prompt idêntico.
