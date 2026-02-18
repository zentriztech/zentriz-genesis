# Orchestrator Blueprint (Event-Driven)

> Hierarquia e responsabilidades: [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md).

## Objetivo
Permitir execução paralela e rastreável do fluxo:
**SPEC** ↔ **CTO** ↔ **Engineer** (proposta técnica); **CTO** ↔ **PM(s)**; PMs conversam **via CTO** (dependências); PM atribui atividades a Dev/QA/DevOps; **Monitor** acompanha Dev/QA, aciona QA e DevOps, informa PM; bloqueios cross-team: PM → CTO → Engineer (ou PM responsável) → solução → Dev; PM → CTO → SPEC (conclusão/bloqueios).

## Entidades
- **Project**: id, spec_ref, status
- **Module/Stack**: backend, web básica, web avançada, mobile (definidos pelo Engineer; atores com as mesmas skills; infra via DevOps em cada stack)
- **Task**: id, module, owner_role, requirements (FR/NFR), status
- **Block** (bloqueio cross-team): id, reported_by (stack/PM), responsible_stack, description, status (open/resolved)

## Padrão de eventos
- `cto.engineer.request` — CTO envia spec/contexto ao Engineer
- `engineer.cto.response` — Engineer devolve proposta técnica (stacks, dependências)
- `project.created`
- `module.planned`
- `task.assigned`
- `task.completed`
- `qa.failed`
- `qa.passed`
- `devops.deployed`
- `monitor.alert`
- `block.reported` — Bloqueio reportado (ex.: Web depende de endpoint do Backend que falhou)
- `block.resolved` — Bloqueio resolvido (PM responsável atribuiu correção ao Dev)
- `pm.cto.dependency_request` — PM pede ao CTO recurso/dependência de outra stack (ex.: lista de endpoints)
- `project.completed`

## Implementação (exemplo AWS)
- EventBridge (bus)
- SQS (fila por role ou módulo)
- Lambdas (um handler por agente)
- DynamoDB (estado do projeto)
- CloudWatch (logs/metrics/alarms)

## Regras de execução (alinhadas aos atores)
- **SPEC** fornece spec; **CTO** informa SPEC quando `project.completed` ou bloqueios.
- **CTO** envia spec ao **Engineer**; **Engineer** devolve proposta (stacks, equipes, dependências); CTO gera Charter e contrata PM(s); CTO atua como **ponte** entre PMs (ex.: PM Web pede endpoints ao CTO, CTO obtém do PM Backend e repassa).
- **CTO** delega stacks e dependências aos PMs; consome consolidados dos PMs.
- **PM** gera backlog e emite `task.assigned`; pode pedir dependência a outra stack **via CTO** (`pm.cto.dependency_request`); recebe status do Monitor.
- **Monitor_<AREA>** acompanha Dev_<AREA> e QA_<AREA>; aciona QA e DevOps; informa PM_<AREA>; emite `monitor.alert` quando há risco ou bloqueio.
- **Bloqueio cross-team**: PM reporta ao CTO (`block.reported`); CTO consulta Engineer ou PM responsável; solução repassada ao PM → Dev; quando resolvido, `block.resolved`.
- **QA** é acionado pelo Monitor; emite `qa.failed`/`qa.passed`; Monitor informa ao Dev quando refazer.
- **DevOps** é acionado pelo Monitor; emite `devops.deployed` e dispara smoke tests.
- **CTO** marca `project.completed` e notifica SPEC.

## Evidência
- Cada evento carrega `request_id` e links para artifacts/reports.
