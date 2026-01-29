# ADR-0002: Event-Driven para Orquestração

## Status

Aceito

## Data

2026-01-29

## Contexto

O Zentriz Genesis precisa orquestrar múltiplos agentes (CTO → PMs → Dev/QA/DevOps → Monitor) de forma paralela, rastreável e resiliente. Uma abordagem síncrona ou acoplada limitaria escalabilidade e observabilidade.

## Decisão

A orquestração é **event-driven**. Agentes comunicam-se via eventos padronizados (`project.created`, `task.assigned`, `qa.failed`, `devops.deployed`, etc.). Cada evento carrega `request_id` e links para artifacts/reports. O estado do projeto é persistido e pode ser reprocessado em caso de falha.

## Alternativas Consideradas

1. **Orquestração síncrona (API calls diretas)**: Um orquestrador chama agentes em sequência. Rejeitada por acoplamento forte e dificuldade de paralelização.
2. **Workflow rígido (BPMN/Step Functions)**: Fluxo fixo definido em diagrama. Rejeitada por menor flexibilidade para loops (QA_FAIL → rework) e branching dinâmico.
3. **Message queue sem schema**: Filas genéricas sem contrato de eventos. Rejeitada por perda de rastreabilidade e tipagem.

## Consequências

- **Positivas**: Paralelização natural, desacoplamento, reprocessamento, observabilidade por eventos, cloud-native (EventBridge/SQS, Service Bus, PubSub).
- **Negativas**: Complexidade de debugging distribuído; eventual consistency.
- **Neutras**: Exige schemas JSON bem definidos para cada evento.

## Referências

- docs/ORCHESTRATOR_BLUEPRINT.md
- orchestrator/events/schemas/
- docs/TASK_STATE_MACHINE.md
