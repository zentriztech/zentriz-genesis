# Plano: Pipeline Stack Completa e Armazenamento por Projeto

> Objetivo: implementar no runner os agentes Dev, QA, Monitor e DevOps; e persistir todos os documentos em disco organizados por `project_id` com atribuição de criador.

---

## 1. Visão geral

- **Pipeline atual:** Spec → Engineer → CTO → PM Backend (3 agentes).
- **Pipeline alvo:** Spec → Engineer → CTO → PM Backend → **Dev Backend** → **QA Backend** → **Monitor Backend** → **DevOps Docker** (7 agentes na stack backend).
- **Armazenamento:** Raiz configurável (`PROJECT_FILES_ROOT`, default `/Users/mac/zentriz-files`):
  - `<project_id>/docs/` — documentos gerados por cada membro da stack (Spec, CTO, Engineer, PM Backend, Dev, QA, Monitor, DevOps), com identificação do criador.
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
    │   ├── pm_backend_backlog.md      # criador: pm_backend
    │   ├── dev_backend_*.md           # criador: dev_backend
    │   ├── qa_backend_*.md            # criador: qa_backend
    │   ├── monitor_backend_*.md       # criador: monitor_backend
    │   └── devops_docker_*.md         # criador: devops_docker
    └── project/
        └── (código/configs finais quando o Dev/DevOps gerar)
```

Criadores padronizados: `spec`, `engineer`, `cto`, `pm_backend`, `dev_backend`, `qa_backend`, `monitor_backend`, `devops_docker`.

---

## 3. Ordem do pipeline (stack completa)

| Ordem | Agente        | Entrada principal                    | Saída principal        | Documentos em docs/          |
|------|---------------|--------------------------------------|-------------------------|-----------------------------|
| 0    | (Spec)        | Arquivo enviado pelo usuário         | —                       | spec_product_spec.md        |
| 1    | Engineer      | spec_content                         | Proposta técnica        | engineer_proposal.md        |
| 2    | CTO           | engineer_proposal                    | Charter                 | cto_charter.md               |
| 3    | PM Backend    | charter_summary                      | Backlog                 | pm_backend_backlog.md       |
| 4    | Dev Backend   | backlog_summary + charter            | Implementação / evidências | dev_backend_*.md          |
| 5    | QA Backend    | backlog + artefatos Dev              | Relatório QA            | qa_backend_*.md             |
| 6    | Monitor Backend | contexto do projeto                | Health / alertas        | monitor_backend_*.md        |
| 7    | DevOps Docker | charter + backlog + artefatos        | Dockerfile / compose     | devops_docker_*.md + project/ |

Cada passo persiste no diálogo (project_dialogue) e grava artefatos em `<project_id>/docs/` com criador.

---

## 4. Implementação técnica

### 4.1 Módulo de armazenamento (`orchestrator/project_storage.py`)

- `get_project_root(project_id: str) -> Path`: retorna `PROJECT_FILES_ROOT / project_id`.
- `get_docs_dir(project_id: str) -> Path`: retorna `.../project_id/docs`.
- `get_project_dir(project_id: str) -> Path`: retorna `.../project_id/project`.
- `write_doc(project_id: str, creator: str, name: str, content: str, extension: str = "md") -> Path`: cria `docs/` se necessário, grava arquivo `{creator}_{name}.{extension}`, atualiza manifest, retorna path.
- `append_manifest(project_id: str, filename: str, creator: str)`.
- Criadores válidos: spec, engineer, cto, pm_backend, dev_backend, qa_backend, monitor_backend, devops_docker.

### 4.2 Cliente HTTP dos agentes (`orchestrator/agents/client_http.py`)

- Incluir endpoints: `dev_backend` → `/invoke/dev-backend`, `qa_backend` → `/invoke/qa-backend`, `monitor_backend` → `/invoke/monitor`, `devops_docker` → `/invoke/devops-docker`.
- Runner usa `run_agent_http(agent_key, message)` para todos.

### 4.3 Runner (`orchestrator/runner.py`)

- Obter `PROJECT_ID` do ambiente; se existir e `PROJECT_FILES_ROOT` definido, usar `project_storage` para todos os writes.
- **Spec:** ao iniciar, copiar conteúdo da spec para `write_doc(project_id, "spec", "product_spec", spec_content)`.
- **Engineer:** após resposta, gravar summary em `write_doc(project_id, "engineer", "proposal", engineer_summary)`.
- **CTO:** gravar charter em `write_doc(project_id, "cto", "charter", charter_summary)` (e artifacts se houver).
- **PM Backend:** gravar backlog em `write_doc(project_id, "pm_backend", "backlog", backlog_summary)`.
- **Dev Backend:** chamar `call_dev_backend(spec_ref, charter_summary, backlog_summary, request_id)`; gravar summary e artifacts em docs com creator `dev_backend`; post diálogo.
- **QA Backend:** chamar `call_qa_backend(...)` com contexto (backlog, dev summary); gravar em docs com creator `qa_backend`; post diálogo.
- **Monitor Backend:** chamar `call_monitor_backend(...)` com contexto; gravar em docs com creator `monitor_backend`; post diálogo.
- **DevOps Docker:** chamar `call_devops_docker(...)`; gravar em docs e, se houver artefatos de projeto, em `project/`; post diálogo.
- Estado (current_project.json) pode ser persistido em `project_id/state/` quando PROJECT_FILES_ROOT estiver definido (opcional).
- Eventos: manter events.jsonl em state ou em `project_id/events.jsonl` quando usar project storage.

### 4.4 Diálogo (`orchestrator/dialogue.py`)

- Incluir templates para: `task.assigned`, `dev.implementation`, `qa.review`, `monitor.health`, `devops.deploy` (ou equivalentes).
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
| `applications/orchestrator/agents/client_http.py` | Incluir dev_backend, qa_backend, monitor_backend, devops_docker. |
| `applications/orchestrator/dialogue.py` | Novos event types e templates para dev/qa/monitor/devops. |
| `.env.example` | Adicionar `PROJECT_FILES_ROOT`. |
| `docker-compose.yml` | Passar `PROJECT_FILES_ROOT` ao runner; volume se necessário. |

---

## 7. Status da implementação

- **Plano:** este documento.
- **project_storage.py:** módulo de armazenamento por `project_id` (docs/ e project/) com criador e manifest.
- **runner.py:** pipeline estendido (Engineer → CTO → PM Backend → Dev → QA → Monitor → DevOps); uso de project_storage quando `PROJECT_FILES_ROOT` e `PROJECT_ID` estão definidos; variável `PIPELINE_FULL_STACK` (default true) para rodar ou não os 4 agentes adicionais.
- **client_http.py:** endpoints dev_backend, qa_backend, monitor_backend, devops_docker.
- **dialogue.py:** templates para qa.review, devops.deploy, monitor.health.
- **.env.example:** PROJECT_FILES_ROOT, PIPELINE_FULL_STACK.
- **docker-compose:** PROJECT_FILES_ROOT e PIPELINE_FULL_STACK no runner; volume `zentriz-genesis_projectfiles`; API com PROJECT_FILES_ROOT e volume para GET /api/projects/:id/artifacts.
- **docker-compose.override.example.yml:** exemplo para montar pasta do host (ex.: `/Users/mac/zentriz-files`) em `/project-files`.
- **API:** GET /api/projects/:id/artifacts retorna lista de documentos (manifest) e paths de docs/project.

Para usar a pasta do host no Mac: copie `docker-compose.override.example.yml` para `docker-compose.override.yml` (path `/Users/mac/zentriz-files` já está no exemplo). Os arquivos gerados ficarão em `/Users/mac/zentriz-files/<project_id>/docs/` e `.../project/`.
