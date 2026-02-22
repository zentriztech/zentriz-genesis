# Documentação do Projeto — Zentriz Genesis

Esta pasta contém a documentação do projeto, organizada por categoria. Use o **[NAVIGATION.md](NAVIGATION.md)** como índice central de links.

---

## Estrutura

### Na raiz (documentação direta do projeto)

Documentos que refletem a aplicação atual: arquitetura, atores, fluxo, deploy, contratos.

| Arquivo | Descrição |
|---------|-----------|
| [NAVIGATION.md](NAVIGATION.md) | Índice central — comece por aqui |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Componentes e responsabilidades |
| [PROJECT_CHARTER.md](PROJECT_CHARTER.md) | Escopo e módulos |
| [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) | Linguagens, infra e requisitos |
| [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md) | Atores, hierarquia e comunicação |
| [AGENTS_CAPABILITIES.md](AGENTS_CAPABILITIES.md) | Capacidades dos agentes (CTO, Engineer, PM, Dev, QA, DevOps, Monitor) |
| [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md) | Fluxo portal → API → Runner → agents → Claude |
| [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) | Fluxo CTO↔Engineer→PM→Dev/QA→Monitor |
| [ORCHESTRATOR_BLUEPRINT.md](ORCHESTRATOR_BLUEPRINT.md) | Eventos e implementação do runner |
| [TASK_STATE_MACHINE.md](TASK_STATE_MACHINE.md) | Estados e transições de tasks |
| [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md) | Formatos de spec aceitos |
| [API_CONTRACT.md](API_CONTRACT.md) | Endpoints e convenções |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Ambientes, Docker, CI/CD, runbook |
| [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md) | Variáveis de ambiente e secrets |
| [TEST_STRATEGY.md](TEST_STRATEGY.md) | Estratégia de testes |
| [DEVOPS_SELECTION.md](DEVOPS_SELECTION.md) | Regra de seleção DevOps |
| [TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) | Squad por módulo |
| [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md) | Portal multi-tenant e planos |
| [PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md) | Targets de performance |
| [PROJECT_STRUCTURE_AND_REFACTORING.md](PROJECT_STRUCTURE_AND_REFACTORING.md) | Estrutura do repo e refatoração |

### Subpastas

| Pasta | Conteúdo |
|-------|----------|
| **[plans/](plans/)** | Planos e roadmaps (Pipeline V2, Engineer, E2E, Portal, Full Stack) |
| **[guides/](guides/)** | Guias e como-fazer (E2E, PM backlog, prompt execução) |
| **[analysis/](analysis/)** | Análises, diagnósticos e relatórios (E2E, comunicação LLM, de-para API) |
| **[blueprints/](blueprints/)** | Blueprints e contratos de handoff entre agentes |
| **[status/](status/)** | Status do projeto, pendências, resumos de implementação, checklists |
| **[backlogs/](backlogs/)** | Backlogs por área (Backend, Web) |
| **[troubleshooting/](troubleshooting/)** | Resolução de problemas do pipeline |
| **[templates/](templates/)** | Templates (ex.: system prompt e protocolo do agente) |
| **[reference/](reference/)** | Referência (task packs, GitHub workflows) |
| **[adr/](adr/)** | Architecture Decision Records |
| **[rfc/](rfc/)** | Request for Comments |

---

## Links entre documentos

Os links relativos entre arquivos foram ajustados para a nova estrutura. Se um link quebrar (ex.: após mover um arquivo), edite o caminho no documento de origem para refletir o novo local.

---

*Reorganização em 2026-02 — Zentriz Genesis*
