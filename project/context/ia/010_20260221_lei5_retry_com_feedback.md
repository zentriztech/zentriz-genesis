# 010 — LEI 5: Retry inteligente com feedback (nunca mesmo prompt)

**Data**: 2026-02-21  
**Fonte**: AGENT_LLM_COMMUNICATION_ANALYSIS.md § LEI 5

## Objetivo

Todo retry DEVE incluir feedback explícito sobre o que estava errado. Repetir o mesmo prompt tende a produzir a mesma resposta ruim (especialmente com temperature 0).

## Implementação

1. **runtime.py**
   - **`build_repair_feedback_block(failed_response, validation_errors)`**: monta o bloco de texto com:
     - Separador `---` e título `## ⚠️ ATENÇÃO — CORREÇÃO NECESSÁRIA (retry com feedback)`
     - Motivo da rejeição (`failed_response["summary"]`)
     - Lista de problemas (JSON indentado, até 10 erros)
     - Instrução: "Corrija estes problemas... Mantenha o que estava correto e corrija APENAS o necessário."
     - Lembrete: artefatos completos, `<thinking>` antes de `<response>`.
   - **run_agent**: quando há erros de validação e `repair_attempt < MAX_REPAIRS`, em vez de concatenar apenas `repair_prompt() + Falhas: ...`, passa a fazer `user_content = user_content + build_repair_feedback_block(out, all_errors)`. Assim o retry **nunca** reenvia o mesmo prompt — sempre inclui o bloco estruturado de feedback (LEI 5).

2. **Teste**
   - `test_build_repair_feedback_block_lei5`: verifica presença do título, do motivo, dos erros e do lembrete thinking/response.

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | build_repair_feedback_block | Concluído |
| 2 | run_agent usa bloco no repair (nunca mesmo prompt) | Concluído |
| 3 | Teste LEI 5 | Concluído |

## Próximos

- LEI 6: conteúdo do usuário em `<user_provided_content>` + anti-injection em todos os prompts.
