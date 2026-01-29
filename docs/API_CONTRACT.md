# API Contract (Modelo)
## Convenções
- Base URL: /api
- Autenticação: (definir)
- Erros: JSON padrão { code, message, details, request_id }

## Endpoints
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
