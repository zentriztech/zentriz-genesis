# Orchestrator Blueprint (Event-Driven)

## Objetivo
Permitir execução paralela e rastreável do fluxo:
CTO -> PM(s) -> (Dev + QA + DevOps) -> Monitor -> CTO.

## Entidades
- **Project**: id, spec_ref, status
- **Module**: backend/web/mobile/infra
- **Task**: id, module, owner_role, requirements (FR/NFR), status

## Padrão de eventos
- `project.created`
- `module.planned`
- `task.assigned`
- `task.completed`
- `qa.failed`
- `qa.passed`
- `devops.deployed`
- `monitor.alert`
- `project.completed`

## Implementação (exemplo AWS)
- EventBridge (bus)
- SQS (fila por role ou módulo)
- Lambdas (um handler por agente)
- DynamoDB (estado do projeto)
- CloudWatch (logs/metrics/alarms)

## Regras de execução
- PM gera backlog e emite `task.assigned` para Dev/QA/DevOps.
- QA pode emitir `qa.failed` e reabrir task do Dev.
- DevOps emite `devops.deployed` e dispara smoke tests.
- Monitor consome eventos e cria alertas.
- CTO consome consolidados e marca `project.completed`.

## Evidência
- Cada evento carrega `request_id` e links para artifacts/reports.
