# API Contract (Modelo)

## Convenções

- Base URL: /api
- **Autenticação**: Bearer token após login. Header: `Authorization: Bearer <token>`. Endpoint de login: `POST /api/auth/login`.
- Erros: JSON padrão `{ code, message, details, request_id }`

## Endpoints (futuros / em definição)

- **Auth**: `POST /api/auth/login` (body: email, password) → `{ token, user, tenant? }`.
- **Tenants**: `GET /api/tenants`, `GET /api/tenants/:id`, `POST/PUT /api/tenants` (Zentriz).
- **Users**: `GET /api/users` (lista; escopo por tenant ou global conforme role). `POST /api/users` — cadastro de usuário (apenas tenant_admin ou zentriz_admin); body: `email`, `name`, `password`, `tenant_id?`, `role`. **Regras de segurança**: senha mínimo 8 e máximo 128 caracteres; e-mail válido; nome mínimo 2 caracteres; senha armazenada com hash (bcrypt). Respostas de erro: `{ code, message }` (ex.: `BAD_REQUEST`, `CONFLICT` e-mail já cadastrado).
- **Projects**: `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects`, `PATCH /api/projects/:id`. No PATCH, body opcional: `status`, `started_at`, `completed_at`, `charter_summary`, `backlog_summary`; `status` pode ser `accepted` (aceite pelo usuário; estado final). **Tasks**: `GET /api/projects/:id/tasks` (lista tarefas do projeto); `POST /api/projects/:id/tasks` (body: `{ tasks: [{ task_id, module?, owner_role, requirements?, status? }] }` — seed/upsert); `PATCH /api/projects/:id/tasks/:taskId` (body: `status?`, `artifacts_ref?`, `evidence?` — usado pelo Monitor Loop). **Aceite**: `POST /api/projects/:id/accept` — marca o projeto como aceito pelo usuário (`status = accepted`); permitido quando status é `running`, `completed` ou `stopped`; o Monitor Loop encerra ao detectar `accepted`. O runner envia `started_at` ao iniciar e, no fluxo sem Monitor Loop, `completed_at` + `status: completed` ao concluir.
- **Upload de spec**: `POST /api/specs` (multipart/form-data) — um ou mais arquivos; formatos aceitos: **.md, .txt, .doc, .docx, .pdf**. Resposta: `{ projectId, status, message }`; `status` pode ser `spec_submitted` ou `pending_conversion` quando houver arquivos não-.md (conversão a cargo do orquestrador). Fluxo completo: upload → conversão para .md (quando necessário) → runner/CTO. Ver [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
- **Financeiro (RFC-0002 Parte B — F1/F3)**: exclusivo de `zentriz_admin` (o Financeiro é função da conta de gestão; o guard de autoria NÃO se aplica). Dinheiro sempre em centavos inteiros; moeda única `BRL` nesta fase. Endpoints sob `/api/finance`:
  - **Contas bancárias (empresa recebedora)**: `GET /api/finance/bank-accounts`; `POST` (body: `label`, `bankName` obrigatórios; opcionais `bankCode`, `agency`, `account`, `accountType∈{checking,savings}`, `pixKey`, `pixKeyType`, `holderName`, `holderDocument`, `isDefault`); `PATCH /:id`; `DELETE /:id` (soft-delete → `active=false`). No máximo uma conta padrão (`isDefault`).
  - **Cobranças**: `GET /api/finance/charges?tenantId=&status=&competence=`; `GET /:id` (inclui `payments[]`); `POST` (body: `tenantId`, `amountCents>0`, `kind∈{subscription,one_off,proration}` (default `one_off`), `competenceMonth` (YYYY-MM; obrigatório p/ assinatura), `dueDate?`, `description?`); `POST /generate-month` (body: `competence`; gera a assinatura da competência p/ tenants elegíveis — idempotente; inativos só na 1ª cobrança); `PATCH /:id` (cancelar via `status='canceled'` se não paga; ajuste de campos só enquanto `draft` — imutabilidade M5). Status: `draft|open|paid|partially_paid|overdue|canceled|refunded`.
  - **Pagamentos (baixa manual)**: `GET /api/finance/payments?tenantId=&chargeId=`; `POST` (body: `chargeId`, `amountCents>0`, `method∈{pix,boleto,card,transfer,cash,manual}`, `receivedAt?`, `bankAccountId?`, `reference?`, `notes?`) — recalcula o status da cobrança (único escritor); só aceita cobrança em `open|overdue|partially_paid`. Resposta: `{ payment, charge, tenantActivated:boolean }` — **F2**: quando a baixa quita uma cobrança de assinatura (`kind='subscription'`) e não resta assinatura vencida, o tenant é reativado (`inactive`/`suspended` → `active`) e `tenantActivated=true`; cobrança avulsa nunca ativa.
  - **Sumário**: `GET /api/finance/summary` → `{ currency:'BRL', mrrCents, openCents, openCount, overdueCents, overdueCount, receivedThisMonthCents, receivedThisMonthCount }`. `openCents`/`overdueCents` refletem o valor **a receber** (valor − já pago).
  - **Notas fiscais internas (F3, MVP interno)**: `GET /api/finance/invoices?tenantId=&status=&competence=`; `GET /:id`; `POST` (body: `chargeId`) — emite a nota a partir de uma cobrança **`paid`**, derivando `tenantId`/`amountCents`/`competenceMonth`/`description` da própria cobrança; no máximo **uma** nota `issued` por cobrança (dupla emissão → `409`); a cobrança precisa estar `paid` (senão `409`). `POST /:id/cancel` cancela uma nota `issued` (libera reemissão). A emissão passa por uma porta `InvoiceProvider` (Ports & Adapters) — em F3 o adaptador é um **stub interno** (`provider='internal'`, `providerRef='INT-<nº 6 dígitos>'`), **sem integração NFS-e municipal e sem certificado A1** (isso é F4, que só troca o adaptador). Numeração sequencial própria (`invoice_number_seq`). Status: `issued|canceled`. Auditado em `finance_audit` (`entity_type='invoice'`).
- **Ciclo de vida da assinatura (RFC-0002 Parte B — F2)**:
  - **Job periódico (billing worker)**: cobranças `open`/`partially_paid` com `due_date` passado (fuso `America/Sao_Paulo`) → `overdue`; tenant `active` com assinatura `overdue` além da carência (`FINANCE_SUSPEND_GRACE_DAYS`, default 3d) → `suspended`. Reativação nunca ocorre no job (só por pagamento).
  - **Gate de inadimplência (H3)**: o `authMiddleware` revalida o `status` do tenant a cada requisição (cache curto de 30s, invalidação cross-instância via `LISTEN/NOTIFY`). Um token válido cujo tenant está `suspended`/`inactive` recebe **`403 { code:"TENANT_INACTIVE" }`**. **Isentos** (nunca bloqueados): `zentriz_admin` (master, `tenantId=null`); tokens de máquina do runner (claim `svc:"runner"`, cunhados só no servidor ao despachar o pipeline — RFC H1, callbacks do orquestrador jamais são derrubados); tokens `deploy-callback`. Fail-open em falha de lookup do status. Kill-switch de emergência: env `H3_TENANT_STATUS_GATE=off`.
  - **H2 (onboarding)**: `POST /api/signup` emite, no mesmo COMMIT, a cobrança de assinatura inicial (`status=open`) do tenant recém-criado quando o plano tem preço > 0.

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
