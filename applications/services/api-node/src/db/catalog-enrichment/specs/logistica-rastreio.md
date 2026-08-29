# Sistema de Rastreamento de Entregas

## 0. Metadados
- **Produto:** TrackFlow — plataforma de rastreamento de entregas com ingestão de eventos e notificações automatizadas
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Centralizar rastreamento de entregas de múltiplas transportadoras com linha do tempo de eventos, página pública de consulta e notificações em tempo real aos clientes.

## 2. Personas
- Operador logístico — integra eventos de status de transportadoras via API.
- Lojista — acompanha entregas de pedidos da loja e recebe alertas de problemas.
- Cliente final — consulta status de sua entrega em página pública sem login.

## 3. Requisitos Funcionais (FR)

### FR-01 — Ingestão de eventos via API
DADO uma transportadora integrada, QUANDO envia evento de status (postado, em trânsito, entregue) com código de rastreio e timestamp via POST, ENTÃO o sistema persiste o evento e atualiza status do envio em até 5 segundos.

### FR-02 — Linha do tempo de rastreio
DADO um envio com múltiplos eventos registrados, QUANDO o operador consulta GET /shipments/:code/timeline, ENTÃO retorna lista cronológica de eventos com localização e descrição.

### FR-03 — Página pública de rastreio
DADO um código de rastreio válido, QUANDO o cliente final acessa GET /track/:code sem autenticação, ENTÃO carrega página HTML com status atual e linha do tempo completa.

### FR-04 — Notificação ao cliente em cada evento
DADO um envio com e-mail ou telefone de destinatário, QUANDO um novo evento é registrado, ENTÃO o sistema envia notificação via e-mail ou SMS em até 2 minutos.

### FR-05 — Alerta de atraso ou exceção
DADO um envio com prazo de entrega definido, QUANDO o prazo é ultrapassado sem evento de entrega, ENTÃO o sistema dispara alerta ao lojista com sugestão de ação.

### FR-06 — API de webhooks para lojistas
DADO um lojista cadastrado com URL de webhook, QUANDO um evento é registrado para envio de sua loja, ENTÃO o sistema envia POST ao webhook com payload JSON do evento.

## 4. Requisitos Não-Funcionais
- API de ingestão com throughput de 1.000 eventos/segundo; latência < 200ms p95.
- Fila de notificações com retry exponencial (3 tentativas, backoff de 1/2/5 minutos); DLQ para falhas permanentes.
- Página pública com cache de 1 minuto; disponibilidade 99,9%.
- Dados de contato do cliente (e-mail, telefone) nunca expostos na API pública; apenas em webhooks autenticados.

## 5. Regras de Negócio
- Evento duplicado (mesmo código de rastreio + timestamp + status) é descartado via chave de idempotência.
- Notificação por SMS só é enviada para eventos críticos (saiu para entrega, entregue, exceção); demais eventos só por e-mail.
- Webhook com 3 falhas consecutivas é desabilitado e lojista recebe alerta; pode reativar manualmente.
- Prazo de entrega é calculado a partir do primeiro evento "postado" + SLA da transportadora (configurável).

## 6. Modelo de Dados
- shipments(id, tracking_code, carrier_id, store_id, recipient_email, recipient_phone, expected_delivery_date, current_status, created_at)
- tracking_events(id, shipment_id, event_type, description, location, timestamp, idempotency_key)
- carriers(id, name, api_integration_type, sla_days)
- stores(id, name, webhook_url, webhook_secret)
- notification_queue(id, shipment_id, event_id, channel, recipient, status, retry_count, next_retry_at)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL para persistência; SQS ou RabbitMQ para fila de notificações.
- Workers assíncronos: Node.js ou Python para processamento de notificações e webhooks.
- Notificações: integração com SES (e-mail) e Twilio (SMS).
- Cache: Redis para página pública de rastreio e debounce de webhooks.
