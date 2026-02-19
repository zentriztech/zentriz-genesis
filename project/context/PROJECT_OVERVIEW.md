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

**Portal e multi-tenant**: O portal **genesis.zentriz.com.br** oferece controle de usuários por plano (Prata, Ouro, Diamante), modelo multi-tenant (tenant cadastra usuários e projetos), envio de specs ao CTO, acompanhamento do fluxo até a finalização e provisionamento automático pelo DevOps; a Zentriz gerencia todos os tenants, usuários e projetos. Detalhes: [docs/PORTAL_TENANTS_AND_PLANS.md](../docs/PORTAL_TENANTS_AND_PLANS.md).

---

## 2. Atores e Arquitetura

- **SPEC** (pessoa real): Dono do projeto; fornece especificação (FR/NFR); comunica-se apenas com o CTO; recebe conclusão ou bloqueios.
- **CTO**: Interpreta a spec, gera Project Charter, **contrata** um ou mais PMs conforme skills; delega squads; informa SPEC quando finalizado ou bloqueado.
- **PM** (por squad): Backlog por FR/NFR; gerencia a squad; **contrata** Dev(s), QA(s) em par (1 QA por Dev), **um** DevOps e **um** Monitor; atribui atividades; recebe status do Monitor.
- **Dev**: Implementação contínua; acompanhado pelo Monitor; refaz/melhora quando QA indica (via Monitor).
- **QA**: Testes, documentação, validação, QA Report; **acionado pelo Monitor** para testar atividades finalizadas; bloqueia regressões.
- **DevOps**: IaC, CI/CD, deploy, banco de dados, smoke tests; **acionado pelo Monitor** para provisionamento total ou parcial.
- **Monitor**: Acompanha Dev/QA; aciona QA para testes e DevOps para provisionamento; informa PM → PM escala ao CTO quando crítico.

**Hierarquia**: SPEC ↔ CTO ↔ PM. PM atribui atividades a Dev, QA, DevOps. Monitor ↔ Dev, Monitor ↔ QA, Monitor ↔ DevOps; Monitor → PM.

Detalhes: [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md). Diagramas: [ARCHITECTURE_DIAGRAM.md](../../ARCHITECTURE_DIAGRAM.md).

---

## 3. Fluxo de Orquestração (Event-Driven)

**Eventos principais**: `project.created` → `module.planned` → `task.assigned` → `task.completed` | `qa.failed` | `qa.passed` → `devops.deployed` → `monitor.alert` → `project.completed`. **Parada do pipeline:** usuário **aceita** o projeto no portal (`POST /api/projects/:id/accept` → status `accepted`) ou **para** (SIGTERM); o runner usa **Monitor Loop** (Fase 2) até aceite ou parada.

**Task State Machine**: NEW → ASSIGNED → IN_PROGRESS → WAITING_REVIEW → QA_PASS/QA_FAIL → DONE

---

## 4. Estrutura do Repositório

```
zentriz-genesis/
├─ spec/              # PRODUCT_SPEC.md (entrada principal)
├─ docs/              # Charters, backlogs, arquitetura, guias, adr/, rfc/
├─ agents/            # Por tipo e skill: cto/, pm/, dev/, qa/, devops/, monitor/ (ver agents/README.md)
├─ contracts/         # DoD global, DoD DevOps, checklists, envelopes
├─ reports/           # Templates QA_REPORT, MONITOR_HEALTH
├─ tests/smoke/       # Smoke tests pós-deploy
├─ infra/             # IaC por cloud (aws/, azure/, gcp/)
├─ orchestrator/      # Runner (spec→CTO→PM), spec_converter (txt/doc/pdf→md), events, state
├─ services/          # api-node/ (Fastify, Postgres, auth, projects, specs, users, tenants)
├─ apps/              # genesis-web/ (portal Next.js+MUI+MobX), web-react/, mobile-react-native/
├─ examples/          # Mensagens e outputs de exemplo
├─ business/          # Roadmap, FinOps, Investor overview
├─ scripts/           # Scripts de manutenção (validação, geração)
└─ context/           # CONTEXT.md (estado atual), GENESIS_WEB_CONTEXT, PROJECT_OVERVIEW, etc.
```

---

## 5. Documentos Fundamentais

| Documento | Localização | Propósito |
|-----------|-------------|-----------|
| Product Spec | [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) | Entrada do projeto (FR/NFR) |
| Project Charter | [docs/PROJECT_CHARTER.md](../docs/PROJECT_CHARTER.md) | Escopo e módulos |
| **Atores e Responsabilidades** | [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md) | Atores, hierarquia, comportamentos |
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

- **DoD Global**: [contracts/global_definition_of_done.md](../../applications/contracts/global_definition_of_done.md)
- **DoD DevOps**: [contracts/devops_definition_of_done.md](../../applications/contracts/devops_definition_of_done.md)
- **Checklists**: [contracts/checklists/](../../applications/contracts/checklists/) (React, RN, Backend Node/Python)
- **Envelopes**: [contracts/message_envelope.json](../../applications/contracts/message_envelope.json), [contracts/response_envelope.json](../../applications/contracts/response_envelope.json)

---

## 7. Estado Atual e Decisão Estratégica

**Fase atual**: Fundação de agentes + **portal Genesis e API integrados**.

**Realizado (portal e API):**
- **API** (services/api-node): Postgres (plans, tenants, users, projects, project_spec_files), auth JWT, `POST /api/auth/login`, `GET/POST/PATCH /api/projects`, `POST /api/specs` (multipart, multi-arquivo .md/.txt/.doc/.docx/.pdf), `GET/POST /api/users`, `GET /api/tenants`. Seed cria usuários padrão com senhas hasheadas (Zentriz Admin, tenant admin, user). Ver [context/CONTEXT.md](CONTEXT.md) e [services/api-node/README.md](../../applications/services/api-node/README.md).
- **Portal** (apps/genesis-web): três telas de login por role (`/login`, `/login/tenant`, `/login/genesis`), integração com API, envio de spec multi-arquivo, listagem/detalhe de projetos. Ver [context/GENESIS_WEB_CONTEXT.md](GENESIS_WEB_CONTEXT.md).
- **Orquestrador**: conversor de spec para Markdown ([orchestrator/spec_converter](../../applications/orchestrator/spec_converter)); runner em **duas fases** quando `API_BASE_URL`, `PROJECT_ID` e `GENESIS_API_TOKEN` definidos: Fase 1 (Spec → Engineer → CTO → PM Backend), seed de tarefas e **Monitor Loop** (Fase 2) até o usuário **aceitar** o projeto ou **parar**; persiste `started_at`/`completed_at`/`status` e diálogo via API.

**Decisão registrada** ([docs/NEXT_STEPS_REMINDER.md](../docs/NEXT_STEPS_REMINDER.md)): concluir fundação de agentes; depois Dashboard, execução real do Orchestrator, SaaS.

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
- [orchestrator/events/schemas/](../../applications/orchestrator/events/schemas/) — schemas JSON dos eventos
- [agents/](../../applications/agents/) — prompt de cada agente (SYSTEM_PROMPT.md)

---

*Última atualização: 2026-02-17 — Zentriz Genesis. Estado detalhado: [CONTEXT.md](CONTEXT.md).*
