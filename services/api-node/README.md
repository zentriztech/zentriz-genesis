# API Node.js — Voucher (Zentriz Genesis)

API do produto de exemplo (Voucher MVP). Stack: TypeScript, Fastify, Vitest.

## Banco de dados

A API usa **PostgreSQL** (fonte de verdade). Tabelas: `plans`, `tenants`, `users`, `projects`, `project_spec_files`. Schema em `src/db/schema.sql`. Na subida, `initDb()` aplica o schema e `seedIfEmpty()` cria um tenant demo e usuários iniciais.

**Usuários padrão (senhas hasheadas; alterar em produção):**

| Tela           | E-mail             | Senha         | Role          |
|----------------|--------------------|---------------|---------------|
| `/login/genesis` | `admin@zentriz.com` | `#Jean@2026!` | zentriz_admin |
| `/login/tenant`  | `admin@tenant.com` | `#Tenant@2026!` | tenant_admin  |
| `/login`         | `user@tenant.com`  | `#User@2026!`  | user          |

O seed garante que esses usuários existam com senhas hasheadas (cria ou atualiza a cada subida). `user@tenant.com` e `admin@tenant.com` pertencem ao mesmo tenant (Tenant Demo). Ver [SECRETS_AND_ENV.md](../../docs/SECRETS_AND_ENV.md). Em produção, use `POST /api/users` para cadastro com **regras de segurança**: senha mínimo 8 caracteres, hash bcrypt; apenas tenant_admin ou zentriz_admin podem criar usuários.

## Endpoints

- `POST /api/vouchers` — criar voucher (FR-01)
- `GET /api/vouchers/:id` — consultar voucher (FR-02)
- `POST /api/vouchers/:id/redeem` — resgatar voucher (FR-03)
- `GET /api/admin/vouchers?page=&pageSize=` — listar vouchers paginado (FR-04)
- `GET /health`, `GET /api/health` — healthcheck

Contrato: [docs/API_CONTRACT.md](../../docs/API_CONTRACT.md). Erros: `{ code, message, details?, request_id }`.

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

Build e run via [docker-compose](../../docker-compose.yml) na raiz do projeto:

```bash
docker compose up -d api
```

Ou build local: `docker build -t zentriz-genesis-api .` e `docker run -p 3000:3000 zentriz-genesis-api`.

## Variáveis de ambiente

- `PORT` (default 3000)
- `HOST` (default 0.0.0.0)
- `API_BASE_URL` (para referência em smoke tests)

## Smoke test

Ver [tests/smoke/api_smoke_test.sh](../../tests/smoke/api_smoke_test.sh). Use `API_BASE_URL=http://localhost:3000` (ou a URL do container) para rodar contra a API.
