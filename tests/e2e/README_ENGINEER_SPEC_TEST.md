# Teste isolado: Engineer + PRODUCT_SPEC → proposta técnica

Testar **apenas o agente Engineer** enviando o `PRODUCT_SPEC.md` gerado pelo CTO e verificando se a IA gera os 3 documentos em `docs/engineer/` (proposta, arquitetura, dependências).

## Fluxo

1. **Entrada:** `PRODUCT_SPEC.md` em `<PROJECT_FILES_ROOT>/<project_id>/docs/spec/PRODUCT_SPEC.md`  
   - Por padrão: `/Users/mac/zentriz-files/cto-spec-test/docs/spec/PRODUCT_SPEC.md`  
   - Esse arquivo é produzido pelo teste do CTO: `pytest tests/e2e/test_cto_spec_only.py`

2. **Chamada:** `POST /invoke/engineer` com:
   - `mode: "generate_engineering_docs"`
   - `inputs.product_spec`: conteúdo do PRODUCT_SPEC (até 15k caracteres)

3. **Saída esperada:** `status: "OK"` e 3 artifacts:
   - `docs/engineer/engineer_proposal.md`
   - `docs/engineer/engineer_architecture.md`
   - `docs/engineer/engineer_dependencies.md`

## Pré-requisitos

1. **PRODUCT_SPEC.md existente**  
   Rode antes o teste do CTO (ou coloque um spec válido no caminho):
   ```bash
   pytest tests/e2e/test_cto_spec_only.py -v -s
   ```
   Ou defina outro arquivo: `ENGINEER_TEST_PRODUCT_SPEC_PATH=/caminho/para/PRODUCT_SPEC.md`

2. **Agents rodando** na porta 8000:
   ```bash
   ./start-agents-host.sh
   ```

3. **CLAUDE_API_KEY** no `.env` (ou export).

4. **(Opcional)** `PROJECT_FILES_ROOT` e `ENGINEER_TEST_PROJECT_ID`: mesmo projeto do CTO (`cto-spec-test`) para manter artefatos no mesmo diretório.

## Executar

```bash
# Na raiz do repositório
pytest tests/e2e/test_engineer_spec_only.py -v -s
```

Timeout padrão: 600 s (`ENGINEER_SPEC_TEST_TIMEOUT`).

## Validação

- HTTP 200 e `status` em `OK`, `NEEDS_INFO`, `REVISION` ou `BLOCKED`.
- Se `OK`: os 3 artifacts obrigatórios presentes; conteúdo da proposta validado por `validators/validate_engineer_proposal.py` (squad, stack web, referência a FRs).

## Ordem recomendada (CTO → Engineer)

```bash
# 1) CTO gera PRODUCT_SPEC em zentriz-files/cto-spec-test/docs/spec/
pytest tests/e2e/test_cto_spec_only.py -v -s

# 2) Engineer lê esse PRODUCT_SPEC e gera docs/engineer/*
pytest tests/e2e/test_engineer_spec_only.py -v -s
```
