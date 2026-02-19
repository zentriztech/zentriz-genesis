# Fluxo: Agentes conversando com a LLM (Claude)

> Visão em profundidade de como o portal dispara o pipeline e onde cada agente (Engineer, CTO, PM, Dev, QA, Monitor, DevOps) fala com a API Claude.

---

## 1. Visão em uma frase

O **portal (genesis-web)** permite ao usuário enviar uma spec e **iniciar** o pipeline. A **API (api-node)** chama o **Runner**; o Runner executa **duas fases**: (1) **Fase 1** — Spec → Engineer → CTO → PM Backend (criação da squad); (2) **Fase 2** — **Monitor Loop** no mesmo processo: o runner lê o estado das tarefas na API, decide qual agente acionar (Dev, QA ou DevOps), invoca via HTTP, atualiza tarefas e diálogo, e repete até o usuário **aceitar o projeto** (botão no portal, `POST /api/projects/:id/accept`) ou **parar** o pipeline. Cada agente roda no serviço **agents** (Python/FastAPI), que chama a **API da Anthropic (Claude)**. Ou seja: **Agentes conversam com a LLM** no serviço `agents`, via `orchestrator/agents/runtime.py` e SDK `anthropic`.

Quando `API_BASE_URL` e `PROJECT_ID` não estão definidos (ex.: execução local sem portal), o runner pode rodar apenas Fase 1 ou o fluxo sequencial antigo (Dev → QA → Monitor → DevOps em uma tacada). Documentos e artefatos são persistidos por projeto em disco quando `PROJECT_FILES_ROOT` está definido.

---

## 2. Sequência completa

```
[Usuário] → Portal (genesis-web :3001)
                ↓ POST /api/projects/:id/run (NEXT_PUBLIC_API_BASE_URL → API)
[API]     → api-node (:3000)
                ↓ RUNNER_SERVICE_URL → POST http://runner:8001/run
[Runner]  → runner (:8001)
                ↓ API_AGENTS_URL → POST http://agents:8000/invoke/<agente>
[Agents]  → agents (:8000 — host ou container)
                ↓ runtime.run_agent() → client.messages.create(...)
[Claude]  → API Anthropic (https://api.anthropic.com)
                ↓ resposta JSON (response_envelope)
[Agents]  ← resposta → Runner → grava docs em PROJECT_FILES_ROOT (se definido)
                → POST diálogo na API → Portal exibe via polling
```

- O **único** serviço que usa `CLAUDE_API_KEY` e `CLAUDE_MODEL` para falar com a LLM é o **agents**.
- O **runner** chama os agents via HTTP e grava passos/erros no diálogo via API (`http://api:3000`). Após PM Backend, quando `PROJECT_ID` e API estão definidos, o runner faz **seed de tarefas** (POST `/api/projects/:id/tasks`) e entra no **Monitor Loop**: a cada ciclo lê GET `/api/projects/:id` e GET `/api/projects/:id/tasks`; se status for `accepted` ou `stopped`, encerra; senão decide próximo agente (Dev/QA/DevOps), invoca, atualiza task (PATCH `/api/projects/:id/tasks/:taskId`) e persiste artefatos em `<PROJECT_FILES_ROOT>/<project_id>/docs/` quando definido. O loop só para quando o usuário clica em **Aceitar projeto** no portal (que chama POST `/api/projects/:id/accept`) ou em **Parar** (SIGTERM no processo).
- O **portal** faz polling GET `/api/projects/:id/dialogue` e exibe as entradas; exibe o botão **Aceitar projeto** quando status é `completed` ou `running`, chamando POST `/api/projects/:id/accept`. Pode listar documentos via GET `/api/projects/:id/artifacts` (quando `PROJECT_FILES_ROOT` está definido na API).

---

## 3. Ordem do pipeline (squad completa)

| Ordem | Agente        | Endpoint (agents)     | Entrada principal                    | Saída principal        |
|-------|---------------|-----------------------|--------------------------------------|-------------------------|
| 0     | (Spec)        | —                     | Arquivo enviado pelo usuário         | —                       |
| 1     | Engineer      | POST /invoke/engineer | spec_content                         | Proposta técnica        |
| 2     | CTO           | POST /invoke/cto      | engineer_proposal                    | Charter                 |
| 3     | PM Backend    | POST /invoke          | charter_summary                      | Backlog                 |
| 4     | Dev Backend   | POST /invoke/dev-backend | backlog_summary + charter        | Implementação / evidências |
| 5     | QA Backend    | POST /invoke/qa-backend | backlog + artefatos Dev           | Relatório QA            |
| 6     | Monitor Backend | POST /invoke/monitor | contexto do projeto                | Health / alertas        |
| 7     | DevOps Docker | POST /invoke/devops-docker | charter + backlog + artefatos  | Dockerfile / compose    |

Cada passo persiste no diálogo (project_dialogue) e, quando `PROJECT_FILES_ROOT` está definido, grava artefatos em `<project_id>/docs/` com criador (spec, engineer, cto, pm_backend, dev_backend, qa_backend, monitor_backend, devops_docker).

---

## 4. Onde cada peça vive

| Componente | Repositório / container | Responsabilidade |
|------------|-------------------------|-------------------|
| Portal | genesis-web (Next.js) | UI: upload de spec, botão Iniciar/Parar, exibição do diálogo (passos e erros). |
| API | api-node (Node/Fastify) | Autenticação, projetos, upload de spec, **POST /api/projects/:id/run** → chama runner; **GET /api/projects/:id/artifacts** → lista docs do projeto (manifest em PROJECT_FILES_ROOT). |
| Runner | runner (Python) | Orquestração: lê spec, chama **engineer** → **cto** → **pm_backend** → (opcional) **dev_backend** → **qa_backend** → **monitor_backend** → **devops_docker**; persiste passos/erros no diálogo (POST na API) e documentos em disco por project_id. |
| Agentes | agents (Python/FastAPI) | Endpoints `/invoke/engineer`, `/invoke/cto`, `/invoke`, `/invoke/dev-backend`, `/invoke/qa-backend`, `/invoke/monitor`, `/invoke/devops-docker`. Chama **Claude** via `runtime.run_agent()` e devolve `response_envelope`. |
| Runtime LLM | orchestrator/agents/runtime.py | `run_agent()` → Anthropic SDK → `client.messages.create(model=CLAUDE_MODEL, ...)`. Retry, extrai mensagem de erro. |
| Diálogo | orchestrator/dialogue.py | Templates em português, POST no endpoint `/api/projects/:id/dialogue`. |
| Claude | API Anthropic | LLM que gera as respostas (proposta técnica, charter, backlog, implementação, QA, monitor, DevOps). |

---

## 5. Como executar

### Modo host-agents (Docker Desktop Mac — recomendado)

**Terminal 1:**
```bash
./deploy-docker.sh --host-agents --force-recreate
```
Sobe: api, genesis-web, runner, postgres, redis. O agents **não** sobe no Docker.

**Terminal 2:**
```bash
./start-agents-host.sh
```
Sobe os agentes no host (porta 8000). Carrega `.env` automaticamente. O runner no Docker chama `http://host.docker.internal:8000`.

### Modo Docker completo (Linux / onde TLS funciona)

```bash
./deploy-docker.sh --force-recreate
```

---

## 6. Variáveis que importam

| Variável | Container | Valor correto |
|----------|-----------|----------------|
| `CLAUDE_API_KEY` | agents (ou host) | Chave da API Anthropic (`.env`) |
| `CLAUDE_MODEL` | agents (ou host) | `claude-sonnet-4-6` (ativo) |
| `API_BASE_URL` | runner | `http://api:3000` (**NÃO** `localhost` — causa Connection refused) |
| `API_AGENTS_URL` | runner | `http://agents:8000` ou `http://host.docker.internal:8000` |
| `PROJECT_FILES_ROOT` | runner, api | Raiz dos arquivos por projeto (ex.: `/project-files` no container; no host `/Users/mac/zentriz-files`). Se definido, runner grava docs em `<root>/<project_id>/docs` e artefatos em `.../project`; API serve GET /api/projects/:id/artifacts. |
| `PIPELINE_FULL_STACK` | runner | `true` = pipeline completo (Dev, QA, Monitor, DevOps); `false` = só Engineer → CTO → PM Backend. |
| `SHOW_TRACEBACK` | agents, runner | `true` (dev, traceback completo) / `false` (prod, só mensagem humana) |
| `RUNNER_SERVICE_URL` | api | `http://runner:8001` (definido no compose) |

---

## 7. Diagnóstico rápido

- **Logs dos agentes (quem fala com a Claude):**  
  Host: veja o terminal de `./start-agents-host.sh`.  
  Docker: `docker compose logs agents`.  
  Deve aparecer: `CLAUDE_MODEL=claude-sonnet-4-6 | CLAUDE_API_KEY (definida) | SHOW_TRACEBACK ativado`.
- **Health do agents:**  
  `curl -s http://127.0.0.1:8000/health`  
  Resposta: `"claude_model": "claude-sonnet-4-6"`, `"claude_configured": true`.
- **Diálogo gravado no banco?**  
  `docker compose exec postgres psql -U genesis -d zentriz_genesis -c "SELECT from_agent, event_type, LEFT(summary_human,80) FROM project_dialogue ORDER BY created_at DESC LIMIT 10;"`
- **Logs do runner (passos e erros):**  
  `docker compose logs runner --tail=50`  
  Se aparecer `Connection refused`, verificar que `API_BASE_URL=http://api:3000`.
- **Documentos por projeto (PROJECT_FILES_ROOT):**  
  No host: `ls <PROJECT_FILES_ROOT>/<project_id>/docs/`.  
  Na API: `GET /api/projects/:id/artifacts` (retorna `docs`, `projectDocsRoot`, `projectArtifactsRoot`).
- **Teste de conectividade Claude (sem Docker):**  
  `python tests/python/test_claude_connection.py`

---

## 8. Referências

- Lista completa de variáveis e troubleshooting: [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).
- Plano do pipeline squad completa e armazenamento: [PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md).
- Runner e fluxo spec → CTO → PM → Dev → QA → Monitor → DevOps: [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) e `applications/orchestrator/runner.py`.
- Runtime e retry: `applications/orchestrator/agents/runtime.py`.
- Servidor de agentes: `applications/orchestrator/agents/server.py`.
- Diálogo (templates, POST): `applications/orchestrator/dialogue.py`.
- Armazenamento por projeto: `applications/orchestrator/project_storage.py`.
