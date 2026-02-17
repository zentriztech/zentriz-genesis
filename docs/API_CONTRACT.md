# API Contract (Modelo)

## Convenções

- Base URL: /api
- **Autenticação**: Bearer token após login. Header: `Authorization: Bearer <token>`. Endpoint de login: `POST /api/auth/login`.
- Erros: JSON padrão `{ code, message, details, request_id }`

## Endpoints (futuros / em definição)

- **Auth**: `POST /api/auth/login` (body: email, password) → `{ token, user, tenant? }`.
- **Tenants**: `GET /api/tenants`, `GET /api/tenants/:id`, `POST/PUT /api/tenants` (Zentriz).
- **Users**: `GET /api/users` (lista; escopo por tenant ou global conforme role). `POST /api/users` — cadastro de usuário (apenas tenant_admin ou zentriz_admin); body: `email`, `name`, `password`, `tenant_id?`, `role`. **Regras de segurança**: senha mínimo 8 e máximo 128 caracteres; e-mail válido; nome mínimo 2 caracteres; senha armazenada com hash (bcrypt). Respostas de erro: `{ code, message }` (ex.: `BAD_REQUEST`, `CONFLICT` e-mail já cadastrado).
- **Projects**: `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects`, `PATCH /api/projects/:id`. No PATCH, body opcional: `status`, `started_at`, `completed_at`, `charter_summary` (todos opcionais). O runner do orquestrador, quando configurado com `API_BASE_URL`, `PROJECT_ID` e `GENESIS_API_TOKEN`, envia `started_at` ao iniciar o pipeline e `completed_at` + `status: completed` ao concluir.
- **Upload de spec**: `POST /api/specs` (multipart/form-data) — um ou mais arquivos; formatos aceitos: **.md, .txt, .doc, .docx, .pdf**. Resposta: `{ projectId, status, message }`; `status` pode ser `spec_submitted` ou `pending_conversion` quando houver arquivos não-.md (conversão a cargo do orquestrador). Fluxo completo: upload → conversão para .md (quando necessário) → runner/CTO. Ver [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).

## Endpoints existentes
### POST /vouchers (FR-01)
Request:
- value: number
- recipient_name: string
- recipient_document: string

Response:
- voucherId: string
- status: ACTIVE

### GET /vouchers/{id} (FR-02)
### POST /vouchers/{id}/redeem (FR-03)
### GET /admin/vouchers?page=&pageSize= (FR-04)
