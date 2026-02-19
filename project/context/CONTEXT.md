# Contexto — Estado Atual do Projeto (Zentriz Genesis)

> **Uso**: Ponto único de contexto sobre o que foi realizado, como rodar e onde está documentado. Para visão geral do produto e atores, use [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

---

## 1. Atividades já realizadas

### Documentação (Fase 0)
- **[docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md)**: envio de spec ao CTO, formatos aceitos (.md preferencial, .txt, .doc/.docx, .pdf), múltiplos arquivos, conversor para Markdown, fluxo e boas práticas.
- Atualizados: PORTAL_TENANTS_AND_PLANS, ORCHESTRATION_GUIDE, API_CONTRACT, GENESIS_WEB_CONTEXT, PLAN_PORTAL_GENESIS com referências a spec multi-arquivo e ao conversor.

### API (services/api-node) — Fase 1
- **Banco**: PostgreSQL (tabelas `plans`, `tenants`, `users`, `projects`, `project_spec_files`). Schema em `src/db/schema.sql`; `initDb()` na subida; `seedIfEmpty()` + `ensureZentrizAdmin()` + `ensureTenantDemoUsers()` garantem usuários com senhas hasheadas.
- **Auth**: `POST /api/auth/login` (email, password) → `{ token, user, tenant? }`. Middleware Bearer; JWT + bcrypt.
- **Rotas**: `GET/POST/PATCH /api/projects`, `GET/POST/PATCH /api/projects/:id/tasks` (tarefas do pipeline; PATCH por task_id), `POST /api/projects/:id/accept` (marca projeto como aceito pelo usuário; status `accepted`), `GET /api/projects/:id/artifacts` (documentos quando `PROJECT_FILES_ROOT` definido), `POST /api/specs` (multipart, multi-arquivo .md/.txt/.doc/.docx/.pdf), `GET/POST /api/users`, `GET /api/tenants`. PATCH projects aceita `started_at`, `completed_at`, `status`, `charter_summary`; PATCH não permite alterar para `accepted` (apenas via POST accept).
- **Segurança**: cadastro de usuário (`POST /api/users`) com senha mínimo 8 e máximo 128 caracteres, validação de e-mail, hash bcrypt; apenas tenant_admin ou zentriz_admin podem criar usuários.
- **CORS**: `credentials: true` e `allowedHeaders` para o portal em localhost:3001.

### Conversor de spec (orchestrator) — Fase 2
- **orchestrator/spec_converter/**: converte .txt, .doc/.docx, .pdf → Markdown (python-docx, PyMuPDF). Função `convert_to_markdown(input_path, output_path=None)`. Testes em `test_converter.py`.

### Portal genesis-web — Fase 3
- **Auth**: login via `POST /api/auth/login`; token e user/tenant em localStorage; header `Authorization: Bearer` em todas as requisições.
- **Projetos**: listagem e detalhe via API; tipos com `startedAt`/`completedAt`.
- **Três telas de login** com discriminação por role: `/login` (user), `/login/tenant` (tenant_admin), `/login/genesis` (zentriz_admin). Após login, se o role não corresponder à tela, exibe mensagem orientando a usar a tela correta.
- **Tela "Enviar spec ao CTO"**: upload de um ou mais arquivos (.md, .txt, .doc, .docx, .pdf), título opcional, envio multipart para `POST /api/specs`; feedback com link para o projeto e aviso quando `pending_conversion`.
- **Erros da API**: exibição apenas do campo `message` (não JSON bruto).

### Runner e pipeline — Fase 4
- **Runner** ([orchestrator/runner.py](../../applications/orchestrator/runner.py)): quando `API_BASE_URL`, `PROJECT_ID` e `GENESIS_API_TOKEN` estão definidos, executa **duas fases**. **Fase 1**: Spec → Engineer → CTO → PM Backend (charter e backlog); em seguida faz **seed de tarefas** (`POST /api/projects/:id/tasks`) e entra no **Monitor Loop** (Fase 2). **Fase 2**: no mesmo processo, loop que lê estado do projeto e das tasks (`GET /api/projects/:id`, `GET /api/projects/:id/tasks`); se status for `accepted` ou `stopped` (ou SIGTERM), encerra; senão decide próximo agente (Dev, QA ou DevOps), invoca, atualiza task e diálogo; repete. **Parada**: usuário **aceita o projeto** no portal (`POST /api/projects/:id/accept`) ou **para** o pipeline (SIGTERM). Sem API/PROJECT_ID, o runner segue o fluxo sequencial antigo (Spec → … → PM Backend ou até DevOps conforme `PIPELINE_FULL_STACK`). Persiste `started_at`/`completed_at`/`status` e diálogo em `project_dialogue`; com `PROJECT_FILES_ROOT`, documentos em `<root>/<project_id>/docs/` e artefatos em `.../project/`. Ver [docs/AGENTS_AND_LLM_FLOW.md](../docs/AGENTS_AND_LLM_FLOW.md), [docs/ORCHESTRATOR_BLUEPRINT.md](../docs/ORCHESTRATOR_BLUEPRINT.md) e [docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](../docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md).
- **Testes**: API (Vitest — login, projects, upload spec); conversor (pytest); smoke test em [tests/smoke/api_smoke_test.sh](../../project/tests/smoke/api_smoke_test.sh).
- **Docs**: DEPLOYMENT e API_CONTRACT atualizados com fluxo de spec e referência a SPEC_SUBMISSION_AND_FORMATS.

---

## 2. Stack e serviços (Docker)

| Serviço        | Porta | Descrição |
|----------------|-------|-----------|
| api            | 3000  | API Node (Fastify, Postgres, auth, projects, specs, artifacts, users, tenants) |
| genesis-web    | 3001  | Portal Next.js + MUI + MobX |
| runner         | 8001  | Orquestrador: Fase 1 (Spec→Engineer→CTO→PM) + Monitor Loop (Dev/QA/DevOps) até aceite ou parada; PROJECT_FILES_ROOT para docs por projeto |
| agents         | 8000  | Agentes (Engineer, CTO, PM, Dev, QA, DevOps, Monitor; futuramente Web, Mobile) — LLM |
| postgres       | 5432  | PostgreSQL |
| redis          | 6379  | Cache / sessões |

Deploy local: na raiz, `./deploy-docker.sh` ou `docker compose up -d --build`. Ver [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

---

## 3. Usuários padrão e credenciais

Criados/atualizados pelo seed da API na subida. **Alterar senhas em produção.**

| Tela            | E-mail             | Senha         | Role          |
|-----------------|--------------------|---------------|---------------|
| `/login/genesis`| admin@zentriz.com  | #Jean@2026!   | zentriz_admin |
| `/login/tenant` | admin@tenant.com  | #Tenant@2026! | tenant_admin  |
| `/login`        | user@tenant.com   | #User@2026!   | user          |

`user@tenant.com` e `admin@tenant.com` pertencem ao mesmo tenant (Tenant Demo). Detalhes: [services/api-node/README.md](../../applications/services/api-node/README.md), [docs/SECRETS_AND_ENV.md](../docs/SECRETS_AND_ENV.md).

---

## 4. Como rodar

```bash
# Na raiz do repositório
./deploy-docker.sh          # ou: docker compose up -d --build

# Portal
open http://localhost:3001  # login conforme role (use uma das três URLs de login)

# API
curl http://localhost:3000/health
```

Variáveis: [.env](../../.env) (copiar de [.env.example](../../.env.example)); ver [docs/SECRETS_AND_ENV.md](../docs/SECRETS_AND_ENV.md).

---

## 5. Documentos relacionados

| Assunto              | Documento |
|----------------------|-----------|
| Visão geral do projeto | [context/PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) |
| Portal genesis-web   | [context/GENESIS_WEB_CONTEXT.md](GENESIS_WEB_CONTEXT.md) |
| Pipeline e agentes (fluxo LLM) | [docs/AGENTS_AND_LLM_FLOW.md](../docs/AGENTS_AND_LLM_FLOW.md) |
| Pipeline squad completa e storage | [docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md](../docs/PIPELINE_FULL_STACK_IMPLEMENTATION_PLAN.md) |
| API e usuários       | [services/api-node/README.md](../../applications/services/api-node/README.md) |
| Contrato da API      | [docs/API_CONTRACT.md](../docs/API_CONTRACT.md) |
| Deploy               | [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) |
| Envio de spec        | [docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md) |
| Plano do portal      | [docs/PLAN_PORTAL_GENESIS.md](../docs/PLAN_PORTAL_GENESIS.md) |
| Referência rápida    | [context/QUICK_REFERENCE.md](QUICK_REFERENCE.md) |

---

*Criado em 2026-02-17 — Zentriz Genesis. Atualize quando houver mudanças relevantes no estado do projeto.*
