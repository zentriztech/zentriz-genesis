# Task State Machine (PM/Dev/QA/DevOps)

> No **fluxo V2**, o Monitor Loop do runner lê tasks por projeto/módulo e aciona Dev/QA/DevOps conforme esses estados. Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).

## Estados
- **NEW**: criado pelo PM
- **ASSIGNED**: atribuído para um owner (DEV/QA/DEVOPS)
- **IN_PROGRESS**: execução iniciada
- **WAITING_REVIEW**: pronto para validação (QA/PM)
- **QA_FAIL**: QA reprovou (reabre)
- **QA_PASS**: QA aprovou
- **BLOCKED**: impedimento (dependência externa ou **cross-team** — ex.: Web bloqueada esperando endpoint do Backend; PM reporta ao CTO, CTO/Engineer/PM responsável resolve e repassa ao Dev)
- **DONE**: aprovado pelo PM (ou CTO para tasks do charter)
- **CANCELLED**: cancelado (fora de escopo/decisão)

## Transições permitidas
- NEW -> ASSIGNED
- ASSIGNED -> IN_PROGRESS
- IN_PROGRESS -> WAITING_REVIEW
- WAITING_REVIEW -> QA_PASS | QA_FAIL
- QA_FAIL -> IN_PROGRESS (rework) | BLOCKED
- QA_PASS -> DONE
- IN_PROGRESS -> BLOCKED
- BLOCKED -> IN_PROGRESS | CANCELLED

## Regras
- QA_FAIL deve sempre incluir:
  - referência ao requisito (FR/NFR)
  - evidência (log/test)
  - ação recomendada
- DONE exige evidências do DoD global e, quando houver deploy, DoD DevOps.

## Payload mínimo de Task
```json
{
  "task_id": "TSK-BE-001",
  "module": "backend|web|mobile",
  "owner_role": "DEV_BACKEND|QA_WEB|DEVOPS_AWS",
  "requirements": ["FR-01","NFR-03"],
  "status": "NEW|ASSIGNED|...",
  "artifacts": [],
  "evidence": []
}
```
