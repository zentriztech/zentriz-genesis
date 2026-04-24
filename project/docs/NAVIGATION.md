# Navegação — Zentriz Genesis

> Índice central de links para facilitar a navegação entre documentos do projeto.  
> A pasta **docs** está organizada por categoria; ver [README.md](README.md) para a estrutura completa (plans/, guides/, status/, backlogs/, etc.).

---

## 🚀 Início Rápido

| Documento | Descrição |
|-----------|-----------|
| [README.md](../README.md) | Visão geral do projeto |
| **[ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md)** | Atores, responsabilidades, hierarquia de comunicação e comportamentos |
| [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md) | Diagramas Mermaid (fluxo V2, Monitor Loop, aceite, squads, etapas) |
| [context/PROJECT_OVERVIEW.md](../context/PROJECT_OVERVIEW.md) | Contexto completo para novos chats |
| [context/QUICK_REFERENCE.md](../context/QUICK_REFERENCE.md) | Referência rápida de caminhos |
| [context/DEVELOPMENT_CONTEXT.md](../context/DEVELOPMENT_CONTEXT.md) | Por que "Voucher"; análise; checklist e por onde começar |

---

## 📋 Especificação e Planejamento

| Documento | Descrição |
|-----------|-----------|
| [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) | Entrada do projeto (FR/NFR) |
| [spec/PRODUCT_SPEC_TEMPLATE.md](../spec/PRODUCT_SPEC_TEMPLATE.md) | Template de spec |
| [docs/PROJECT_CHARTER.md](PROJECT_CHARTER.md) | Escopo e módulos |
| [docs/status/STATUS.md](status/STATUS.md) | Estado atual do projeto |
| [docs/status/NEXT_STEPS_REMINDER.md](status/NEXT_STEPS_REMINDER.md) | Próximos caminhos naturais |
| [docs/TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) | Linguagens, infra e requisitos técnicos para desenvolver |
| [docs/PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md) | Portal genesis.zentriz.com.br, multi-tenant, planos (Prata/Ouro/Diamante), telas e gestão |

---

## 🏗️ Arquitetura e Orquestração

| Documento | Descrição |
|-----------|-----------|
| [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md) | Atores, responsabilidades, hierarquia e diagramas |
| [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md) | Diagramas Mermaid (hierarquia, fluxo V2, Monitor Loop, aceite, squads, etapas) |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | Componentes e responsabilidades |
| [docs/ORCHESTRATOR_BLUEPRINT.md](ORCHESTRATOR_BLUEPRINT.md) | Eventos e implementação |
| [docs/ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) | Fluxo CTO↔Engineer→PM→Dev/QA→Monitor→PM→CTO |
| **[docs/plans/ENGINEER_AND_TEAM_DYNAMICS_PLAN.md](plans/ENGINEER_AND_TEAM_DYNAMICS_PLAN.md)** | Plano: Engineer, novo fluxo CTO↔Engineer, PMs via CTO, logs em linguagem humana, skills por agente, Genesis-Web dinâmico |
| [docs/status/IMPLEMENTATION_SUMMARY.md](status/IMPLEMENTATION_SUMMARY.md) | Resumo do que foi implementado: Engineer, diálogo, skills, serviço agents, projetos de exemplo |
| [docs/TASK_STATE_MACHINE.md](TASK_STATE_MACHINE.md) | Estados e transições |
| [orchestrator/events/schemas/](../orchestrator/events/schemas/) | Schemas JSON dos eventos |

---

## 👥 Agentes

| Documento | Descrição |
|-----------|-----------|
| [docs/AGENTS_CAPABILITIES.md](AGENTS_CAPABILITIES.md) | Documentação consolidada de agentes |
| [agents/README.md](../agents/README.md) | Estrutura hierárquica (dev, qa, devops, pm, monitor por área/skill) |
| [agents/cto/](../agents/cto/) | CTO Agent |
| [agents/engineer/](../agents/engineer/) | Engineer Agent (proposta técnica, squads) |
| [agents/pm/](../agents/pm/) | PM (backend, web, mobile) |
| [agents/dev/](../agents/dev/) | Dev (backend/nodejs, web/react-next-materialui, mobile/react-native) |
| [agents/qa/](../agents/qa/) | QA (backend/nodejs, backend/lambdas, web/react, mobile/react-native) |
| [agents/devops/](../agents/devops/) | DevOps (docker — base; aws, azure, gcp) |
| [agents/monitor/](../agents/monitor/) | Monitor (backend, web, mobile) |

---

## 📜 Contratos e Governança

| Documento | Descrição |
|-----------|-----------|
| [contracts/global_definition_of_done.md](../contracts/global_definition_of_done.md) | DoD global |
| [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md) | DoD DevOps |
| [contracts/message_envelope.json](../contracts/message_envelope.json) | Contrato de entrada |
| [contracts/response_envelope.json](../contracts/response_envelope.json) | Contrato de saída |
| [contracts/pm_backlog_template.md](../contracts/pm_backlog_template.md) | Template de backlog |
| [contracts/checklists/](../contracts/checklists/) | Checklists por squad |

---

## 📚 Backlogs e Guias

| Documento | Descrição |
|-----------|-----------|
| [docs/backlogs/BACKLOG_BACKEND.md](backlogs/BACKLOG_BACKEND.md) | Backlog Backend |
| [docs/backlogs/BACKLOG_WEB.md](backlogs/BACKLOG_WEB.md) | Backlog Web |
| [docs/guides/PM_AUTOBACKLOG_GUIDE.md](guides/PM_AUTOBACKLOG_GUIDE.md) | Como PM gera backlog |
| [docs/guides/CTO_AGENT_FLOW_ANALYSIS.md](guides/CTO_AGENT_FLOW_ANALYSIS.md) | Fluxo completo CTO: comunicação com IA, formato de retorno, gravação em disco |
| [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md) | Regra de seleção DevOps |
| [docs/TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) | Squad por módulo |

---

## 📁 Documentação por categoria

| Pasta | Conteúdo |
|-------|----------|
| [docs/plans/](plans/) | Planos (Pipeline V2, Engineer, E2E, Portal, Full Stack) |
| [docs/guides/](guides/) | Guias (E2E, PM backlog, prompt execução) |
| [docs/status/](status/) | Status, pendências, resumos de implementação |
| [docs/backlogs/](backlogs/) | Backlogs Backend e Web |
| [docs/analysis/](analysis/) | Análises e diagnósticos (E2E, LLM, de-para API) |
| [docs/troubleshooting/](troubleshooting/) | Resolução de problemas do pipeline |
| [docs/blueprints/](blueprints/) | Blueprints e handoff entre agentes |
| [docs/templates/](templates/) | Templates (system prompt, protocolo agente) |
| [docs/reference/](reference/) | Referência (task packs, workflows) |

---

## 📐 Decisões e Propostas

| Documento | Descrição |
|-----------|-----------|
| [docs/adr/](adr/) | Architecture Decision Records |
| [docs/rfc/](rfc/) | Request for Comments |
| [docs/rfc/RFC-0001-GRAPH-VIEW-EXECUTIVE_COMMAND_CENTER.md](rfc/RFC-0001-GRAPH-VIEW-EXECUTIVE_COMMAND_CENTER.md) | Proposta de Graph View executivo para squads, agentes, atividades e fluxos de conversa |

---

## 🧪 Testes e Deploy

| Documento | Descrição |
|-----------|-----------|
| [docs/API_CONTRACT.md](API_CONTRACT.md) | Endpoints e convenções |
| [docs/DEPLOYMENT.md](DEPLOYMENT.md) | Ambientes, CI/CD, runbook |
| [docs/TEST_STRATEGY.md](TEST_STRATEGY.md) | Estratégia de testes |
| [tests/smoke/](../tests/smoke/) | Smoke tests pós-deploy |
| [docs/PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md) | Targets de performance |

---

## 📊 Relatórios e Templates

| Documento | Descrição |
|-----------|-----------|
| [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md) | Template QA Report |
| [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md) | Template Monitor Health |

---

## 🏢 Negócio

| Documento | Descrição |
|-----------|-----------|
| [business/PRODUCT_ROADMAP.md](../business/PRODUCT_ROADMAP.md) | Roadmap do produto |
| [business/OBSERVABILITY_FINOPS.md](../business/OBSERVABILITY_FINOPS.md) | Observabilidade e FinOps |
| [business/README_INVESTOR.md](../business/README_INVESTOR.md) | Investor overview |

---

## 📂 Infraestrutura

| Documento | Descrição |
|-----------|-----------|
| [infra/aws/](../infra/aws/) | IaC AWS |
| [infra/azure/](../infra/azure/) | IaC Azure |
| [infra/gcp/](../infra/gcp/) | IaC GCP |

---

*Documento criado em 2026-01-29 — Zentriz Genesis*
