# Contexto IA — LEI 1 (temperature), extract_thinking, LEI 12

**Data**: 2026-02-21  
**Referência**: AGENT_LLM_COMMUNICATION_ANALYSIS.md §12.2 (12 Leis), §10 (extract_thinking)

---

## Objetivo

1. **LEI 1**: `AGENT_TEMPERATURE` no runtime — passado em cada `client.messages.create()`.
2. **extract_thinking**: Extrair raciocínio do Claude para debug/log; usar no runtime após resposta.
3. **LEI 12**: Confirmar que o QA tem instrução explícita de ceticismo sobre código gerado por IA (já presente).

---

## Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Criar 006 | Concluído |
| 2 | runtime: ler AGENT_TEMPERATURE (0-1), passar em messages.create | Concluído |
| 3 | envelope: extract_thinking(raw_text); runtime: log thinking (primeiros N chars) | Concluído |
| 4 | LEI 12: instrução explícita no QA (gate + ceticismo obrigatório) | Concluído |

---

## Alterações

- **LEI 1**: `runtime.py` — lê `AGENT_TEMPERATURE` (0-1); se válida, passa `temperature` em `client.messages.create()`.
- **extract_thinking**: `envelope.py` — função `extract_thinking(text)` que retorna conteúdo de `<thinking>...</thinking>`; `runtime.py` chama após resposta e loga primeiros 200 chars quando presente.
- **LEI 12**: QA Backend Node.js — gate em validate_task: "LEI 12 — Ceticismo obrigatório: código gerado por IA deve ser validado com desconfiança; não assuma que está correto..."
- **Testes**: `test_envelope.py` — `test_extract_thinking` e `test_extract_thinking_empty_when_no_tags`.

---

*Atualizado em 2026-02-21.*
