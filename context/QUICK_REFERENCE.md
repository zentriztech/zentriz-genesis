# Zentriz Genesis — Referência Rápida

## Caminhos Essenciais

| O que | Onde |
|-------|------|
| Entrada do projeto | [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) |
| Guia de orquestração | [docs/ORCHESTRATION_GUIDE.md](../docs/ORCHESTRATION_GUIDE.md) |
| Blueprint de eventos | [docs/ORCHESTRATOR_BLUEPRINT.md](../docs/ORCHESTRATOR_BLUEPRINT.md) |
| State machine de tasks | [docs/TASK_STATE_MACHINE.md](../docs/TASK_STATE_MACHINE.md) |
| PM gera backlog | [docs/PM_AUTOBACKLOG_GUIDE.md](../docs/PM_AUTOBACKLOG_GUIDE.md) |
| DevOps por cloud | [docs/DEVOPS_SELECTION.md](../docs/DEVOPS_SELECTION.md) |
| DoD global | [contracts/global_definition_of_done.md](../contracts/global_definition_of_done.md) |
| DoD DevOps | [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md) |
| Próximos passos | [docs/NEXT_STEPS_REMINDER.md](../docs/NEXT_STEPS_REMINDER.md) |
| Status atual | [docs/STATUS.md](../docs/STATUS.md) |
| **ADRs** (decisões arquiteturais) | [docs/adr/](../docs/adr/) |
| **RFCs** (propostas) | [docs/rfc/](../docs/rfc/) |
| **Agentes consolidados** | [docs/AGENTS_CAPABILITIES.md](../docs/AGENTS_CAPABILITIES.md) |
| **Métricas de performance** | [docs/PERFORMANCE_METRICS.md](../docs/PERFORMANCE_METRICS.md) |
| **Scripts de manutenção** | [scripts/](../scripts/) |
| **Práticas de outros projetos** | [context/PRACTICES_FROM_OTHER_PROJECTS.md](PRACTICES_FROM_OTHER_PROJECTS.md) |
| **Navegação (índice de links)** | [docs/NAVIGATION.md](../docs/NAVIGATION.md) |

## Eventos do Orchestrator

`project.created` → `module.planned` → `task.assigned` → `task.completed` | `qa.failed` | `qa.passed` → `devops.deployed` → `monitor.alert` → `project.completed`

## Estados de Task

NEW → ASSIGNED → IN_PROGRESS → WAITING_REVIEW → QA_PASS | QA_FAIL → DONE

## Agentes por Módulo

- **PM**: pm-backend, pm-web, pm-mobile, pm-infra
- **Dev**: dev-backend, dev-web, dev-mobile, dev-infra
- **QA**: qa-backend, qa-web, qa-mobile, qa-infra
- **DevOps**: devops-aws, devops-azure, devops-gcp
- **Monitor**: monitor-backend, monitor-web, monitor-mobile, monitor-infra

## Schemas de Eventos

[orchestrator/events/schemas/](../orchestrator/events/schemas/) — [event_envelope.json](../orchestrator/events/schemas/event_envelope.json), [project.created.json](../orchestrator/events/schemas/project.created.json), [task.assigned.json](../orchestrator/events/schemas/task.assigned.json), etc.
