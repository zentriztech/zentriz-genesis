# Documentação Consolidada de Agentes — Zentriz Genesis

> **Propósito**: Índice único de todos os agentes e suas capacidades, facilitando onboarding e referência rápida.  
> **Inspirado em**: Prática do projeto de agentes educacionais (documentação consolidada).

---

## 1. Visão Geral

| Papel | Agentes | Módulos/Clouds | Responsabilidade |
|-------|---------|----------------|------------------|
| **CTO** | 1 | — | Orquestração, Charter, delegação |
| **PM** | 4 | Backend, Web, Mobile, Infra | Backlog, aprovação, instanciação |
| **Dev** | 4 | Backend, Web, Mobile, Infra | Implementação |
| **QA** | 4 | Backend, Web, Mobile, Infra | Validação, QA Report |
| **DevOps** | 3 | AWS, Azure, GCP | IaC, CI/CD, deploy |
| **Monitor** | 4 | Backend, Web, Mobile, Infra | Saúde, alertas |

**Total**: 20 agentes.

---

## 2. CTO Agent

| Atributo | Valor |
|----------|-------|
| **Pasta** | [agents/cto/](../agents/cto/) |
| **Papel** | Orquestra o projeto: interpreta spec, define módulos, delega PMs |
| **Objetivo** | Gerar Project Charter, escolher PMs, garantir rastreabilidade + evidências |
| **Entradas** | spec_ref, task, constraints, artifacts |
| **Saídas** | status, summary, artifacts, evidence, next_actions |
| **Contratos** | message_envelope.json, response_envelope.json |
| **Checklist** | PROJECT_CHARTER, PMs atribuídos, critérios de aceite, STATUS consolidado |

---

## 3. PM Agents

| Agente | Pasta | Objetivo | DevOps selecionado |
|--------|-------|----------|--------------------|
| PM Backend | [agents/pm-backend/](../agents/pm-backend/) | Backlog backend, Dev+QA+DevOps | Por constraints.cloud |
| PM Web | [agents/pm-web/](../agents/pm-web/) | Backlog web, Dev+QA+DevOps | Por constraints.cloud |
| PM Mobile | [agents/pm-mobile/](../agents/pm-mobile/) | Backlog mobile, Dev+QA+DevOps | Por constraints.cloud |
| PM Infra | [agents/pm-infra/](../agents/pm-infra/) | Backlog infra, Dev+QA+DevOps | Por constraints.cloud |

**Regras comuns**:
- Criar backlog por FR/NFR
- Instanciar Dev, QA e DevOps
- Selecionar DevOps por `constraints.cloud` — ver [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md)
- Usar [contracts/pm_backlog_template.md](../contracts/pm_backlog_template.md)
- Checklists: [contracts/checklists/](../contracts/checklists/) ([backend_node](../contracts/checklists/backend_node_serverless_checklist.md), [backend_python](../contracts/checklists/backend_python_serverless_checklist.md), [react_web](../contracts/checklists/react_web_checklist.md), [react_native](../contracts/checklists/react_native_checklist.md))

---

## 4. Dev Agents

| Agente | Pasta | Stack | Objetivo |
|--------|-------|-------|----------|
| Dev Backend | [agents/dev-backend/](../agents/dev-backend/) | Node.js/Python, serverless | Endpoints, modelos, validações, testes |
| Dev Web | [agents/dev-web/](../agents/dev-web/) | React | Páginas, fluxos, testes, build |
| Dev Mobile | [agents/dev-mobile/](../agents/dev-mobile/) | React Native | Telas, fluxos, API, build |
| Dev Infra | [agents/dev-infra/](../agents/dev-infra/) | IaC | Infraestrutura, pipelines |

**Regras comuns**:
- Entregar com evidências (arquivos, testes, logs)
- Usar [message_envelope](../contracts/message_envelope.json) e [response_envelope](../contracts/response_envelope.json)
- Atender FR/NFR do spec

---

## 5. QA Agents

| Agente | Pasta | Objetivo |
|--------|-------|----------|
| QA Backend | [agents/qa-backend/](../agents/qa-backend/) | Validar backend, QA Report |
| QA Web | [agents/qa-web/](../agents/qa-web/) | Validar web, QA Report |
| QA Mobile | [agents/qa-mobile/](../agents/qa-mobile/) | Validar mobile, QA Report |
| QA Infra | [agents/qa-infra/](../agents/qa-infra/) | Validar infra, QA Report |

**Regras comuns**:
- Rodar testes, validar requisitos
- Produzir relatório com severidade e evidências acionáveis
- Bloquear regressões (QA_FAIL com referência FR/NFR)
- Template: [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md)

---

## 6. DevOps Agents

| Agente | Pasta | Cloud | Objetivo |
|--------|-------|-------|----------|
| DevOps AWS | [agents/devops-aws/](../agents/devops-aws/) | AWS | Lambda, API Gateway, DynamoDB, S3, CloudFront |
| DevOps Azure | [agents/devops-azure/](../agents/devops-azure/) | Azure | Functions, API Management, Cosmos/SQL |
| DevOps GCP | [agents/devops-gcp/](../agents/devops-gcp/) | GCP | Cloud Functions/Run, Firestore, Cloud SQL |

**Regras comuns**:
- IaC em [infra/](../infra/) (aws/, azure/, gcp/)
- CI/CD: lint → test → build → deploy
- Observabilidade mínima (logs estruturados, request_id)
- Smoke tests pós-deploy — [tests/smoke/](../tests/smoke/)
- Runbook em [docs/DEPLOYMENT.md](DEPLOYMENT.md)
- DoD: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)

---

## 7. Monitor Agents

| Agente | Pasta | Objetivo |
|--------|-------|----------|
| Monitor Backend | [agents/monitor-backend/](../agents/monitor-backend/) | Monitora Dev/QA backend, informa PM_Backend |
| Monitor Web | [agents/monitor-web/](../agents/monitor-web/) | Monitora Dev/QA web, informa PM_Web |
| Monitor Mobile | [agents/monitor-mobile/](../agents/monitor-mobile/) | Monitora Dev/QA mobile, informa PM_Mobile |
| Monitor Infra | [agents/monitor-infra/](../agents/monitor-infra/) | Monitora Dev/QA infra, informa PM_Infra |

**Regras comuns**:
- Monitorar **Dev_<AREA>** e **QA_<AREA>** do módulo (progresso, status de andamento, evidências)
- Detectar travas, loops, falhas recorrentes
- **Informar ao PM_<AREA>** (progresso, status, alertas). PM escala ao CTO quando crítico
- Template: [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md)

---

## 8. Pipeline de Orquestração

```
SPEC → CTO → PM(s) → Dev + QA + DevOps (por módulo) → Monitor_<AREA> → PM_<AREA> → CTO
```

- **CTO**: Recebe spec, gera Charter, delega PMs
- **PM**: Recebe módulo, gera backlog, instancia Dev/QA/DevOps/Monitor
- **Dev**: Implementa tasks
- **QA**: Valida e emite QA_PASS/QA_FAIL
- **DevOps**: Provisiona e deploya
- **Monitor_<AREA>**: Monitora Dev/QA do módulo (progresso, status), informa **PM_<AREA>**
- **PM → CTO**: Consolida status, escala alertas críticos

---

## 9. Referências

- [docs/ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) — Fluxo detalhado
- [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md) — Regra de seleção DevOps
- [docs/TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) — Squad por módulo
- [contracts/message_envelope.json](../contracts/message_envelope.json) — Contrato de entrada
- [contracts/response_envelope.json](../contracts/response_envelope.json) — Contrato de saída

---

*Documento criado em 2026-01-29 — Zentriz Genesis*
