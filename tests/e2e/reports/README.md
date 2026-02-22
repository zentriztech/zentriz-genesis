# Relatórios E2E — Pipeline Landing

Resultados dos testes end-to-end do pipeline (spec → CTO → Engineer → … → Dev/QA).

## Arquivos gerados

| Arquivo | Descrição |
|---------|-----------|
| **junit.xml** | Relatório JUnit (pytest `--junitxml`). CI e IDEs podem importar. |
| **summary_YYYYMMDD_HHMMSS.txt** | Resumo da execução: data, exit status, totais passed/failed/skipped. |
| **e2e_failure_log_YYYYMMDD_HHMMSS.txt** | Só é criado quando `run_phased.py` falha **3 vezes** na mesma fase (para ajuda externa). |

## Como gerar

**Execução em fases (recomendado):** para na primeira falha, aplica correções e retenta até 3 vezes; após 3 falhas gera `e2e_failure_log_*.txt` para ajuda externa.

```bash
# Na raiz do repositório
python tests/e2e/run_phased.py
```

**Execução direta (todos os testes):**

```bash
pytest tests/e2e/test_pipeline_landing.py -v -s --junitxml=tests/e2e/reports/junit.xml
```

Requisitos: agents na porta 8000, `CLAUDE_API_KEY` configurada. Timeouts por agente: 300s (CTO, Engineer, PM, Dev, QA).

## Notas

- A primeira execução pode demorar vários minutos (chamadas reais ao Claude).
- Em timeout: o teste faz 1 retry automático; timeouts estão em 300s por agente.
- Payload: o teste envia `input` e `inputs` com o mesmo conteúdo para compatibilidade com o runtime.
