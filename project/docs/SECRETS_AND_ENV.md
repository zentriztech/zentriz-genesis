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
| **CLAUDE_MODEL** | Não | Modelo Claude a usar. | `claude-3-5-sonnet-20241022` |
| **ANTHROPIC_API_URL** | Não | URL base da API Anthropic (override; default da SDK). | (deixar vazio para default) |
| **DOCKER_NAMESPACE** | Não | Namespace do projeto para Docker e k8s (containers, redes, volumes). | `zentriz-genesis` |
| **API_BASE_URL** | Não (local) | URL base da API do produto (Voucher) para smoke tests e integrações. Usada pelo runner para PATCH/POST em projetos e diálogo. | `http://localhost:3000` |
| **LOG_LEVEL** | Não | Nível de log do runtime dos agentes (Python). | `INFO` |
| **REQUEST_TIMEOUT** | Não | Timeout em segundos para chamadas à API Claude. | `120` |
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
| **API_AGENTS_URL** | Não (runner) | Se definida, o runner chama os agentes via HTTP (ex.: `http://agents:8000`) em vez de import. Endpoints: `/invoke/engineer`, `/invoke/cto`, `/invoke` (PM). | (vazio = runner usa import local) |
| **PROJECT_ID** / **GENESIS_API_TOKEN** | (runner) | Definidos pela API ao disparar o pipeline. Runner usa para PATCH /api/projects/:id e POST /api/projects/:id/dialogue. Token JWT de curta duração (ex.: 1h). | (injetados pela API) |

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

## Troubleshooting (Docker / pipeline)

- **Pipeline “parou” no Engineer ou erro "Connection error" / "SSL: UNEXPECTED_EOF_WHILE_READING"**  
  O container **agents** (ou o processo que chama a API Claude) não conseguiu estabelecer conexão TLS com a API da Anthropic. Possíveis causas: rede instável, proxy corporativo ou firewall alterando TLS, DNS. Verifique conectividade de dentro do container (`docker compose exec agents curl -sI https://api.anthropic.com`) e se `CLAUDE_API_KEY` está definida no `.env` e repassada aos serviços (api e runner usam `env_file: .env`). Os logs do agente aparecem em `docker compose logs agents`.

- **Ver logs do pipeline**  
  O runner dispara o fluxo em background. Erros do processo filho (Python) aparecem em `docker compose logs runner`. Para o serviço que chama o Claude: `docker compose logs agents`.

---

## Resumo

| Ambiente | Onde guardar |
|----------|--------------|
| **Local** | Arquivo `.env` (gitignored); variáveis conforme tabela acima |
| **Cloud** | Secrets manager do provedor → env vars no runtime |

Ver também: [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) (seção 13).
