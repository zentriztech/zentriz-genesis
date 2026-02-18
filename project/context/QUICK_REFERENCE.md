# Zentriz Genesis — Referência Rápida

## Caminhos Essenciais

| O que | Onde |
|-------|------|
| **Estado atual do projeto (atividades, credenciais, como rodar)** | [context/CONTEXT.md](CONTEXT.md) |
| Portal genesis-web (stack, login por role, integração API) | [context/GENESIS_WEB_CONTEXT.md](GENESIS_WEB_CONTEXT.md) |
| API (usuários padrão, endpoints, banco) | [services/api-node/README.md](../../applications/services/api-node/README.md) |
| Atores e responsabilidades | [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md) |
| Entrada do projeto | [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) |
| Guia de orquestração | [docs/ORCHESTRATION_GUIDE.md](../docs/ORCHESTRATION_GUIDE.md) |
| Blueprint de eventos | [docs/ORCHESTRATOR_BLUEPRINT.md](../docs/ORCHESTRATOR_BLUEPRINT.md) |
| State machine de tasks | [docs/TASK_STATE_MACHINE.md](../docs/TASK_STATE_MACHINE.md) |
| PM gera backlog | [docs/PM_AUTOBACKLOG_GUIDE.md](../docs/PM_AUTOBACKLOG_GUIDE.md) |
| DevOps por cloud | [docs/DEVOPS_SELECTION.md](../docs/DEVOPS_SELECTION.md) |
| DoD global | [contracts/global_definition_of_done.md](../../applications/contracts/global_definition_of_done.md) |
| DoD DevOps | [contracts/devops_definition_of_done.md](../../applications/contracts/devops_definition_of_done.md) |
| Próximos passos | [docs/NEXT_STEPS_REMINDER.md](../docs/NEXT_STEPS_REMINDER.md) |
| Status atual | [docs/STATUS.md](../docs/STATUS.md) |
| **ADRs** (decisões arquiteturais) | [docs/adr/](../docs/adr/) |
| **RFCs** (propostas) | [docs/rfc/](../docs/rfc/) |
| **Agentes consolidados** | [docs/AGENTS_CAPABILITIES.md](../docs/AGENTS_CAPABILITIES.md) |
| **Métricas de performance** | [docs/PERFORMANCE_METRICS.md](../docs/PERFORMANCE_METRICS.md) |
| **Scripts de manutenção** | [scripts/](../../project/scripts/) |
| **Práticas de outros projetos** | [context/PRACTICES_FROM_OTHER_PROJECTS.md](PRACTICES_FROM_OTHER_PROJECTS.md) |
| **Navegação (índice de links)** | [docs/NAVIGATION.md](../docs/NAVIGATION.md) |

## Eventos do Orchestrator

`project.created` → `module.planned` → `task.assigned` → `task.completed` | `qa.failed` | `qa.passed` → `devops.deployed` → `monitor.alert` (→ PM_<AREA> → CTO) → `project.completed`

## Atores (resumo)

- **SPEC** (pessoa): fornece spec; recebe conclusão/bloqueios do CTO.
- **CTO**: Charter, contrata PM(s); informa SPEC.
- **PM**: Backlog, contrata Dev/QA (par), 1 DevOps, 1 Monitor; atribui atividades; recebe status do Monitor.
- **Dev**: Implementação; Monitor acompanha e devolve refazer (via QA).
- **QA**: Testes, doc, QA Report; acionado pelo Monitor.
- **DevOps**: IaC, CI/CD, deploy, DB, smoke; acionado pelo Monitor.
- **Monitor**: Acompanha Dev/QA; aciona QA e DevOps; informa PM → CTO se crítico.

Ref.: [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md)

## Portal e API (local)

- **genesis-web**: http://localhost:3001 — login `/login` (user), `/login/tenant` (tenant_admin), `/login/genesis` (zentriz_admin). Credenciais padrão: [context/CONTEXT.md](CONTEXT.md) ou [services/api-node/README.md](../../applications/services/api-node/README.md).
- **API**: http://localhost:3000 — auth, projects, specs, users, tenants. Postgres (seed com usuários hasheados).
- **Deploy local**: `./deploy-docker.sh` na raiz ([docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)).

## Fluxo de Alertas

Monitor_<AREA> monitora Dev/QA (progresso, status) → informa PM_<AREA> → PM escala ao CTO quando crítico

## Estados de Task

NEW → ASSIGNED → IN_PROGRESS → WAITING_REVIEW → QA_PASS | QA_FAIL → DONE

## Agentes (estrutura hierárquica)

Stacks: **Backend**, **Web**, **Mobile** (infra faz parte de cada stack via DevOps).

- **CTO**: agents/cto/
- **PM**: agents/pm/ (backend, web, mobile)
- **Dev**: agents/dev/ (backend/nodejs, web/react-next-materialui, mobile/react-native)
- **QA**: agents/qa/ (backend/nodejs, backend/lambdas, web/react, mobile/react-native)
- **DevOps**: agents/devops/ (aws, azure, gcp)
- **Monitor**: agents/monitor/ (backend, web, mobile)

Ver [agents/README.md](../../applications/agents/README.md) para escalar com novas skills.

## Schemas de Eventos

[orchestrator/events/schemas/](../../applications/orchestrator/events/schemas/) — [event_envelope.json](../../applications/orchestrator/events/schemas/event_envelope.json), [project.created.json](../../applications/orchestrator/events/schemas/project.created.json), [task.assigned.json](../../applications/orchestrator/events/schemas/task.assigned.json), etc.
