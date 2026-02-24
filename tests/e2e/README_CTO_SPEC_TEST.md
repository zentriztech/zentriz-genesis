# Teste isolado: CTO + spec → PRODUCT_SPEC.md

Testar **apenas o agente CTO** enviando a spec `project/spec/spec_landing_zentriz.txt` e verificando se a IA gera um `.md` no formato do template `project/spec/PRODUCT_SPEC_TEMPLATE.md`.

## O que é validado

- Serviço **agents** recebe `POST /invoke/cto` com `mode: spec_intake_and_normalize`.
- O **runtime** injeta o conteúdo de `PRODUCT_SPEC_TEMPLATE.md` no system prompt do CTO (carregado do disco).
- O CTO devolve um artifact (ex.: `docs/spec/PRODUCT_SPEC.md`) com o spec convertido para o formato do template.

## Pré-requisitos

1. **Agents rodando** na porta 8000:
   ```bash
   ./start-agents-host.sh
   ```
2. **CLAUDE_API_KEY** no `.env` (ou export).
3. **(Opcional)** Para gravar a resposta da IA em JSON em disco (para avaliação mesmo quando rejeitada): defina **`PROJECT_FILES_ROOT`** no `.env` (ex.: `PROJECT_FILES_ROOT=/Users/mac/zentriz-files`). Os arquivos vão para `<PROJECT_FILES_ROOT>/cto-spec-test/docs/cto/cto_response_cto-spec-test-e2e.json`.
4. Arquivos existentes:
   - `project/spec/spec_landing_zentriz.txt`
   - `project/spec/PRODUCT_SPEC_TEMPLATE.md`

## Executar com pytest

```bash
# Na raiz do repositório
pytest tests/e2e/test_cto_spec_only.py -v -s
```

Timeout padrão do CTO: 600 s (variável `CTO_SPEC_TEST_TIMEOUT`). Para salvar o resultado em arquivo:

```bash
SAVE_CTO_SPEC_OUTPUT=1 pytest tests/e2e/test_cto_spec_only.py -v -s
# Gera project/spec/PRODUCT_SPEC_from_cto_test.md
```

## Executar com curl (teste manual)

Com o agents no ar e a spec em um arquivo:

```bash
SPEC=$(cat project/spec/spec_landing_zentriz.txt | jq -Rs .)
BODY=$(jq -n \
  --argjson spec_raw "$SPEC" \
  '{project_id:"cto-spec-test",agent:"cto",mode:"spec_intake_and_normalize",task_id:null,task:"Converter spec para PRODUCT_SPEC",inputs:{spec_raw:$spec_raw,product_spec:null,constraints:["spec-driven","no-invent"]},input:{spec_raw:$spec_raw,product_spec:null,constraints:["spec-driven","no-invent"]},existing_artifacts:[],limits:{max_rounds:3,round:1}}')
curl -s -X POST http://127.0.0.1:8000/invoke/cto \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --max-time 600
```

Sem `jq`, pode montar o JSON manualmente (campo `inputs.spec_raw` = string com o conteúdo da spec).

## Resultado esperado

- **HTTP 200** e JSON com `status: "OK"` (ou `NEEDS_INFO` / `REVISION` em casos edge).
- `artifacts[]` com pelo menos um item cujo `path` contém `PRODUCT_SPEC` ou `spec`, e `content` em Markdown seguindo as seções do template (Metadados, Visão, FR, NFR, etc.).

Se o agents não estiver rodando, o teste de health falha com skip ou o teste principal falha por conexão recusada.
