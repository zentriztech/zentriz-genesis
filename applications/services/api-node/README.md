# API Node.js — Voucher (Zentriz Genesis)

API do produto de exemplo (Voucher MVP). Stack: TypeScript, Fastify, Vitest.

## Banco de dados

A API usa **PostgreSQL** (fonte de verdade). Tabelas: `plans`, `tenants`, `users`, `projects`, `project_spec_files`, `project_tasks`, `project_dialogue`. Projetos têm status incluindo `accepted` (aceite pelo usuário no portal). Schema em `src/db/schema.sql`. Na subida, `initDb()` aplica o schema e `seedIfEmpty()` cria um tenant demo e usuários iniciais.

**Usuários padrão (senhas hasheadas; alterar em produção):**

| Tela           | E-mail             | Senha         | Role          |
|----------------|--------------------|---------------|---------------|
| `/login/genesis` | `admin@zentriz.com` | `#Jean@2026!` | zentriz_admin |
| `/login/tenant`  | `admin@tenant.com` | `#Tenant@2026!` | tenant_admin  |
| `/login`         | `user@tenant.com`  | `#User@2026!`  | user          |

O seed garante que esses usuários existam com senhas hasheadas (cria ou atualiza a cada subida). `user@tenant.com` e `admin@tenant.com` pertencem ao mesmo tenant (Tenant Demo). Ver [SECRETS_AND_ENV.md](../../../project/docs/SECRETS_AND_ENV.md). Em produção, use `POST /api/users` para cadastro com **regras de segurança**: senha mínimo 8 caracteres, hash bcrypt; apenas tenant_admin ou zentriz_admin podem criar usuários.

### Projetos de exemplo (Genesis-Web)

Para popular 2 projetos de exemplo (um em desenvolvimento e um concluído) e logs de diálogo para testar a tela do Genesis-Web:

```bash
# Com Postgres acessível (ex.: docker compose up -d postgres)
PGHOST=localhost PGUSER=genesis PGPASSWORD=genesis_dev PGDATABASE=zentriz_genesis npm run seed:examples
```

Cria: **Portal de Vouchers (em desenvolvimento)** (status `dev_qa`) e **Sistema de Cadastro MVP (concluído)** (status `completed`), com várias entradas em `project_dialogue`. Faça login no portal (admin@tenant.com ou user@tenant.com) e abra os projetos para ver o diálogo da equipe.

## Endpoints

### Genesis (portal)

- `POST /api/auth/login` — login (email, password) → token + user
- `GET/POST/PATCH /api/projects` — projetos; PATCH com started_at, completed_at, status (não aceita `accepted` via PATCH)
- `GET/POST/PATCH /api/projects/:id/tasks` — tarefas do pipeline (PATCH por task_id)
- `POST /api/projects/:id/accept` — marcar projeto como aceito pelo usuário (status `accepted`); encerra o Monitor Loop
- `GET/POST /api/projects/:id/dialogue` — diálogo da equipe
- `POST /api/specs` — upload de spec (multipart)
- `GET/POST /api/users`, `GET /api/tenants`

### Voucher (produto de exemplo)

- `POST /api/vouchers` — criar voucher (FR-01)
- `GET /api/vouchers/:id` — consultar voucher (FR-02)
- `POST /api/vouchers/:id/redeem` — resgatar voucher (FR-03)
- `GET /api/admin/vouchers?page=&pageSize=` — listar vouchers paginado (FR-04)
- `GET /health`, `GET /api/health` — healthcheck

Contrato: [docs/API_CONTRACT.md](../../../project/docs/API_CONTRACT.md). Erros: `{ code, message, details?, request_id }`.

## Desenvolvimento

```bash
npm install
npm run dev          # watch com tsx
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run
```

## Docker

Build e run via [docker-compose](../../../docker-compose.yml) na raiz do projeto:

```bash
docker compose up -d api
```

Ou build local: `docker build -t zentriz-genesis-api .` e `docker run -p 3000:3000 zentriz-genesis-api`.

## Variáveis de ambiente

- `PORT` (default 3000)
- `HOST` (default 0.0.0.0)
- `API_BASE_URL` (para referência em smoke tests)

## Smoke test

Ver [tests/smoke/api_smoke_test.sh](../../../project/tests/smoke/api_smoke_test.sh). Use `API_BASE_URL=http://localhost:3000` (ou a URL do container) para rodar contra a API.
