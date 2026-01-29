# Zentriz Genesis — Visão Completa do Projeto (Contexto para IA e Humanos)

> **Uso**: Este documento serve como âncora de contexto para novos chats e desenvolvedores. Leia-o primeiro ao iniciar trabalho no Zentriz Genesis.

---

## 1. O que é o Zentriz Genesis

**Zentriz Genesis** é uma **plataforma de orquestração de Agentes de IA** — uma **fábrica de software autônoma** que:

- Recebe um documento de especificação ([PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md))
- Planeja, desenvolve, valida, provisiona e monitora sistemas completos
- Opera com agentes especializados: **CTO, PMs, Devs, QA, DevOps, Monitors**
- É **spec-driven**, **event-driven** e **cloud-agnostic** (AWS, Azure, GCP)

**Princípio Zero**: Especificação é lei. Toda decisão nasce de spec explícita, versionada e auditável.

---

## 2. Arquitetura de Agentes

```
SPEC (Product Spec) → CTO → PMs (Backend/Web/Mobile/Infra)
                            ↓
                    Dev + QA + DevOps + Monitor (por módulo)
                            ↓
                    Monitor_<AREA> → PM_<AREA> → CTO (fluxo de alertas)
```

- **CTO**: Interpreta spec, cria Project Charter, define módulos, delega PMs
- **PMs** (por área): Backend, Web, Mobile, Infra — geram backlog, instanciam Dev/QA/DevOps/Monitor
- **Dev**: Implementa código, testes, documentação
- **QA**: Validação contínua, QA Reports, bloqueia regressões
- **DevOps** (por cloud): AWS, Azure, GCP — IaC, CI/CD, observabilidade, smoke tests
- **Monitor_<AREA>**: Monitora **Dev_<AREA>** e **QA_<AREA>** do módulo (progresso, status de andamento), **informa PM_<AREA>** → PM escala ao CTO quando crítico

---

## 3. Fluxo de Orquestração (Event-Driven)

**Eventos principais**: `project.created` → `module.planned` → `task.assigned` → `task.completed` | `qa.failed` | `qa.passed` → `devops.deployed` → `monitor.alert` → `project.completed`

**Task State Machine**: NEW → ASSIGNED → IN_PROGRESS → WAITING_REVIEW → QA_PASS/QA_FAIL → DONE

---

## 4. Estrutura do Repositório

```
zentriz-genesis/
├─ spec/              # PRODUCT_SPEC.md (entrada principal)
├─ docs/              # Charters, backlogs, arquitetura, guias, adr/, rfc/
├─ agents/            # SYSTEM_PROMPT.md por agente (CTO, PM, Dev, QA, DevOps, Monitor)
├─ contracts/         # DoD global, DoD DevOps, checklists, envelopes
├─ reports/           # Templates QA_REPORT, MONITOR_HEALTH
├─ tests/smoke/       # Smoke tests pós-deploy
├─ infra/             # IaC por cloud (aws/, azure/, gcp/)
├─ orchestrator/      # Event schemas, handlers (node/python), state machine
├─ services/          # api-node/, api-python/
├─ apps/              # web-react/, mobile-react-native/
├─ examples/          # Mensagens e outputs de exemplo
├─ business/          # Roadmap, FinOps, Investor overview
├─ scripts/           # Scripts de manutenção (validação, geração)
└─ context/           # ← Esta pasta: contexto para novos chats
```

---

## 5. Documentos Fundamentais

| Documento | Localização | Propósito |
|-----------|-------------|-----------|
| Product Spec | [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) | Entrada do projeto (FR/NFR) |
| Project Charter | [docs/PROJECT_CHARTER.md](../docs/PROJECT_CHARTER.md) | Escopo e módulos |
| Architecture | [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) | Componentes e responsabilidades |
| Orchestrator Blueprint | [docs/ORCHESTRATOR_BLUEPRINT.md](../docs/ORCHESTRATOR_BLUEPRINT.md) | Eventos e implementação |
| Task State Machine | [docs/TASK_STATE_MACHINE.md](../docs/TASK_STATE_MACHINE.md) | Estados e transições |
| Backlogs | [docs/BACKLOG_BACKEND.md](../docs/BACKLOG_BACKEND.md), [docs/BACKLOG_WEB.md](../docs/BACKLOG_WEB.md) | Tasks por módulo |
| API Contract | [docs/API_CONTRACT.md](../docs/API_CONTRACT.md) | Endpoints e convenções |
| Deployment | [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) | Ambientes, CI/CD, runbook |
| Status | [docs/STATUS.md](../docs/STATUS.md) | Estado atual do projeto |
| Next Steps | [docs/NEXT_STEPS_REMINDER.md](../docs/NEXT_STEPS_REMINDER.md) | Próximos caminhos naturais |
| **ADRs** | [docs/adr/](../docs/adr/) | Decisões arquiteturais |
| **RFCs** | [docs/rfc/](../docs/rfc/) | Propostas formais |
| **Agents Capabilities** | [docs/AGENTS_CAPABILITIES.md](../docs/AGENTS_CAPABILITIES.md) | Documentação consolidada de agentes |
| **Performance Metrics** | [docs/PERFORMANCE_METRICS.md](../docs/PERFORMANCE_METRICS.md) | Targets de latência, cobertura, etc. |
| **Práticas de outros projetos** | [context/PRACTICES_FROM_OTHER_PROJECTS.md](PRACTICES_FROM_OTHER_PROJECTS.md) | Análise e recomendações |

---

## 6. Contratos e Governança

- **DoD Global**: [contracts/global_definition_of_done.md](../contracts/global_definition_of_done.md)
- **DoD DevOps**: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)
- **Checklists**: [contracts/checklists/](../contracts/checklists/) (React, RN, Backend Node/Python)
- **Envelopes**: [contracts/message_envelope.json](../contracts/message_envelope.json), [contracts/response_envelope.json](../contracts/response_envelope.json)

---

## 7. Estado Atual e Decisão Estratégica

**Fase atual**: Construção da fundação de agentes.

**Decisão registrada** ([docs/NEXT_STEPS_REMINDER.md](../docs/NEXT_STEPS_REMINDER.md)):
- Primeiro: concluir integralmente a fundação (CTO, PMs, Devs, QA, DevOps, Monitors, contratos, orquestração)
- Depois: Dashboard, execução real do Orchestrator, SaaS, Whitepaper, Marketplace de agentes

**Produto de exemplo**: Voucher MVP (API + Web) — spec em [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md), backlogs em [docs/BACKLOG_BACKEND.md](../docs/BACKLOG_BACKEND.md) e [docs/BACKLOG_WEB.md](../docs/BACKLOG_WEB.md).

---

## 8. Clouds e Stacks

- **AWS**: Lambda, API Gateway, DynamoDB, S3, CloudFront
- **Azure**: Functions, API Management, Cosmos/SQL, Storage
- **GCP**: Cloud Functions/Run, Firestore, Cloud SQL

**Seleção DevOps**: PM escolhe agente baseado em `constraints.cloud` do spec.

---

## 9. Manifesto Técnico (resumo)

- Especificação é lei
- Engenharia autônoma (agentes assumem responsabilidade)
- Evidência > opinião
- QA contínuo (não é fase)
- Cloud-agnostic por design
- Governança programável
- Sistema vivo (aprende com falhas e métricas)

---

## 10. Referência Rápida de Caminhos

- [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) — entrada
- [docs/ORCHESTRATION_GUIDE.md](../docs/ORCHESTRATION_GUIDE.md) — fluxo CTO→PM→Dev/QA→Monitor
- [docs/PM_AUTOBACKLOG_GUIDE.md](../docs/PM_AUTOBACKLOG_GUIDE.md) — como PM gera backlog de FR/NFR
- [docs/DEVOPS_SELECTION.md](../docs/DEVOPS_SELECTION.md) — qual DevOps instanciar
- [orchestrator/events/schemas/](../orchestrator/events/schemas/) — schemas JSON dos eventos
- [agents/](../agents/) — prompt de cada agente (SYSTEM_PROMPT.md)

---

*Última atualização: 2026-01-29 — Zentriz Genesis*
