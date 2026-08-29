# Cobranças Pix

## 0. Metadados
- **Produto:** PixBill — emissão e conciliação automática de cobranças Pix para e-commerce e serviços
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
API de cobrança via Pix que gera QR Code dinâmico, monitora pagamentos em tempo real via webhook e concilia automaticamente, reduzindo inadimplência e tempo de confirmação de pagamento para segundos.

## 2. Personas
- Sistema e-commerce integrado — consome a API para gerar cobranças ao finalizar pedido.
- Cliente final — escaneia QR Code no app bancário e efetua pagamento Pix.
- Financeiro da empresa — consulta cobranças pagas, vencidas e aguardando pagamento para conciliação contábil.

## 3. Requisitos Funcionais (FR)
### FR-01 — Criação de cobrança com valor e vencimento
DADO um sistema integrado autenticado via API Key, QUANDO envia requisição POST /charges informando valor, vencimento e identificador de pedido, ENTÃO a API registra a cobrança com status "pending" e retorna o txid gerado.

### FR-02 — Geração de payload e QR Code Pix
DADO uma cobrança criada com status "pending", QUANDO o sistema integrado requisita GET /charges/:id/qrcode, ENTÃO a API consulta o provedor Pix (ex: Banco do Brasil API Pix), gera o payload Pix Copia e Cola e o QR Code codificado em base64, retornando ambos.

### FR-03 — Webhook de confirmação de pagamento
DADO o provedor Pix configurado com URL de webhook do PixBill, QUANDO um cliente efetua o pagamento no app bancário, ENTÃO o provedor notifica o PixBill via POST /webhooks/pix, o sistema valida a assinatura, localiza a cobrança pelo txid, atualiza status para "paid" e timestamp de pagamento, e notifica o sistema integrado via webhook cadastrado.

### FR-04 — Conciliação e transição de status
DADO cobranças com status "pending", QUANDO o sistema executa job de conciliação a cada 5 minutos, ENTÃO consulta o provedor Pix para confirmar pagamentos ainda não notificados, atualiza cobranças pagas e marca como "expired" aquelas cujo vencimento passou sem pagamento.

### FR-05 — Consulta de cobranças e histórico
DADO um sistema integrado autenticado, QUANDO requisita GET /charges com filtros de status, período e identificador externo, ENTÃO a API retorna lista paginada de cobranças com status, valor, datas de criação, vencimento e pagamento.

## 4. Requisitos Não-Funcionais
- Webhook de pagamento processado em < 1s; retry com backoff exponencial em caso de falha.
- Idempotência garantida por txid; requisições duplicadas retornam a mesma cobrança.
- API Key com rate limit de 100 req/min por cliente; disponibilidade 99,9%.
- Logs de webhook nunca expõem chaves ou payloads completos de provedor (apenas txid e status).

## 5. Regras de Negócio
- Uma cobrança só pode ser paga uma vez; tentativa de pagamento duplicado é rejeitada pelo provedor.
- Cobranças expiradas não aceitam pagamento; cliente deve solicitar nova cobrança.
- Valor mínimo R$0,01; valor máximo definido pelo limite do provedor Pix (ex: R$10.000,00 por transação).
- Conciliação automática tem precedência sobre webhook; sistema tolera atraso de notificação.

## 6. Modelo de Dados
- charges(id, txid, external_id, amount_cents, due_date, status, qrcode_payload, qrcode_image_base64, paid_at, created_at)
- payments(id, charge_id, txid, amount_cents, payer_document, paid_at, provider_raw_data_json)
- webhooks_log(id, charge_id, event_type, payload_json, signature, processed_at, status)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + Bull (job de conciliação). Integração: SDK do provedor Pix (BB, PagSeguro, Asaas). Auth via API Key com bcrypt.
