# Deployment — Zentriz Genesis

## Ambientes

- **dev** — local (Docker Compose) ou cluster k8s de desenvolvimento
- **staging** — cloud (AWS/Azure/GCP) com Terraform + Kubernetes
- **prod** — cloud com Terraform + Kubernetes

---

## Deploy local (Docker Compose)

Todo o stack roda em Docker com namespace **zentriz-genesis** (project name do Compose). Configuração: [docker-compose.yml](../../docker-compose.yml).

### Script deploy-docker.sh (recomendado)

O script [deploy-docker.sh](../../deploy-docker.sh) na raiz do repositório cria, destrói ou atualiza o ambiente Docker de forma resiliente (valida compose, garante `.env`, trata falhas de subida).

**Uso** (execute na raiz do repo):

| Parâmetro    | Ação |
|-------------|------|
| *(nenhum)*  | **Atualizar**: garante `.env`, valida [docker-compose.yml](../../docker-compose.yml), faz `up -d --build`. Use após mudanças no código ou no compose. |
| `--create`  | **Criar**: garante [.env](SECRETS_AND_ENV.md) (cópia de [.env.example](../../.env.example) se não existir), valida o compose e sobe o stack (build + up). |
| `--destroy`| **Destruir**: para e remove containers e redes do projeto (volumes preservados). |

**Exemplos:**

```bash
# Tornar executável (uma vez)
chmod +x deploy-docker.sh

# Atualizar ambiente (subir ou rebuild)
./deploy-docker.sh

# Criar do zero (garante .env e sobe)
./deploy-docker.sh --create

# Destruir ambiente
./deploy-docker.sh --destroy
```

**Pré-requisitos:** Docker e Docker Compose instalados; o script usa `docker compose` (v2) com fallback para `docker-compose` (v1). Variáveis: [.env.example](../../.env.example) e [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).

---

### Comandos manuais (docker compose)

**Importante:** execute sempre na **raiz do repositório** (onde está o `docker-compose.yml`). Assim o Compose usa o project name **zentriz-genesis** definido no arquivo e os containers aparecem com esse prefixo.

Se preferir não usar o script:

```bash
# Na raiz do repo
cd /caminho/para/zentriz-genesis

# Subir todos os serviços
docker compose up -d --build

# Listar containers do projeto (devem aparecer zentriz-genesis-api-1, zentriz-genesis-genesis-web-1, etc.)
docker compose ps
# ou, de qualquer pasta, com project name explícito:
docker compose -f docker-compose.yml --project-name zentriz-genesis ps

# Ver todos os containers do projeto no Docker
docker ps --filter "label=com.docker.compose.project=zentriz-genesis"

# Ver logs
docker compose logs -f

# Parar
docker compose down
```

**Se os containers não aparecem:** confirme que está na raiz do repo e que o project name é `zentriz-genesis`. Se você subiu de outra pasta, o project name pode ser o nome da pasta; use `docker ps -a` e procure por nomes como `zentriz-genesis-genesis-web-1` ou rode `./deploy-docker.sh` na raiz.

### Serviços e portas

| Serviço          | Porta | Descrição |
|------------------|-------|-----------|
| api              | 3000  | API do produto (Voucher) e Genesis (projetos, tasks, accept, diálogo, auth) |
| genesis-web      | 3001  | Portal web (genesis.zentriz.com.br) — React, Next.js, MUI, MobX; Aceitar projeto / Parar |
| runner           | 8001  | Orquestrador: Fase 1 (Spec→Engineer→CTO→PM) + Monitor Loop (Dev/QA/DevOps) até aceite ou parada |
| agents           | 8000  | Agentes (Engineer, CTO, PM, Monitor, Dev, QA, DevOps; futuramente Web, Mobile) — LLM |
| postgres         | 5432  | PostgreSQL (fonte de verdade) |
| redis            | 6379  | Cache / sessões |

Variáveis de ambiente vêm do [.env](../../.env) na raiz (copie de [.env.example](../../.env.example)); ver [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md). Usuários padrão do portal e credenciais: [context/CONTEXT.md](../context/CONTEXT.md) ou [services/api-node/README.md](../../applications/services/api-node/README.md).

### Conceitos do ambiente local

- **Quem inicia o fluxo:** o usuário inicia pelo portal; a API dispara o [runner](../../applications/orchestrator/runner.py). Com API e PROJECT_ID, o runner executa **Fase 1** (Spec → Engineer → CTO → PM Backend), faz seed de tarefas e entra no **Monitor Loop** (Fase 2), acionando Dev/QA/DevOps até o usuário **aceitar** o projeto ou **parar**. Ver [orchestrator/README.md](../../applications/orchestrator/README.md) e [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).
- **Serviço agents:** um único serviço Docker ([agents](../docker-compose.yml)) expõe **todos os agentes** (Engineer, CTO, PM Backend, Monitor Backend, Dev Backend, QA Backend, DevOps Docker; futuramente Web, Mobile) na mesma instância. Endpoints HTTP em [orchestrator/agents/server.py](../../applications/orchestrator/agents/server.py); detalhes em [orchestrator/agents/README.md](../../applications/orchestrator/agents/README.md).
- **Nomes dos containers (ex.: postgres-1):** o Docker Compose nomeia cada container como `{project}-{service}-{réplica}`. O sufixo `-1` é o índice da réplica (primeira instância). Com múltiplas réplicas (ex.: `docker compose up -d --scale api=3`) surgiriam api-1, api-2, api-3.

### Runner do orquestrador (CLI)

Fluxo sequencial (sem API/PROJECT_ID): spec → Engineer → CTO → PM Backend → (opcionalmente Dev/QA/Monitor/DevOps), com estado em `orchestrator/state/`. Na raiz do repo (com `CLAUDE_API_KEY` no `.env`):

```bash
pip install -r applications/orchestrator/agents/requirements.txt
PYTHONPATH=applications python -m orchestrator.runner --spec project/spec/PRODUCT_SPEC.md
```

Quando o runner for invocado pelo portal (job associado a um projeto), a API injeta **API_BASE_URL**, **PROJECT_ID** e **GENESIS_API_TOKEN**. O runner executa **Fase 1** (até PM Backend), faz **seed de tarefas** (`POST /api/projects/:id/tasks`) e entra no **Monitor Loop**: lê projeto e tasks, aciona Dev/QA/DevOps, atualiza task e diálogo; repete até status `accepted` (usuário clicou "Aceitar projeto") ou `stopped` (SIGTERM). Persiste `started_at` ao iniciar e `completed_at`/`status` ao encerrar. Ver [orchestrator/runner.py](../../applications/orchestrator/runner.py) e [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).

Ver [orchestrator/README.md](../../applications/orchestrator/README.md).

### Fluxo de spec (upload → conversão → CTO)

1. **Portal (genesis-web):** o usuário envia um ou mais arquivos de spec (.md, .txt, .doc, .docx, .pdf) na tela "Enviar spec ao CTO".
2. **API:** `POST /api/specs` recebe os arquivos (multipart), persiste em disco e registra o projeto; se houver arquivos não-.md, o status do projeto fica `pending_conversion`.
3. **Conversor (orquestrador):** um job ou pipeline processa arquivos não-.md e gera Markdown (módulo [orchestrator/spec_converter](../../applications/orchestrator/spec_converter)).
4. **Runner/CTO:** o fluxo CTO (e demais agentes) consome sempre o conteúdo em Markdown.

Detalhes dos formatos aceitos, boas práticas e referência ao conversor: [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).

---

## Deploy em Kubernetes (staging / prod)

Manifests em [k8s/](../../project/k8s/). Namespace: **zentriz-genesis**.

### Aplicar manifests

```bash
# Namespace primeiro
kubectl apply -f project/k8s/namespace.yaml

# Demais recursos (Deployment, Service, etc.)
kubectl apply -f project/k8s/api-deployment.yaml

# Ou aplicar tudo
kubectl apply -f project/k8s/
```

### Integração com Terraform

O Terraform em [infra/aws/](../../project/infra/aws/) (e futuramente azure/, gcp/) provisiona a infra (VPC, EKS/AKS/GKE, etc.). Os manifests em `k8s/` podem ser aplicados manualmente ou via Terraform/Helm após o cluster existir.

---

## CI/CD

Pipeline mínimo: **lint → test → build** (e opcionalmente build de imagem e push).

- Workflows em [.github/workflows/](../../.github/workflows/) (quando existirem).
- Cada serviço (api-node, agentes Python) deve ter lint e testes; o pipeline executa em cada push/PR.

---

## Observabilidade

- Logs estruturados (JSON) e correlação por `request_id` (NFR-03).
- Endpoint de healthcheck: `/health` ou `/api/health` na API.
- **Smoke test pós-deploy**: [tests/smoke/api_smoke_test.sh](../../project/tests/smoke/api_smoke_test.sh).
  - Rode com a API no ar (local ou Docker): `./tests/smoke/api_smoke_test.sh`
  - Ou com URL explícita: `API_BASE_URL=http://localhost:3000 ./tests/smoke/api_smoke_test.sh`
  - Evidência de smoke pós-deploy atende ao DoD DevOps.

---

## Rollback

- **Docker Compose**: `docker compose down` e subir versão anterior da imagem ou do código (rebuild).
- **Kubernetes**: `kubectl rollout undo deployment/api -n zentriz-genesis` (ou recurso afetado).

---

## Responsável (DevOps por cloud)

- Base (Docker, Terraform, k8s): [agents/devops/docker/](../../applications/agents/devops/docker/)
- AWS: [agents/devops/aws/](../../applications/agents/devops/aws/)
- Azure: [agents/devops/azure/](../../applications/agents/devops/azure/)
- GCP: [agents/devops/gcp/](../../applications/agents/devops/gcp/)

DoD: [contracts/devops_definition_of_done.md](../../applications/contracts/devops_definition_of_done.md).
