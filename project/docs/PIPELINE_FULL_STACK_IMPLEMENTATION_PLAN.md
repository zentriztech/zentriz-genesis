# Plano: Pipeline Stack Completa e Armazenamento por Projeto

> Objetivo: implementar no runner os agentes Dev, QA, Monitor e DevOps; e persistir todos os documentos em disco organizados por `project_id` com atribuição de criador.
>
> **Status:** Implementação concluída. **Fluxo V2** em vigor: [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md). Detalhes e variáveis: [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).

---

## 1. Visão geral

- **Pipeline V2:** Spec → **CTO spec review** → **loop CTO↔Engineer** (max 3 rodadas) → Charter → **PM** (módulo backend, charter + proposta) → seed de tarefas → **Monitor Loop** (Dev/QA/DevOps) até **aceitar** ou **parar**. Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md), [ORCHESTRATOR_BLUEPRINT.md](ORCHESTRATOR_BLUEPRINT.md), [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).
- **Armazenamento:** Raiz configurável (`PROJECT_FILES_ROOT`, default `/Users/mac/zentriz-files`):
  - `<project_id>/docs/` — documentos gerados por cada membro da squad (Spec, CTO, Engineer, PM Backend, Dev, QA, Monitor, DevOps), com identificação do criador.
  - `<project_id>/project/` — artefatos do projeto final (código, configs) quando produzidos.
  - Manifesto opcional em `docs/manifest.json`: lista de arquivos com `creator`, `created_at`, `filename`.

---

## 2. Estrutura de pastas em disco

```
PROJECT_FILES_ROOT/
└── <project_id>/
    ├── docs/
    │   ├── manifest.json              # lista: filename, creator, created_at
    │   ├── spec_product_spec.md       # criador: spec (cópia ou ref da spec enviada)
    │   ├── engineer_proposal.md       # criador: engineer
    │   ├── cto_charter.md             # criador: cto
    │   ├── cto_artifact_*.md          # artefatos do CTO (quando retornados)
    │   ├── pm_backlog.md               # criador: pm
    │   ├── pm_artifact_*.md            # artefatos do PM (quando retornados)
    │   ├── dev_*.md                    # criador: dev
    │   ├── qa_*.md                     # criador: qa
    │   ├── monitor_*.md                # criador: monitor
    │   └── devops_*.md                 # criador: devops
    └── project/
        └── (código/configs finais quando o Dev/DevOps gerar)
```

Criadores padronizados: `spec`, `engineer`, `cto`, `pm`, `dev`, `qa`, `monitor`, `devops`.

---

## 3. Ordem do pipeline (fluxo V2)

| Ordem | Agente        | Entrada principal                    | Saída principal        | Documentos em docs/          |
|------|---------------|--------------------------------------|-------------------------|-----------------------------|
| 0    | (Spec)        | Arquivo enviado pelo usuário         | —                       | spec_*                       |
| 1    | CTO           | spec (sem proposta)                   | Spec revisada           | cto/spec_review              |
| 2–3  | Engineer ↔ CTO | spec_understood (+ questionamentos) | Proposta / Charter      | engineer/proposal, cto/charter |
| 4    | PM            | charter, module, engineer_proposal   | Backlog                 | pm_backlog                   |
| 5    | Dev           | backlog + charter                    | Implementação           | dev_* + project/ (se path)   |
| 6    | QA            | backlog + artefatos Dev              | Relatório QA            | qa_*                          |
| 7    | Monitor       | (loop) estado projeto/tasks           | Decisão Dev/QA/DevOps   | —                             |
| 8    | DevOps        | charter + backlog + artefatos        | Dockerfile / compose    | devops_* + project/ (se path)|

Cada passo persiste no diálogo; artefatos com `path` em `project/`, demais em `docs/`.

---

## 4. Implementação técnica

### 4.1 Módulo de armazenamento (`orchestrator/project_storage.py`)

- `get_project_root(project_id: str) -> Path`: retorna `PROJECT_FILES_ROOT / project_id`.
- `get_docs_dir(project_id: str) -> Path`: retorna `.../project_id/docs`.
- `get_project_dir(project_id: str) -> Path`: retorna `.../project_id/project`.
- `write_doc(project_id: str, creator: str, name: str, content: str, extension: str = "md") -> Path`: cria `docs/` se necessário, grava arquivo `{creator}_{name}.{extension}`, atualiza manifest, retorna path.
- `append_manifest(project_id: str, filename: str, creator: str)`.
- Criadores válidos: spec, engineer, cto, pm, dev, qa, monitor, devops (e legado: pm_backend, dev_backend, etc.).

### 4.2 Cliente HTTP dos agentes (`orchestrator/agents/client_http.py`)

- Endpoints: `dev` → `/invoke/dev`, `qa` → `/invoke/qa`, `monitor` → `/invoke/monitor`, `devops` → `/invoke/devops`.
- Runner usa `run_agent_http(agent_key, message)` para todos.

### 4.3 Runner (`orchestrator/runner.py`)

- Obter `PROJECT_ID` do ambiente; se existir e `PROJECT_FILES_ROOT` definido, usar `project_storage` para todos os writes.
- **Spec:** ao iniciar, copiar conteúdo da spec para `write_doc(project_id, "spec", "product_spec", spec_content)`.
- **Engineer:** após resposta, gravar summary em `write_doc(project_id, "engineer", "proposal", engineer_summary)`.
- **CTO:** gravar charter em `write_doc(project_id, "cto", "charter", charter_summary)` e cada item de `charter_artifacts` em `docs/` (cto_artifact_0.md, …).
- **PM:** gravar backlog em `write_doc(project_id, "pm", "backlog", backlog_summary)` e cada item de `backlog_artifacts` em `docs/` (pm_artifact_0.md, …).
- **Dev:** chamar `call_dev(spec_ref, charter_summary, backlog_summary, request_id)`; gravar summary e artifacts em docs com creator `dev`; post diálogo.
- **QA:** chamar `call_qa(...)` com contexto (backlog, dev summary); gravar em docs com creator `qa`; post diálogo.
- **Monitor:** chamar `call_monitor(...)` com contexto; gravar em docs com creator `monitor`; post diálogo.
- **DevOps:** chamar `call_devops(...)`; gravar em docs e, se houver artefatos de projeto, em `project/`; post diálogo.
- Estado (current_project.json) pode ser persistido em `project_id/state/` quando PROJECT_FILES_ROOT estiver definido (opcional).
- Eventos: manter events.jsonl em state ou em `project_id/events.jsonl` quando usar project storage.

### 4.4 Diálogo (`orchestrator/dialogue.py`)

- Templates em uso: `task.assigned`, `task.completed`, `qa.review`, `monitor.health`, `devops.deploy` (e eventos anteriores: `cto.engineer.request`, `engineer.cto.response`, `project.created`, `module.planned`).
- Runner chama `_post_dialogue(from_agent, to_agent, event_type, summary, request_id)` para cada novo agente.

### 4.5 Variáveis de ambiente

- `PROJECT_FILES_ROOT`: raiz dos arquivos por projeto (ex.: `/Users/mac/zentriz-files`). Se vazio, comportamento legado (state em orchestrator/state).
- Runner e API: documentar que a API pode servir listagem de docs via filesystem ou futuro endpoint.

### 4.6 API

- **Implementado:** `GET /api/projects/:id/artifacts` — retorna `{ docs, projectDocsRoot, projectArtifactsRoot }` lendo `PROJECT_FILES_ROOT/<id>/docs/manifest.json`. A API precisa ter `PROJECT_FILES_ROOT` e o mesmo volume (ou bind mount) do runner para ver os arquivos.

---

## 5. Controle de falha e status

- Se um agente falhar (ex.: Dev Backend), o runner pode: (a) marcar status `failed` e parar; ou (b) marcar etapa como falha e continuar em modo “parcial” (documentar decisão).
- Status do projeto na API: já existem `dev_qa`, `devops`; usar `completed` só quando o pipeline até DevOps concluir com sucesso.

---

## 6. Resumo de arquivos a criar/alterar

| Arquivo | Ação |
|---------|------|
| `project/docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md` | Criado (este plano). |
| `applications/orchestrator/project_storage.py` | Criar módulo de storage por project_id. |
| `applications/orchestrator/runner.py` | Integrar storage; adicionar chamadas e persistência para Dev, QA, Monitor, DevOps. |
| `applications/orchestrator/agents/client_http.py` | AGENT_ENDPOINTS com dev, qa, monitor, devops. |
| `applications/orchestrator/dialogue.py` | Novos event types e templates para dev/qa/monitor/devops. |
| `.env.example` | Adicionar `PROJECT_FILES_ROOT`. |
| `docker-compose.yml` | Passar `PROJECT_FILES_ROOT` ao runner; volume se necessário. |

---

## 7. Status da implementação (100%)

| Item | Status |
|------|--------|
| **Plano** | Este documento. |
| **project_storage.py** | Implementado: `get_project_root`, `get_docs_dir`, `get_project_dir`, `write_doc`, `write_spec_doc`, `write_project_artifact`, `append_manifest`, `is_enabled`; criadores válidos conforme §4.1. |
| **runner.py** | Implementado: pipeline completo (Engineer → CTO → PM Backend → Dev → QA → Monitor → DevOps); uso de project_storage quando `PROJECT_FILES_ROOT` e `PROJECT_ID` definidos; `PIPELINE_FULL_STACK` (default true) controla os 4 agentes adicionais. |
| **client_http.py** | Implementado: `AGENT_ENDPOINTS` com engineer, cto, pm, dev, qa, monitor, devops. |
| **dialogue.py** | Implementado: templates para task.assigned, task.completed, qa.review, monitor.health, devops.deploy e eventos anteriores. |
| **.env.example** | PROJECT_FILES_ROOT, PIPELINE_FULL_STACK documentados. |
| **docker-compose.yml** | PROJECT_FILES_ROOT e PIPELINE_FULL_STACK no runner; volume `zentriz-genesis_projectfiles`; API com PROJECT_FILES_ROOT e mesmo volume para GET /api/projects/:id/artifacts. |
| **docker-compose.override.example.yml** | Exemplo para montar pasta do host (ex.: `/Users/mac/zentriz-files`) em `/project-files`. |
| **API** | GET /api/projects/:id/artifacts implementado em `api-node` (projects.ts): retorna `docs` (do manifest.json), `projectDocsRoot`, `projectArtifactsRoot`. |

Para usar a pasta do host no Mac: copie `docker-compose.override.example.yml` para `docker-compose.override.yml` (path `/Users/mac/zentriz-files` já está no exemplo). Os arquivos gerados ficarão em `/Users/mac/zentriz-files/<project_id>/docs/` e `.../project/`. Referência de fluxo e variáveis: [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).
