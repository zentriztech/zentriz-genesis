# Secrets e variáveis de ambiente — Zentriz Genesis

> Onde e como guardar chaves (ex.: Claude API) e listagem completa das variáveis de ambiente iniciais.

---

## Regra de ouro

**Nunca commitar segredos no repositório.** Use variáveis de ambiente e arquivos ignorados pelo Git. O arquivo `.env` está no [.gitignore](../../.gitignore).

---

## Lista completa de variáveis (item 0)

| Variável | Obrigatório | Propósito | Exemplo / default |
|----------|-------------|-----------|-------------------|
| **CLAUDE_API_KEY** | Sim (para agentes) | Chave da API Anthropic; usada pelos agentes (CTO, PM, QA, DevOps, Monitor) para chamadas ao LLM. | (obter em console.anthropic.com) |
| **CLAUDE_MODEL** | Não | Modelo Claude a usar. | `claude-sonnet-4-6` |
| **ANTHROPIC_API_URL** | Não | URL base da API Anthropic (override; default da SDK). | (deixar vazio para default) |
| **DOCKER_NAMESPACE** | Não | Namespace do projeto para Docker e k8s (containers, redes, volumes). | `zentriz-genesis` |
| **API_BASE_URL** | Não (local) | URL base da API do produto (Voucher) para smoke tests e integrações. Usada pelo runner para PATCH/POST em projetos e diálogo. | `http://localhost:3000` |
| **LOG_LEVEL** | Não | Nível de log do runtime dos agentes (Python). | `INFO` |
| **REQUEST_TIMEOUT** | Não | Timeout (s): runner→agents HTTP e cada chamada à Claude. Recomendado **300** (repair loop pode fazer 3 chamadas LLM por agente). | `300` |
| **AGENT_HTTP_RETRY_ON_TIMEOUT** | Não | Número de tentativas do runner ao chamar agents em caso de timeout (retry apenas em timeout). | `2` |
| **CLAUDE_RETRY_ATTEMPTS** | Não | Número de tentativas (incl. retry) ao chamar Claude em falhas de rede/429/5xx. | `2` |
| **API_AGENTS_URL** | Não | Se definida, o runner chama os agentes via HTTP (ex.: `http://agents:8000`) em vez de import. | (vazio para import local) |
| **RUNNER_COMMAND** | Não (API) | Comando para iniciar o runner em background quando o portal dispara o pipeline (ex.: `python -m orchestrator.runner`). Requer Python e PYTHONPATH no ambiente. | (vazio) |
| **RUNNER_SERVICE_URL** | Não (API) | URL do serviço runner quando não usar subprocess; a API faz POST /run com projectId, specPath, token. | (vazio) |
| **REPO_ROOT** | Não (API) | Diretório raiz do repo (cwd do processo filho ao usar RUNNER_COMMAND). | (cwd da API) |
| **UPLOAD_DIR** | Não (API) | Diretório de upload de specs (path absoluto ou relativo ao cwd). | `./uploads` |
| **JWT_SECRET** | Não (dev) | Segredo para assinatura dos tokens JWT da API. | `zentriz-genesis-jwt-secret` |
| **PGHOST / PGUSER / PGPASSWORD / PGDATABASE** | Sim (API) | Conexão PostgreSQL. | Ver [docker-compose.yml](../../docker-compose.yml) |
| **RUNNER_COMMAND** | Não | Comando para iniciar o runner em subprocess (Opção A). Ex.: `python -m orchestrator.runner` com PYTHONPATH no env. Se definido, a API dispara o pipeline com `--spec-file` e env (API_BASE_URL, PROJECT_ID, GENESIS_API_TOKEN, CLAUDE_API_KEY, API_AGENTS_URL). | (vazio = usar RUNNER_SERVICE_URL) |
| **RUNNER_SERVICE_URL** | Não | URL do serviço runner (Opção B, ex.: Docker). A API faz POST a `{RUNNER_SERVICE_URL}/run` com projectId, specPath, apiBaseUrl, token. | (vazio = usar RUNNER_COMMAND) |
| **UPLOAD_DIR** | Não | Diretório onde a API grava uploads de spec (project_spec_files). Deve ser acessível ao runner se usar Opção A (mesmo host/volume). | `./uploads` ou `process.cwd()/uploads` |
| **RUNNER_SPEC_DIR** | Não | Opcional: diretório para a API copiar spec antes de passar path ao runner (quando API e runner não compartilham UPLOAD_DIR). | (não usado por padrão) |
| **API_AGENTS_URL** | Não (runner) | Se definida, o runner chama os agentes via HTTP (ex.: `http://agents:8000`) em vez de import. Endpoints: `/invoke/engineer`, `/invoke/cto`, `/invoke/pm`, `/invoke/dev`, `/invoke/qa`, `/invoke/monitor`, `/invoke/devops`. | (vazio = runner usa import local) |
| **PROJECT_ID** / **GENESIS_API_TOKEN** | (runner) | Definidos pela API ao disparar o pipeline. Runner usa para PATCH /api/projects/:id e POST /api/projects/:id/dialogue. Token JWT de curta duração (ex.: 1h). | (injetados pela API) |
| **PROJECT_FILES_ROOT** | Não (runner, API) | Raiz dos arquivos por projeto: `<root>/<project_id>/docs` e `<root>/<project_id>/project`. Documentos gerados pelos agentes são gravados com criador (spec, engineer, cto, pm, dev, qa, monitor, devops). No Docker use `/project-files` com volume; no host ex.: `/Users/mac/zentriz-files`. A API usa para GET /api/projects/:id/artifacts. **Para artefatos no host:** copie `docker-compose.override.example.yml` para `docker-compose.override.yml` (bind mount `/Users/mac/zentriz-files:/project-files`). | (vazio = runner não grava em disco por projeto) |
| **PIPELINE_FULL_STACK** | Não (runner) | Se `true`, executa após PM Backend também: Dev Backend, QA Backend, Monitor Backend, DevOps Docker. Se `false`, pipeline para em PM Backend. | `true` |
| **MONITOR_LOOP_INTERVAL** | Não (runner) | Intervalo em segundos entre ciclos do Monitor Loop (Fase 2), quando API e PROJECT_ID estão definidos. | `20` |
| **MAX_QA_REWORK** | Não (runner) | Máximo de vezes que uma tarefa pode receber QA_FAIL antes de ser forçada a DONE (evita loop infinito Dev→QA). Após N reworks, a tarefa é marcada como concluída. | `3` |

**Usuários padrão (portal):** criados/atualizados pelo seed da API. **Em produção, altere as senhas.** Ver tabela em [services/api-node/README.md](../services/api-node/README.md): Zentriz Admin `admin@zentriz.com` / `#Jean@2026!` (login/genesis); Admin tenant `admin@tenant.com` / `#Tenant@2026!` (login/tenant); Usuário `user@tenant.com` / `#User@2026!` (login).

Template: [.env.example](../.env.example). Copie para `.env` e preencha os valores.

---

## Local (desenvolvimento)

| O quê | Onde |
|------|------|
| Chave **Claude API** e demais segredos | Variáveis no arquivo **`.env`** na raiz do projeto |
| Configurações não sensíveis | Mesmo `.env` ou valores default no código |

**Passos:**

1. Copie o template: `cp .env.example .env`
2. Edite `.env` e preencha pelo menos `CLAUDE_API_KEY` (e outras variáveis conforme necessidade).
3. O arquivo `.env` **não** será commitado.

---

## Em cloud (staging / produção)

- Usar **secrets manager** do provedor (AWS Secrets Manager, Parameter Store, Azure Key Vault, GCP Secret Manager).
- Injetar no runtime como **variáveis de ambiente** (ex.: Kubernetes Secrets, Lambda/Cloud Run env).
- Nunca colocar chaves em código ou em repositório.

---

## Variáveis mínimas para "Agentes conversando com a LLM"

Para o pipeline (Spec → Engineer → CTO → PM Backend e, opcionalmente, Dev → QA → Monitor → DevOps) **com agentes chamando a API Claude**, no ambiente Docker são **obrigatórias** no `.env`:

| Variável | Obrigatório | Valor esperado |
|----------|-------------|----------------|
| **CLAUDE_API_KEY** | Sim | Chave da API Anthropic (geralmente começa com `sk-ant-`). Obtenha em https://console.anthropic.com/ |
| **CLAUDE_MODEL** | Recomendado | Modelo ativo, ex.: `claude-sonnet-4-6` (o antigo `claude-3-5-sonnet-20241022` foi descontinuado em out/2025 e retorna 404) |

As demais variáveis do `.env` (API_BASE_URL, NEXT_PUBLIC_API_BASE_URL, DOCKER_NAMESPACE, LOG_LEVEL, REQUEST_TIMEOUT) são opcionais ou têm default no `docker-compose.yml`. O `docker-compose` define internamente `API_AGENTS_URL` e `RUNNER_SERVICE_URL` para os serviços; não é necessário colocá-los no `.env` para o fluxo Docker.

**Depois de alterar o `.env`:** recrie os containers para que eles recebam as novas variáveis:  
`docker compose up -d --force-recreate agents runner`  
(ou `docker compose up -d --force-recreate` para todos os que usam `env_file: .env`).

**Conferir no container:**  
`docker compose exec agents curl -s http://127.0.0.1:8000/health` deve retornar `claude_model` e `claude_configured: true`. E em `docker compose logs agents` deve aparecer na primeira linha algo como `CLAUDE_MODEL=claude-sonnet-4-6 | CLAUDE_API_KEY (definida)`.

---

## Troubleshooting (Docker / pipeline)

- **Erro 500 "model: claude-3-5-sonnet-20241022" ou 404 da API Claude**  
  O modelo foi descontinuado. Defina `CLAUDE_MODEL=claude-sonnet-4-6` no `.env`, recrie os containers: `docker compose up -d --force-recreate agents runner` e inicie um **novo** pipeline (não reuse o diálogo de um run antigo).

- **Pipeline “parou” no Engineer ou erro "Connection error" / "SSL: UNEXPECTED_EOF_WHILE_READING"**  
  O container **agents** não conseguiu completar o TLS até a API da Anthropic. Se no **host** `curl -sI https://api.anthropic.com` funciona mas **dentro do container** falha com o mesmo erro, a saída HTTPS do container está diferente (ex.: Docker Desktop no Mac, VPN, proxy). **O que fazer:** (1) Testar: `docker compose exec agents curl -sI https://api.anthropic.com` — se der TLS error, o problema é rede/SSL do container. (2) **Alternativa:** rodar os agentes **no host** (onde o TLS funciona): na raiz do repo, `PYTHONPATH=applications python -m uvicorn orchestrator.agents.server:app --host 0.0.0.0 --port 8000`; no `docker-compose.yml` no serviço **runner** use `API_AGENTS_URL=http://host.docker.internal:8000` e em **services.runner** adicione `extra_hosts: - "host.docker.internal:host-gateway"`; recrie o runner. Assim o runner (no Docker) chama os agentes no host, que por sua vez chamam a Claude. (3) Se atrás de proxy, definir `HTTPS_PROXY`/`HTTP_PROXY` no `.env` e no serviço agents. (4) Ver logs: `docker compose logs agents`.

- **Ver logs do pipeline**  
  O runner dispara o fluxo em background. Erros do processo filho (Python) aparecem em `docker compose logs runner`. Para o serviço que chama o Claude: `docker compose logs agents`.

---

## Resumo

| Ambiente | Onde guardar |
|----------|--------------|
| **Local** | Arquivo `.env` (gitignored); variáveis conforme tabela acima |
| **Cloud** | Secrets manager do provedor → env vars no runtime |

Ver também: [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) (seção 13).
