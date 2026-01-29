# Eventos do Orchestrator

Eventos padronizados para execução event-driven (EventBridge/SQS/Service Bus/PubSub).

## Padrão de envelope
- `event_id` (uuid)
- `event_type`
- `timestamp`
- `project_id`
- `request_id`
- `payload`

## Schemas
Veja `orchestrator/events/schemas/*.json`
