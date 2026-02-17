# Orchestrator Blueprint (Event-Driven)

> Hierarquia e responsabilidades: [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md).

## Objetivo
Permitir execução paralela e rastreável do fluxo:
**SPEC** ↔ **CTO** ↔ **PM(s)**; PM atribui atividades a Dev/QA/DevOps; **Monitor** acompanha Dev/QA, aciona QA (testes) e DevOps (provisionamento), informa PM; PM → CTO → SPEC (conclusão/bloqueios).

## Entidades
- **Project**: id, spec_ref, status
- **Module/Stack**: backend, web, mobile (atores com as mesmas skills; infra via DevOps em cada stack)
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

## Regras de execução (alinhadas aos atores)
- **SPEC** fornece spec; **CTO** informa SPEC quando `project.completed` ou bloqueios.
- **CTO** gera Charter, contrata PM(s), delega stacks; consome consolidados dos PMs.
- **PM** gera backlog e emite `task.assigned` para Dev, QA e DevOps; recebe status do Monitor (não resultado de testes diretamente do QA).
- **Monitor_<AREA>** acompanha Dev_<AREA> e QA_<AREA>; **aciona** QA para testes em atividades finalizadas pelo Dev; **aciona** DevOps para provisionamento (total ou parcial); informa PM_<AREA>; emite `monitor.alert` quando há risco ou bloqueio.
- **QA** é acionado pelo Monitor; emite `qa.failed`/`qa.passed`; Monitor informa ao Dev quando refazer.
- **DevOps** é acionado pelo Monitor; emite `devops.deployed` e dispara smoke tests.
- **PM** avalia alertas do Monitor, toma ação ou escala ao CTO quando crítico.
- **CTO** marca `project.completed` e notifica SPEC.

## Evidência
- Cada evento carrega `request_id` e links para artifacts/reports.
