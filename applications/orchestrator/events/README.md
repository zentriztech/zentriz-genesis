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
Veja [orchestrator/events/schemas/](schemas/) — [event_envelope.json](schemas/event_envelope.json), [project.created.json](schemas/project.created.json), [task.assigned.json](schemas/task.assigned.json), [qa.failed.json](schemas/qa.failed.json), [qa.passed.json](schemas/qa.passed.json), [devops.deployed.json](schemas/devops.deployed.json), [monitor.alert.json](schemas/monitor.alert.json), [project.completed.json](schemas/project.completed.json), [module.planned.json](schemas/module.planned.json), [task.completed.json](schemas/task.completed.json)
