# Teste e2e isolado: PM (generate_backlog)

Valida o agente **PM** gerando backlog (BACKLOG.md e DOD.md) a partir do **PRODUCT_SPEC** e dos **artefatos do Engineer**.

## Pré-requisitos

1. **Artefatos do Engineer** em disco:
   - `PROJECT_FILES_ROOT/<project_id>/docs/engineer/engineer_proposal.md`
   - `PROJECT_FILES_ROOT/<project_id>/docs/engineer/engineer_architecture.md`
   - `PROJECT_FILES_ROOT/<project_id>/docs/engineer/engineer_dependencies.md`  
   Por padrão: `/Users/mac/zentriz-files/cto-spec-test/docs/engineer/`.

2. **PRODUCT_SPEC** (gerado pelo CTO):
   - `.../docs/spec/PRODUCT_SPEC.md`

3. **Agents** rodando na porta 8000 (ex.: `./start-agents-host.sh`).

4. **CLAUDE_API_KEY** no `.env`.

## Ordem recomendada

1. Rodar CTO: `pytest tests/e2e/test_cto_spec_only.py -v -s`
2. Rodar Engineer: `pytest tests/e2e/test_engineer_spec_only.py -v -s`
3. Rodar PM: `pytest tests/e2e/test_pm_spec_only.py -v -s`

## Execução

```bash
# Todos os testes do PM (health + generate_backlog)
pytest tests/e2e/test_pm_spec_only.py -v -s

# Apenas o teste de backlog
pytest tests/e2e/test_pm_spec_only.py -v -s -k test_pm_generate_backlog
```

## Variáveis de ambiente

| Variável | Default | Descrição |
|----------|---------|-----------|
| `PROJECT_FILES_ROOT` | `~/zentriz-files` | Raiz dos projetos |
| `PM_TEST_PROJECT_ID` | `cto-spec-test` | project_id usado no teste |
| `API_AGENTS_URL` | `http://127.0.0.1:8000` | URL do serviço de agents |
| `PM_SPEC_TEST_TIMEOUT` | `900` | Timeout da requisição (segundos) |

## Saída esperada

- **status** `OK`: resposta com 2 artifacts em `docs/pm/` (BACKLOG.md e DOD.md).
- Arquivos persistidos em `.../cto-spec-test/docs/pm/` (pm_response_*.json, raw_response_*.txt e, se habilitado, backend/BACKLOG.md e backend/DOD.md).

## Entrada do teste

O teste monta o payload do PM com:

- **product_spec**: conteúdo de `docs/spec/PRODUCT_SPEC.md` (até 15k chars).
- **charter**: resumo curto derivado do `engineer_proposal.md` (squad/stack aprovada).
- **engineer_docs**: lista com o conteúdo dos 3 arquivos do Engineer (proposal, architecture, dependencies).

Assim o PM parte exatamente do que o Engineer entregou em `docs/engineer/`.
