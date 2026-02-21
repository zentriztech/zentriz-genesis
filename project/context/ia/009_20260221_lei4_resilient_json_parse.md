# 009 — LEI 4: Parse JSON resiliente (escaping em artifacts)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 4

## Objetivo

Evitar JSONDecodeError quando o Dev (ou outros) geram código dentro de `artifacts[].content` com aspas/barras não escapadas. Duas frentes: instruir o modelo (Solução A) e parse resiliente no runtime (Solução B).

## Implementação

### Solução A — Instrução ao modelo
- **contracts/SYSTEM_PROMPT_PROTOCOL_SHARED.md**: nova subseção **3.3 JSON escaping in artifacts (LEI 4)** com regras: `"` → `\"`, newline → `\n`, `\` → `\\`, tab → `\t`, e aviso de que aspas não escapadas quebram a resposta.

### Solução B — Parse resiliente (envelope.py)
- **`_extract_double_quoted(s, start)`**: extrai string entre aspas duplas a partir de `start`, respeitando `\\` e `\"`.
- **`resilient_json_parse(raw_text, request_id)`**:
  - Obtém `json_str` via `extract_json_from_text(raw_text)` (ou raw).
  - **Tentativa 1**: `json.loads(json_str)`; sucesso → retorna `(data, [])`.
  - **Tentativa 2**: localiza `"content": "` no texto; para cada ocorrência extrai o valor com `_extract_double_quoted`, substitui por `"@@PLACEHOLDER_i@@"`, faz `json.loads(cleaned)` e reinjeta os blocos em `artifacts[].content`.
  - **Tentativa 3**: retorna envelope `FAIL` com resumo “JSON inválido — provável problema de escaping” e `next_actions` sugerindo retry com instrução de escaping.
- **`parse_response_envelope`**: passa a usar `resilient_json_parse(raw_text, request_id)` em vez de `extract_json_from_text` + `json.loads`; concatena `parse_errors` com erros de validação.

### Testes (test_envelope.py)
- `test_extract_double_quoted_simple`, `test_extract_double_quoted_with_escapes`
- `test_resilient_json_parse_tentativa1_direct`, `test_resilient_json_parse_with_content_escaped`, `test_resilient_json_parse_tentativa3_fallback`

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | _extract_double_quoted + resilient_json_parse (3 níveis) | Concluído |
| 2 | parse_response_envelope usa resilient_json_parse | Concluído |
| 3 | Regra 3.3 escaping no protocolo compartilhado | Concluído |
| 4 | Testes LEI 4 | Concluído |

## Próximos

- LEI 5: `invoke_with_retry()` com feedback; nunca reenviar prompt idêntico.
