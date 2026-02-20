# Documentação Consolidada de Agentes — Zentriz Genesis

> **Propósito**: Índice único de todos os agentes e suas capacidades, facilitando onboarding e referência rápida.  
> **Documento de referência para responsabilidades e hierarquia**: [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md). **Fluxo do pipeline (V2)**: [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).

---

## 1. Visão Geral

| Papel | Tipo | Agentes | Responsabilidade em uma frase |
|-------|------|---------|------------------------------|
| **SPEC** | Pessoa real | — | Dono do projeto; fornece spec; recebe conclusão/bloqueios do CTO. |
| **CTO** | Agente | 1 | **Produto**: interpreta spec com apoio do Engineer; gera Charter; **contrata** PM(s); ponte entre PMs (dependências); informa SPEC. |
| **Engineer** | Agente | 1 | **Técnico**: analisa spec; define squads/equipes (web básica, web avançada, backend API) e dependências; comunica-se apenas com CTO. |
| **PM** | Agente | 3 (Backend, Web, Mobile) | Backlog por FR/NFR; gerencia squad; **contrata** Dev/QA (par), 1 DevOps, 1 Monitor; conversa com outros PMs **via CTO**. |
| **Dev** | Agente | 3 squads × skills | Implementação contínua; acompanhado pelo Monitor; refaz quando QA indica (via Monitor). |
| **QA** | Agente | 3 squads × skills | Testes, doc, validação, QA Report; **acionado pelo Monitor**; bloqueia regressões. |
| **DevOps** | Agente | 3 (AWS, Azure, GCP) | IaC, CI/CD, deploy, DB, smoke tests; **acionado pelo Monitor** (total ou parcial). Infra faz parte de cada squad. |
| **Monitor** | Agente | 3 (Backend, Web, Mobile) | Acompanha Dev/QA; aciona QA e DevOps; informa PM (PM escala ao CTO). |

**Total**: 1 papel humano (SPEC) + agentes por área/skill. **Hierarquia**: SPEC ↔ CTO ↔ **Engineer** (mesmo nível CTO/Engineer); CTO ↔ PM(s); PMs conversam **via CTO**; PM atribui a Dev/QA/DevOps; Monitor ↔ Dev/QA/DevOps; Monitor → PM.

---

## 2. CTO Agent

| Atributo | Valor |
|----------|-------|
| **Pasta** | [agents/cto/](../agents/cto/) |
| **Papel** | Interpreta a spec, gera Project Charter, **contrata** um ou mais PMs conforme skills; informa SPEC quando projeto finalizado ou bloqueado. |
| **Objetivo** | Receber proposta do Engineer; gerar Charter; contratar PM(s); delegar squads e dependências; ponte entre PMs; consolidar STATUS; comunicar-se com SPEC, Engineer e PM(s). |
| **Entradas** | spec_ref, context (pode incluir engineer_stack_proposal), task, constraints, artifacts |
| **Saídas** | status, summary, artifacts, evidence, next_actions |
| **Contratos** | message_envelope.json, response_envelope.json |
| **Checklist** | PROJECT_CHARTER (com base na proposta do Engineer), PM(s) contratados por squad, dependências informadas aos PMs, STATUS consolidado, notificação a SPEC (conclusão/bloqueios) |

---

## 2.5. Engineer Agent

| Atributo | Valor |
|----------|-------|
| **Pasta** | [agents/engineer/](../../applications/agents/engineer/) |
| **Papel** | Staff Engineer / Software Architect Full-Stack. Analisa a spec e define **squads/equipes** (ex.: web básica, web avançada, backend API) e **dependências** entre equipes. Comunica-se **apenas** com o CTO. |
| **Objetivo** | Devolver proposta técnica ao CTO (lista de squads/equipes, dependências, ex.: “Web depende de Backend API — obter endpoints via CTO”) para o CTO gerar Charter e contratar PM(s). |
| **Entradas** | spec_ref, spec_content (ou resumo), context, constraints |
| **Saídas** | status, summary, artifacts (engineer_stack_proposal: squads, dependências, recomendações), evidence, next_actions |
| **Contratos** | message_envelope.json, response_envelope.json; saída estruturada: [contracts/engineer_stack_proposal.md](../../applications/contracts/engineer_stack_proposal.md) |
| **Competências** | [agents/engineer/skills.md](../../applications/agents/engineer/skills.md) |

---

## 3. PM Agents (por squad)

Squads: **Backend**, **Web**, **Mobile**. Não existe squad "Infra" — a infraestrutura é responsabilidade do DevOps dentro de cada squad.

| Agente | Pasta | Objetivo | DevOps selecionado |
|--------|-------|----------|--------------------|
| PM Backend | [agents/pm/backend/](../agents/pm/backend/) | Backlog backend; contratar Dev(s), QA(s) em par, 1 DevOps, 1 Monitor; atribuir atividades | Por constraints.cloud |
| PM Web | [agents/pm/web/](../agents/pm/web/) | Backlog web; mesma regra de contratação | Por constraints.cloud |
| PM Mobile | [agents/pm/mobile/](../agents/pm/mobile/) | Backlog mobile; mesma regra de contratação | Por constraints.cloud |

**Regras comuns**:
- Criar backlog por FR/NFR; gerenciar sua squad.
- **Contratar** atores da squad: 1 ou N pares Dev–QA (1 QA por 1 Dev), **um** DevOps e **um** Monitor por squad; apenas atores com as mesmas skills.
- Comunicar-se com Dev, QA e DevOps **apenas para atribuir atividades**; receber status do **Monitor** (não resultado de testes diretamente do QA).
- Selecionar DevOps por `constraints.cloud` — [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md)
- Usar [contracts/pm_backlog_template.md](../contracts/pm_backlog_template.md)
- Checklists: [contracts/checklists/](../contracts/checklists/)

---

## 4. Dev Agents (por área e skill)

Cada nível de Dev pode ter **diversas skills** (ex.: Dev Web: React+Next+Material UI hoje; no futuro Flutter, etc.). Estrutura: [agents/README.md](../agents/README.md).

| Stack | Skill (inicial) | Pasta | Objetivo |
|-------|-----------------|-------|----------|
| Backend | Node.js (Lambda, API Gateway) | [agents/dev/backend/nodejs/](../agents/dev/backend/nodejs/) | Endpoints, modelos, validações, testes (futuro: python, etc.) |
| Web | React + Next + Material UI + MobX | [agents/dev/web/react-next-materialui/](../agents/dev/web/react-next-materialui/) | Páginas, fluxos, testes, build (futuro: flutter, etc.) |
| Mobile | React Native (sem Expo) | [agents/dev/mobile/react-native/](../agents/dev/mobile/react-native/) | Telas, fluxos, API, build (futuro: kotlin, swift) |

**Regras comuns**:
- Receber atividades **do PM**; ser **acompanhado** pelo Monitor; quando finalizar atividade, o Monitor aciona o QA; se QA indicar problemas, o **Monitor** informa ao Dev para refazer/melhorar.
- Entregar com evidências (arquivos, testes, logs); atender FR/NFR do spec.
- Usar [message_envelope](../contracts/message_envelope.json) e [response_envelope](../contracts/response_envelope.json)

---

## 5. QA Agents (por área e skill)

| Stack | Skill | Pasta | Objetivo |
|-------|-------|-------|----------|
| Backend | Node.js (TypeScript) | [agents/qa/backend/nodejs/](../agents/qa/backend/nodejs/) | Validar backend Node.js, QA Report |
| Backend | Lambdas (TypeScript) | [agents/qa/backend/lambdas/](../agents/qa/backend/lambdas/) | Validar Lambdas, QA Report |
| Web | React (TypeScript) | [agents/qa/web/react/](../agents/qa/web/react/) | Validar web React, QA Report |
| Mobile | React Native (TypeScript) | [agents/qa/mobile/react-native/](../agents/qa/mobile/react-native/) | Validar mobile React Native, QA Report |

**Regras comuns**:
- Receber atividades **do PM**; ser **acionado pelo Monitor** para realizar testes em atividades finalizadas pelo Dev; retornar ao Monitor: OK ou precisa voltar para o Dev (com relatório acionável).
- Rodar testes, validar requisitos; produzir relatório com severidade e evidências; bloquear regressões (QA_FAIL com referência FR/NFR).
- Template: [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md)

---

## 6. DevOps Agents (base + por cloud)

| Tipo | Pasta | Objetivo |
|------|-------|----------|
| **Docker (base)** | [agents/devops/docker/](../agents/devops/docker/) | **Primeiro a implementar.** Docker (namespace `zentriz-genesis`), Terraform, Kubernetes; base para qualquer infra (local, AWS, GCP, Azure). Ver [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) e [DEVOPS_SELECTION.md](DEVOPS_SELECTION.md). |
| AWS | [agents/devops/aws/](../agents/devops/aws/) | Lambda, API Gateway, DynamoDB, S3, CloudFront (complementa a base Docker/Terraform/k8s). |
| Azure | [agents/devops/azure/](../agents/devops/azure/) | Functions, API Management, Cosmos/SQL (complementa a base). |
| GCP | [agents/devops/gcp/](../agents/devops/gcp/) | Cloud Functions/Run, Firestore, Cloud SQL (complementa a base). |

**Regras comuns**:
- **DevOps Docker** é sempre acionado primeiro (base de provisionamento). Demais DevOps (aws/azure/gcp) quando houver deploy em cloud ([DEVOPS_SELECTION.md](DEVOPS_SELECTION.md)).
- Receber atividades **do PM**; ser **acionado pelo Monitor** para provisionamento **total** ou **parcial** (parcial quando já houver produto funcional parcialmente).
- Especialista em IaC, CI/CD, deploy, **banco de dados** (quando cloud), smoke tests; provisiona toda a infra.
- IaC em [infra/](../infra/) (aws/, azure/, gcp/); CI/CD: lint → test → build → deploy; observabilidade mínima; smoke tests — [tests/smoke/](../tests/smoke/); Runbook [docs/DEPLOYMENT.md](DEPLOYMENT.md); DoD [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)

---

## 7. Monitor Agents (por squad)

| Agente | Pasta | Objetivo |
|--------|-------|----------|
| Monitor Backend | [agents/monitor/backend/](../agents/monitor/backend/) | Monitora Dev/QA backend, informa PM_Backend |
| Monitor Web | [agents/monitor/web/](../agents/monitor/web/) | Monitora Dev/QA web, informa PM_Web |
| Monitor Mobile | [agents/monitor/mobile/](../agents/monitor/mobile/) | Monitora Dev/QA mobile, informa PM_Mobile |

**Regras comuns**:
- **Acompanhar** Dev_<AREA> e QA_<AREA> (progresso, status); **acionar** QA para testes em atividades finalizadas pelo Dev; **acionar** DevOps para provisionamento (total ou parcial).
- Com **Dev**: acompanhar desenvolvimento; informar refazer/melhorar quando QA reportar problemas.
- Com **QA**: acionar testes; receber OK ou volta para Dev.
- Com **DevOps**: acionar provisionamento.
- **Informar ao PM_<AREA>** (progresso, status, alertas); PM escala ao CTO quando crítico.
- Template: [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md)

---

## 8. Pipeline de Orquestração

**Hierarquia de comunicação**: SPEC ↔ CTO ↔ PM. PM atribui atividades a Dev, QA, DevOps. Monitor ↔ Dev, Monitor ↔ QA, Monitor ↔ DevOps; Monitor → PM.

```
SPEC → CTO (Charter, contrata PMs) → PM(s) (backlog, contrata Dev/QA/DevOps/Monitor)
  → PM atribui atividades a Dev, QA, DevOps
  → Monitor acompanha Dev/QA; aciona QA (testes) e DevOps (provisionamento); informa PM
  → PM → CTO (conclusão/bloqueios) → CTO → SPEC (finalizado/bloqueios)
```

- **SPEC**: Fornece spec; recebe do CTO conclusão ou bloqueios.
- **CTO**: Interpreta spec, Charter, contrata PM(s); informa SPEC.
- **PM**: Backlog, contrata Dev(s)/QA(s) em par, 1 DevOps, 1 Monitor; atribui atividades; recebe status do Monitor.
- **Dev**: Implementa; Monitor acompanha; refaz quando Monitor informa (baseado em QA).
- **QA**: Acionado pelo Monitor para testes; retorna OK ou volta para Dev.
- **DevOps**: Acionado pelo Monitor para provisionamento total ou parcial.
- **Monitor**: Acompanha Dev/QA; aciona QA e DevOps; informa PM → CTO se crítico.

---

## 9. Referências

- **[docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md)** — Atores, responsabilidades, hierarquia e comportamentos
- [docs/ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) — Fluxo detalhado
- [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md) — Regra de seleção DevOps
- [docs/TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) — Composição da squad (pares Dev–QA, 1 DevOps, 1 Monitor)
- [contracts/message_envelope.json](../contracts/message_envelope.json) — Contrato de entrada
- [contracts/response_envelope.json](../contracts/response_envelope.json) — Contrato de saída

---

*Documento criado em 2026-01-29 — Atualizado em 2026-02-17 — Zentriz Genesis*
