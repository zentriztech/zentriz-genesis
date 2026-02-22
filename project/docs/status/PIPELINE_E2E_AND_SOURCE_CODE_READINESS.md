# Pipeline E2E e prontidão para código fonte em project/

> Análise do estado atual do pipeline e do que é necessário para que o resultado final seja o **código fonte do produto** gerado em `project/`.

---

## 1. Estado atual: o que já está pronto (Pipeline V2)

- **Fluxo do pipeline (V2)**: Spec → **CTO spec review** (converte/entende, grava em docs) → **loop CTO ↔ Engineer** (max 3 rodadas; proposta técnica, squads/skills; CTO valida ou questiona) → Charter → **PM** (módulo backend, charter + proposta do Engineer) → seed de tasks → **Monitor Loop** (Dev ↔ QA ↔ DevOps até aceite ou parada). Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](../plans/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).
- **Portal → API → Runner**: `POST /api/projects/:id/run` chama o runner com `projectId`, `specPath`, token; runner usa `PROJECT_ID` e `PROJECT_FILES_ROOT`; grava em `<root>/<project_id>/docs/` e `.../project/`.
- **Agentes e Claude**: Runner chama agentes via HTTP; runtime usa Claude e devolve `response_envelope` (status, summary, artifacts).
- **Persistência**: Spec, CTO spec_review, engineer proposal, cto charter, pm backlog, dev (summary + artifacts em docs **e**, quando artifact tem `path`, em **`project/`**), qa, monitor, devops (summary + artifacts com `path` em `project/`) são gravados. **Dev e DevOps**: artefatos com `path` e `content` são escritos em **`project/<project_id>/`** via `write_project_artifact` (runner: fluxo sequencial e Monitor Loop).

Conclusão: o pipeline **roda do início ao fim** e gera documentos + código do Dev e artefatos de infra (DevOps) em `project/`, quando os agentes devolvem artifacts com `path` e `content`.

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

### 3.1 Runner: persistir artifacts do Dev em `project/` (implementado V2)

- **Onde**: `applications/orchestrator/runner.py`, no bloco que processa a resposta do Dev (fluxo sequencial e no Monitor Loop).
- **Feito**: Para cada artifact do Dev com `path` e `content`, chama `write_project_artifact(project_id, path_key, content)`; sem `path`, grava em `docs/` com `write_doc`.

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

## 5. Testes E2E (Pipeline V2)

- **Cenário feliz**: Spec → CTO spec review → CTO↔Engineer (1–3 rodadas) → Charter → PM (módulo backend) → seed tasks → Monitor Loop → Dev → QA (aprovação) → DevOps “as if” → projeto concluível. Rodar com API + PROJECT_ID + PROJECT_FILES_ROOT; verificar docs em `<root>/<project_id>/docs/` e artefatos com `path` em `<root>/<project_id>/project/`.
- **Cenário QA_FAIL max rework**: Garantir que, após max rework (MAX_QA_REWORK), a tarefa vai para DONE e o DevOps **não** é acionado; mensagem no diálogo deve explicar o motivo.
- **Conteúdo legível**: `_content_for_doc` no runner extrai texto legível ao gravar em docs; verificar que os .md em docs/ e os arquivos em project/ não são JSON cru.

## 6. Referências

- Fluxo V2: [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](../plans/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md)
- Fluxo e variáveis: [AGENTS_AND_LLM_FLOW.md](../AGENTS_AND_LLM_FLOW.md)
- Pipeline e armazenamento: [PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md)
- Storage por projeto: `applications/orchestrator/project_storage.py` (`write_project_artifact`, `get_project_dir`)
- Runner e persistência: `applications/orchestrator/runner.py` (CTO spec review, loop CTO↔Engineer, PM com module, Dev/DevOps artifacts com path em project/)
