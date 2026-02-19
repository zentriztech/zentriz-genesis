# Contexto para o Próximo Chat — Zentriz Genesis

> **Objetivo**: Orientar o próximo chat (assistente de IA) com o estado atual do projeto, o que foi feito nesta sessão e onde encontrar o que precisa.

---

## Por onde começar

1. **Visão geral do produto e atores** → [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)  
2. **Estado operacional (stack, credenciais, como rodar)** → [CONTEXT.md](CONTEXT.md)  
3. **Referência rápida (caminhos, eventos, atores)** → [QUICK_REFERENCE.md](QUICK_REFERENCE.md)  
4. **Fluxo Agentes ↔ LLM (Claude)** → [AGENTS_AND_LLM_FLOW.md](../docs/AGENTS_AND_LLM_FLOW.md)

---

## Como rodar (modo recomendado)

### Opção A — Agentes no host (Docker Desktop Mac)

O container Docker no Mac não consegue TLS até `api.anthropic.com` (erro SSL: UNEXPECTED_EOF_WHILE_READING). A solução é rodar os agentes **no host** e o resto no Docker:

**Terminal 1:**
```bash
./deploy-docker.sh --host-agents --force-recreate
```
Sobe: api, genesis-web, runner, postgres, redis. Não sobe agents.

**Terminal 2:**
```bash
./start-agents-host.sh
```
Sobe os agentes no host (porta 8000). Carrega `.env` automaticamente. O runner no Docker chama `http://host.docker.internal:8000`.

### Opção B — Tudo no Docker (onde TLS funciona)

```bash
./deploy-docker.sh --force-recreate
```
Sobe todos os serviços, incluindo agents. Funciona em Linux e ambientes onde o container consegue TLS para a Anthropic.

### Opções do deploy-docker.sh

| Flag | Efeito |
|------|--------|
| `--host-agents` | Não sobe agents no Docker; runner aponta para host |
| `--force-recreate` | Recria containers (usar após alterar `.env`) |
| `--no-cache` | Build sem cache |
| `--prune` | Limpa cache Docker antes de build |
| `SERVICE...` | Limitar a serviços específicos (ex.: `runner agents`) |

---

## Estado atual (atualizado nesta sessão)

### Pipeline e portal

- **Runner** (`applications/orchestrator/runner.py`): fluxo Spec → Engineer → CTO → PM Backend. Registra passos e erros no diálogo (POST dialogue na API).
  - **IMPORTANTE:** dentro do Docker, `API_BASE_URL` **deve** ser `http://api:3000` (nome do serviço), não `http://localhost:3000`. O `docker-compose.yml` define isso explicitamente no serviço runner.
- **Runner as service** (`applications/orchestrator/runner_server.py`): POST `/run` e POST `/stop`; usado no Docker com `RUNNER_SERVICE_URL`.
- **API** (`applications/services/api-node`): POST `/api/projects/:id/run`, POST `/api/projects/:id/stop`, GET/PATCH projetos, diálogo.
- **Portal (genesis-web)**: botão Iniciar / Parar; polling a cada 10s quando `status === "running"`; diálogo com passos e erros; em erros, mensagem em destaque (Alert) e traceback colapsável.

### Logging e diálogo

- **Cada passo** do pipeline registra mensagem em linguagem humana no diálogo do projeto (tabela `project_dialogue`).
- **Erros** incluem traceback quando `SHOW_TRACEBACK=true` (dev); em prod, desativar com `SHOW_TRACEBACK=false`.
- Os logs do runner e dos agentes usam prefixos `[Pipeline]`, `[Engineer]`, `[CTO]`, `[PM Backend]` para clareza.
- O portal faz polling GET `/api/projects/:id/dialogue` a cada 10s e exibe as entradas.

### Variáveis de ambiente importantes

| Variável | Container | Valor correto |
|----------|-----------|---------------|
| `CLAUDE_API_KEY` | agents (ou host) | Chave da API Anthropic |
| `CLAUDE_MODEL` | agents (ou host) | `claude-sonnet-4-6` (ativo) |
| `API_BASE_URL` | runner | `http://api:3000` (definido no compose, NÃO usar localhost) |
| `API_AGENTS_URL` | runner | `http://agents:8000` ou `http://host.docker.internal:8000` |
| `SHOW_TRACEBACK` | agents, runner | `true` (dev) / `false` (prod) |

### Docker e deploy

- **Modo host-agents:** `./deploy-docker.sh --host-agents` + `./start-agents-host.sh` em outro terminal.
- **Serviços**: api (3000), genesis-web (3001), agents (8000), runner (8001), postgres (5432), redis (6379).
- **Build genesis-web no Docker**: requer `NEXT_IGNORE_INCORRECT_LOCKFILE=1` no Dockerfile.

### Banco de dados

- **PostgreSQL**: tabelas `plans`, `tenants`, `users`, `projects`, `project_spec_files`, `project_dialogue`.
- Acesso: `docker compose exec postgres psql -U genesis -d zentriz_genesis -c "..."`.

---

## Caminhos importantes

| O quê | Onde |
|-------|------|
| Runner (fluxo spec → CTO → PM) | `applications/orchestrator/runner.py` |
| Runner as HTTP service | `applications/orchestrator/runner_server.py` |
| Runtime Claude + retry | `applications/orchestrator/agents/runtime.py` |
| Servidor de agentes (FastAPI) | `applications/orchestrator/agents/server.py` |
| Cliente HTTP agentes | `applications/orchestrator/agents/client_http.py` |
| Diálogo (templates, POST) | `applications/orchestrator/dialogue.py` |
| API pipeline (POST /run, stop) | `applications/services/api-node/src/routes/pipeline.ts` |
| API diálogo (GET/POST) | `applications/services/api-node/src/routes/dialogue.ts` |
| Portal diálogo (polling) | `applications/apps/genesis-web/components/ProjectDialogue.tsx` |
| Schema e migration | `applications/services/api-node/src/db/schema.sql` |
| Deploy Docker | `deploy-docker.sh`, `docker-compose.yml` |
| Agentes no host | `start-agents-host.sh` |
| Secrets e env | `project/docs/SECRETS_AND_ENV.md` |
| Fluxo Agentes → Claude (LLM) | `project/docs/AGENTS_AND_LLM_FLOW.md` |

---

## Pontos de atenção para o próximo chat

- **API_BASE_URL no runner Docker:** deve ser `http://api:3000` (nome do serviço), NÃO `http://localhost:3000` — se for localhost, o runner não consegue gravar diálogo/patch no projeto (Connection refused).
- **TLS no Docker Desktop Mac:** o container agents não consegue TLS para api.anthropic.com. Usar modo host-agents.
- **SHOW_TRACEBACK:** em dev=true (traceback completo nos erros), em prod=false (só mensagem humana).
- **Modelo Claude:** `claude-sonnet-4-6` (ativo). O antigo `claude-3-5-sonnet-20241022` foi descontinuado (out/2025).
- **Build genesis-web no Docker:** requer `NEXT_IGNORE_INCORRECT_LOCKFILE=1` no Dockerfile.

---

*Atualizado em 2026-02-19 — use este arquivo como ponto de partida no próximo chat.*
