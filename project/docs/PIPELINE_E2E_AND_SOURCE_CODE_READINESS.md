# Pipeline E2E e prontidão para código fonte em project/

> Análise do estado atual do pipeline e do que é necessário para que o resultado final seja o **código fonte do produto** gerado em `project/`.

---

## 1. Estado atual: o que já está pronto

- **Fluxo do pipeline**: Spec → Engineer → CTO → PM → Dev → QA → Monitor → DevOps está implementado (sequencial sem API, ou Fase 1 + Monitor Loop com API e `PROJECT_ID`).
- **Portal → API → Runner**: `POST /api/projects/:id/run` chama o runner (serviço ou subprocess) com `projectId`, `specPath`, token; o runner recebe `PROJECT_ID` e `PROJECT_FILES_ROOT` via ambiente e grava em `<PROJECT_FILES_ROOT>/<project_id>/docs/` e `.../project/`.
- **Agentes e Claude**: Runner chama agentes via HTTP; runtime usa Claude e devolve `response_envelope` (status, summary, artifacts).
- **Persistência**: Spec, engineer, cto, pm, dev (summary + artifacts em docs), qa, monitor, devops são gravados. **Apenas os artifacts do DevOps** com `path` e `content` são escritos em **`project/`** (`write_project_artifact` em `runner.py` ~linha 843).

Conclusão: o pipeline **roda do início ao fim** e gera documentos + artefatos de infra (DevOps) em `project/`. O que falta é que o **código da aplicação** (ex.: Node.js) seja tratado como artefatos e escrito em `project/`.

---

## 2. Por que hoje não gera “código fonte do produto” no final

1. **Dev não grava em `project/`**  
   No runner, os artifacts do Dev são persistidos apenas em `docs/` (`storage.write_doc(..., "dev", f"artifact_{i}", ...)`). Não há chamada a `write_project_artifact` para artifacts do Dev, mesmo quando tiverem `path` (ex.: `src/index.js`) e `content`.

2. **Prompts/contrato não exigem “path + content” para código**  
   O `response_envelope.json` define artifacts como `type`, `path`, `purpose` (sem campo `content`). O runner usa `art.get("content")` e `art.get("path")` para DevOps. Para o Dev não está explícito no prompt/skills que ele deve devolver artefatos tipo arquivo com `path` e `content` para cada arquivo de código.

3. **Apenas DevOps escreve em `project/`**  
   Só os artifacts do DevOps (Dockerfile, docker-compose, etc.) são persistidos em `project/`. O código da aplicação deveria vir dos artifacts do Dev e ser escrito na mesma árvore — isso não está implementado.

4. **Limite de tokens**  
   O runtime usa `max_tokens=4096`. Para um produto com vários arquivos, pode ser pouco em uma única resposta; pode ser necessário múltiplas chamadas ou aumento de limite.

---

## 3. Próximo passo: o que é necessário para o resultado ser o código fonte do produto em project/

Para que o **resultado final** seja o **código fonte do produto** gerado em `project/`, é necessário o seguinte.

### 3.1 Runner: persistir artifacts do Dev em `project/`

- **Onde**: `applications/orchestrator/runner.py`, no bloco que processa a resposta do Dev (fluxo sequencial e, se aplicável, no Monitor Loop).
- **O quê**: Para cada item em `dev_response.get("artifacts", [])` que for `dict` e tiver **`path`** e **`content`**, chamar `storage.write_project_artifact(project_id, path, content)` (mesma lógica já usada para DevOps). Opcionalmente manter também a gravação em `docs/` para artefatos que forem apenas documentação (ex.: sem path ou com type diferente).
- **Exemplo de lógica** (alinhada ao que já existe para DevOps):
  - Se `art.get("path")` e `art.get("content")`: `write_project_artifact(project_id, path_key, content)`.
  - Caso contrário (só content, sem path): continuar com `write_doc(project_id, "dev", f"artifact_{i}", content, ...)`.

### 3.2 Contrato: artifacts com path e content

- **Onde**: `applications/contracts/response_envelope.json` e documentação dos agentes.
- **O quê**: Incluir no schema de artifact o campo **`content`** (string, opcional) para artefatos tipo arquivo. Deixar explícito que, para arquivos de código ou config, o agente deve retornar `path` (ex.: `src/index.js`, `package.json`) e `content` (conteúdo do arquivo).
- **Exemplo**: `{"type":"file","path":"src/index.js","purpose":"Entrypoint API","content":"..."}`.

### 3.3 Prompt e skills do Dev

- **Onde**: `applications/agents/dev/backend/nodejs/SYSTEM_PROMPT.md` (e variantes por skill) e `applications/agents/dev/backend/nodejs/skills.md`.
- **O quê**: Instruir o agente a devolver em **artifacts** os arquivos de código/config da aplicação, cada um com:
  - **path**: caminho relativo (ex.: `src/index.js`, `package.json`, `tsconfig.json`).
  - **content**: conteúdo completo do arquivo.
  - **purpose** (opcional): descrição breve.
- Mencionar o `response_envelope` e que esses artifacts serão escritos em `project/` para formar a árvore do produto.

### 3.4 (Opcional) Aumento de max_tokens ou múltiplas respostas

- **Onde**: `applications/orchestrator/agents/runtime.py` (e possivelmente prompts).
- **O quê**: Avaliar aumentar `max_tokens` para respostas que contenham vários arquivos ou definir estratégia de múltiplas chamadas ao Dev (ex.: por módulo ou por grupo de arquivos) se um único response_envelope não couber todo o código.

### 3.5 Validação do fluxo E2E

- Garantir que, ao rodar o pipeline com uma spec de produto (ex.: `PRODUCT_SPEC.md`), variáveis de ambiente corretas (Claude, `PROJECT_FILES_ROOT`, API/runner) e, se aplicável, portal:
  - O pipeline termina (status completed ou aceite no portal).
  - Em `<PROJECT_FILES_ROOT>/<project_id>/project/` existam:
    - Artefatos de infra (DevOps): ex.: Dockerfile, docker-compose.
    - **Código da aplicação** (Dev): ex.: `src/`, `package.json`, etc., conforme spec.

---

## 4. Resumo de arquivos a alterar (próximo passo)

| Área              | Arquivo                                              | Ação |
|-------------------|------------------------------------------------------|------|
| Runner            | `applications/orchestrator/runner.py`                | Para artifacts do Dev com `path` e `content`, chamar `write_project_artifact`; manter write_doc para os demais. |
| Contrato          | `applications/contracts/response_envelope.json`      | Incluir campo `content` em artifact e documentar uso para arquivos de código. |
| Prompt Dev        | `applications/agents/dev/backend/nodejs/SYSTEM_PROMPT.md` (e variantes) | Exigir artifacts com path + content para arquivos de código. |
| Skills Dev        | `applications/agents/dev/backend/nodejs/skills.md`   | Reforçar entrega de arquivos com path e content em artifacts. |
| Runtime (opcional)| `applications/orchestrator/agents/runtime.py`        | Avaliar max_tokens ou estratégia de múltiplas chamadas para código grande. |

---

## 5. Referências

- Fluxo e variáveis: [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md)
- Pipeline e armazenamento: [PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md)
- Storage por projeto: `applications/orchestrator/project_storage.py` (`write_project_artifact`, `get_project_dir`)
- Runner e persistência de artifacts: `applications/orchestrator/runner.py` (Dev ~749–751, DevOps ~836–844)
