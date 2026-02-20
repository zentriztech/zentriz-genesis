# De-Para: API ↔ WEB (genesis-web) ↔ Backend (runner) ↔ Agentes

**Objetivo:** Garantir alinhamento de contratos entre as camadas para pipeline E2E.

---

## 1. API (api-node) — Endpoints e contratos

| Método | Rota | Body/Params | Resposta | Quem chama |
|--------|------|-------------|----------|------------|
| GET | `/health`, `/api/health` | — | `{ status }` | — |
| POST | `/api/auth/login` | `{ email, password }` | `{ token, user }` | WEB (authStore) |
| GET | `/api/projects` | — (Bearer) | `Project[]` | WEB (projectsStore), Runner não usa |
| GET | `/api/projects/:id` | `id` params | `Project` (id, tenantId, status, title, specRef, charterSummary, backlogSummary, startedAt, completedAt, …) | WEB (loadProject), **Runner** (_get_project_status, _get_tasks usa só status) |
| PATCH | `/api/projects/:id` | `{ status?, started_at?, completed_at?, charter_summary?, backlog_summary? }` | `{ ok: true }` | **Runner** (_patch_project) |
| POST | `/api/projects/:id/run` | — (Bearer) | 202 `{ ok, message, status: "running" }` ou 4xx/5xx | WEB (Iniciar pipeline) |
| POST | `/api/projects/:id/stop` | — (Bearer) | 200 `{ ok, message }` | WEB (Parar pipeline) |
| POST | `/api/projects/:id/accept` | `{}` (Bearer) | 200 `{ ok, status: "accepted", updatedAt? }` | WEB (Aceitar projeto) |
| GET | `/api/projects/:id/dialogue` | `id` params (Bearer) | `DialogueEntry[]` (id, fromAgent, toAgent, eventType, summaryHuman, requestId, createdAt) | WEB (ProjectDialogue) |
| POST | `/api/projects/:id/dialogue` | `{ from_agent, to_agent, summary_human, event_type?, request_id? }` | 201 `{ ok: true }` | **Runner** (dialogue.post_dialogue) |
| GET | `/api/projects/:id/tasks` | `id` params (Bearer) | `Task[]` (id, projectId, taskId, module, ownerRole, requirements, status, …) | WEB (project detail), **Runner** (_get_tasks) |
| POST | `/api/projects/:id/tasks` | `{ tasks: [{ task_id, module?, owner_role, requirements?, status? }] }` | 201 `{ ok, tasks }` | **Runner** (_seed_tasks) |
| PATCH | `/api/projects/:id/tasks/:taskId` | `{ status?, artifacts_ref?, evidence? }` | 200 `{ ok }` | **Runner** (_update_task) |
| GET | `/api/projects/:id/artifacts` | `id` params (Bearer) | `{ docs: [], projectDocsRoot?, projectArtifactsRoot? }` | WEB (project detail) |
| POST | `/api/specs` | multipart: `title`, `files` | `{ projectId, status, message }` | WEB (spec page) |

**Status de projeto (API):** `draft | spec_submitted | pending_conversion | cto_charter | pm_backlog | dev_qa | devops | completed | accepted | failed | running | stopped` (VALID_PROJECT_STATUS).  
**Status permitidos para run (API):** `draft | spec_submitted | pending_conversion | cto_charter | pm_backlog | stopped | failed` (ALLOWED_STATUS_FOR_RUN).

---

## 2. WEB (genesis-web) — Chamadas e tipos

| Ação | Chamada | Tipo esperado |
|------|---------|----------------|
| Login | `POST /api/auth/login` | `{ token, user }` |
| Listar projetos | `GET /api/projects` | `Project[]` |
| Detalhe projeto | `GET /api/projects/:id` | `Project` |
| Iniciar pipeline | `POST /api/projects/:id/run` | `{ ok?, message?, status?: "running" }` |
| Parar pipeline | `POST /api/projects/:id/stop` | `{ ok?, message? }` |
| Aceitar projeto | `POST /api/projects/:id/accept` | `{ ok?, status? }` |
| Diálogo | `GET /api/projects/:id/dialogue` | `DialogueEntry[]` |
| Tarefas | `GET /api/projects/:id/tasks` | `TaskItem[]` (id, taskId, status, requirements, module, …) |
| Artefatos | `GET /api/projects/:id/artifacts` | `{ docs: Array<{ filename, creator?, title?, created_at? }>, projectDocsRoot?, projectArtifactsRoot? }` |
| Enviar spec | `POST /api/specs` (multipart) | `{ projectId, status, message }` |

**Base URL:** `NEXT_PUBLIC_API_BASE_URL` (browser) ou default `http://localhost:3000`. SSR/Docker: `http://api:3000`.

---

## 3. Backend (runner / runner_server)

### 3.1 Runner (orchestrator.runner)

- **Entrada:** subprocess com `--spec-file <path>` e env: `API_BASE_URL`, `PROJECT_ID`, `GENESIS_API_TOKEN`, `CLAUDE_API_KEY?`, `API_AGENTS_URL?`, `PROJECT_FILES_ROOT?`.
- **Chamadas à API:**
  - `PATCH /api/projects/:project_id` — status, started_at, completed_at, charter_summary, backlog_summary.
  - `POST /api/projects/:project_id/dialogue` — from_agent, to_agent, summary_human, event_type, request_id (via dialogue.post_dialogue).
  - `GET /api/projects/:project_id` — para status (Monitor Loop).
  - `GET /api/projects/:project_id/tasks` — lista de tasks (Monitor Loop); espera array com `taskId` ou `task_id`, `status`, etc.
  - `POST /api/projects/:project_id/tasks` — seed: `{ tasks: [{ task_id, module, owner_role, status }] }` (owner_role ex.: DEV_BACKEND).
  - `PATCH /api/projects/:project_id/tasks/:task_id` — status (ASSIGNED, IN_PROGRESS, WAITING_REVIEW, QA_PASS, QA_FAIL, DONE).

### 3.2 Runner service (runner_server.py)

- **POST /run:** body `{ projectId, specPath, apiBaseUrl, token }` ou `specContent` (base64). Env para subprocess: PROJECT_ID, API_BASE_URL, GENESIS_API_TOKEN.
- **POST /stop:** body `{ projectId }`.

### 3.3 API → Runner

- **POST /api/projects/:id/run:** API chama `RUNNER_SERVICE_URL/run` com projectId, specPath, apiBaseUrl, token; ou usa RUNNER_COMMAND (spawn com --spec-file). Atualiza projeto para status `running` e retorna 202.

---

## 4. Agentes (orchestrator.agents)

### 4.1 Serviço HTTP (server.py)

- **POST /invoke/{role}:** body = **MessageEnvelope** (pass-through). Roles: engineer, cto, pm, dev, qa, monitor, devops.
- **Resposta:** **ResponseEnvelope** (status, summary, artifacts, evidence, next_actions).

### 4.2 MessageEnvelope (runner → agentes)

Campos enviados pelo runner ( _build_message_envelope + call_* ):  
`request_id`, `project_id`, `agent`, `variant`, `mode`, `task_id`, `task`, `inputs`, `existing_artifacts`, `limits`, `input` (alias de inputs).

### 4.3 ResponseEnvelope (agentes → runner)

Esperado: `status` (OK | FAIL | BLOCKED | NEEDS_INFO | QA_PASS | QA_FAIL | …), `summary`, `artifacts[]` (path, content, purpose?), `evidence[]`, `next_actions` (objeto).  
Runtime (Enforcer) valida por modo e adiciona `validator_pass`, `validation_errors`, `artifacts_paths` na resposta.

### 4.4 Cliente HTTP (client_http.py)

- Envia body com `input` ou `{ request_id, input: message }`. URL: `API_AGENTS_URL` + `/invoke/engineer` | `/invoke/cto` | … | `/invoke/devops`.

---

## 5. Checklist de consistência

- [x] WEB usa GET /api/projects/:id e espera Project com status, startedAt, completedAt — API retorna camelCase.
- [x] WEB usa POST /run e espera status "running" — API retorna 202 e status "running".
- [x] Runner envia PATCH /api/projects/:id com snake_case (started_at, completed_at, charter_summary, backlog_summary) — API aceita snake_case.
- [x] Runner envia POST dialogue com from_agent, to_agent, summary_human (snake_case) — API aceita e GET dialogue retorna camelCase (fromAgent, toAgent, summaryHuman) para o WEB.
- [x] Runner usa GET /api/projects/:id/tasks e espera array com taskId ou task_id — API retorna taskId (camelCase).
- [x] Runner usa PATCH /api/projects/:id/tasks/:taskId com task_id na URL — API rota é :taskId (mesmo valor, ex.: TSK-BE-001).
- [x] WEB chama GET /api/projects/:id/artifacts e GET /api/projects/:id/tasks — ambos existem na API.
- [x] Agentes recebem MessageEnvelope completo (inputs, mode, task_id, existing_artifacts) quando runner usa _build_message_envelope.

---

## 6. Como rodar E2E

- **Backend (orchestrator):** validação de envelope, storage, runner/dialogue, enforcer smoke.
  ```bash
  cd <repo>
  PYTHONPATH=applications python -m pytest applications/orchestrator/tests/ -v
  ```
- **API (api-node):** integração com DB (auth, projects, specs, dialogue, tasks, artifacts, PATCH project, accept).
  ```bash
  cd applications/services/api-node
  npm run test
  ```
- **Pipeline real (portal → API → runner → agentes):** subir stack (api, genesis-web, runner, agents, postgres), enviar spec pelo portal, clicar em Iniciar pipeline, acompanhar diálogo e tarefas.

*Documento gerado para revisão E2E — pipeline V2 + Enforcer.*
