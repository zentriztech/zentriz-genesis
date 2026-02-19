# Fluxo: Agentes conversando com a LLM (Claude)

> Visão em profundidade de como o portal dispara o pipeline e onde cada agente (Engineer, CTO, PM) fala com a API Claude.

---

## 1. Visão em uma frase

O **portal (genesis-web)** permite ao usuário enviar uma spec e **iniciar** o pipeline. A **API (api-node)** chama o **Runner**; o Runner orquestra em sequência os **agentes** (Engineer → CTO → PM Backend). Cada agente roda no serviço **agents** (Python/FastAPI), que por sua vez chama a **API da Anthropic (Claude)**. Ou seja: **Agentes conversam com a LLM** no serviço `agents`, via `orchestrator/agents/runtime.py` e SDK `anthropic`.

---

## 2. Sequência completa

```
[Usuário] → Portal (genesis-web :3001)
                ↓ POST /api/projects/:id/run (NEXT_PUBLIC_API_BASE_URL → API)
[API]     → api-node (:3000)
                ↓ RUNNER_SERVICE_URL → POST http://runner:8001/run
[Runner]  → runner (:8001)
                ↓ API_AGENTS_URL → POST http://agents:8000/invoke/engineer (ou host.docker.internal:8000)
[Agents]  → agents (:8000 — host ou container)
                ↓ runtime.run_agent() → client.messages.create(...)
[Claude]  → API Anthropic (https://api.anthropic.com)
                ↓ resposta JSON (response_envelope)
[Agents]  ← resposta → Runner → POST diálogo na API → Portal exibe via polling
```

- O **único** serviço que usa `CLAUDE_API_KEY` e `CLAUDE_MODEL` para falar com a LLM é o **agents**.
- O **runner** chama os agents via HTTP e grava passos/erros no diálogo via API (`http://api:3000`).
- O **portal** faz polling GET `/api/projects/:id/dialogue` a cada 10s e exibe as entradas.

---

## 3. Onde cada peça vive

| Componente | Repositório / container | Responsabilidade |
|------------|-------------------------|------------------|
| Portal | genesis-web (Next.js) | UI: upload de spec, botão Iniciar/Parar, exibição do diálogo (passos e erros). |
| API | api-node (Node/Fastify) | Autenticação, projetos, upload de spec, **POST /api/projects/:id/run** → chama runner. |
| Runner | runner (Python) | Orquestração: lê spec, chama **engineer** → **cto** → **pm_backend** em ordem; persiste passos/erros no diálogo (POST na API). |
| Agentes | agents (Python/FastAPI) | Endpoints `/invoke/engineer`, `/invoke/cto`, `/invoke` (PM). Chama **Claude** via `runtime.run_agent()` e devolve `response_envelope`. |
| Runtime LLM | orchestrator/agents/runtime.py | `run_agent()` → Anthropic SDK → `client.messages.create(model=CLAUDE_MODEL, ...)`. Retry, extrai mensagem de erro. |
| Diálogo | orchestrator/dialogue.py | Templates em português, POST no endpoint `/api/projects/:id/dialogue`. |
| Claude | API Anthropic | LLM que gera as respostas (proposta técnica, charter, backlog). |

---

## 4. Como executar

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

## 5. Variáveis que importam

| Variável | Container | Valor correto |
|----------|-----------|---------------|
| `CLAUDE_API_KEY` | agents (ou host) | Chave da API Anthropic (`.env`) |
| `CLAUDE_MODEL` | agents (ou host) | `claude-sonnet-4-6` (ativo) |
| `API_BASE_URL` | runner | `http://api:3000` (**NÃO** `localhost` — causa Connection refused) |
| `API_AGENTS_URL` | runner | `http://agents:8000` ou `http://host.docker.internal:8000` |
| `SHOW_TRACEBACK` | agents, runner | `true` (dev, traceback completo) / `false` (prod, só mensagem humana) |
| `RUNNER_SERVICE_URL` | api | `http://runner:8001` (definido no compose) |

---

## 6. Diagnóstico rápido

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
- **Teste de conectividade Claude (sem Docker):**  
  `python tests/python/test_claude_connection.py`

---

## 7. Referências

- Lista completa de variáveis e troubleshooting: [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).
- Runner e fluxo spec → CTO → PM: [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) e `applications/orchestrator/runner.py`.
- Runtime e retry: `applications/orchestrator/agents/runtime.py`.
- Servidor de agentes: `applications/orchestrator/agents/server.py`.
- Diálogo (templates, POST): `applications/orchestrator/dialogue.py`.
