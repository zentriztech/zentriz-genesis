# Contexto de Desenvolvimento — Zentriz Genesis

> **Uso**: Anotar decisões, estado atual e informações de análise para continuidade entre sessões e onboarding. Leia junto com [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

---

## 1. Por que "Voucher" (vale-presente) é citado?

**"Voucher"** é o **produto de exemplo** escolhido no repositório para demonstrar o fluxo do Zentriz Genesis. Não é o produto final da plataforma — é um **MVP fictício** usado como spec de referência.

- **Onde está**: [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) descreve um mini produto: criar vouchers, consultar, resgatar e listar (admin).
- **Objetivo**: Ter uma spec concreta (FR/NFR) para:
  - Preencher Charter, backlogs, API Contract e status.
  - Desenvolver uma API + Web de exemplo (Backend + Web stacks).
  - Testar smoke tests, orquestração e agentes contra um caso real.
- **Substituição**: Qualquer outro produto pode ser usado — basta trocar o `PRODUCT_SPEC.md` (ou criar outro spec) e ajustar Charter/backlogs. O Voucher é só o primeiro exemplo.

**Resumo**: Voucher = produto de demonstração/exemplo do repositório, não o negócio do Zentriz Genesis.

---

## 2. CONTEXT — Análise e estado (registro)

### 2.1 O que já está pronto (fundação)

| Área | Estado |
|------|--------|
| Documentação | Completa (README, atores, arquitetura, orquestração, ADRs, NAVIGATION, etc.) |
| Spec de exemplo | PRODUCT_SPEC.md (Voucher MVP: FR-01 a FR-04, NFR-01 a NFR-04) |
| Agentes | Estrutura por stack/skill (cto, pm, dev, qa, devops, monitor) com SYSTEM_PROMPT.md |
| Contratos | message_envelope, response_envelope, DoD global, DoD DevOps, checklists |
| Orquestração (desenho) | Schemas de eventos, task_state_machine, handler templates (skeleton) |
| Backlogs de exemplo | BACKLOG_BACKEND, BACKLOG_WEB (tasks Voucher) |
| API Contract | Endpoints Voucher em docs/API_CONTRACT.md |
| Smoke tests | api_smoke_test.sh implementado; web/mobile com scripts ou template |

### 2.2 O que faltava (e foi tratado)

| Item | Ação |
|------|------|
| Project Charter vazio | Preenchido para o produto de exemplo (Voucher MVP) em docs/PROJECT_CHARTER.md |
| STATUS.md vazio | Preenchido com estado inicial em docs/STATUS.md |
| message_envelope com roles Infra | Atualizado: removidos PM_INFRA, DEV_INFRA, QA_INFRA, MONITOR_INFRA (apenas 3 stacks: Backend, Web, Mobile) |

### 2.3 O que ainda não existe (próximos passos)

- **Código do produto**: Nenhum `package.json`/`requirements.txt` ou implementação em `services/` ou `apps/` (apenas READMEs).
- **Orquestrador real**: Nenhum runner que invoque agentes (ex.: LLM + SYSTEM_PROMPT); só templates de handler.
- **IaC**: infra/aws, infra/azure, infra/gcp com apenas READMEs (sem Terraform/CDK/SAM).
- **Scripts de validação**: scripts/ planejados (validate/, generate/, test/) mas não implementados.

### 2.4 Por onde começar (recomendações anotadas)

1. **Caminho produto (recomendado)**: Preencher Charter e STATUS → implementar API em services/api-node (ou api-python) conforme API_CONTRACT e BACKLOG_BACKEND → implementar front em apps/web-react conforme BACKLOG_WEB → rodar smoke tests.
2. **Caminho orquestrador**: Implementar um runner mínimo (ex.: CLI ou serviço) que leia spec, chame CTO (LLM + agents/cto/SYSTEM_PROMPT.md), gere Charter, chame PM e gere backlog; persistir estado em JSON ou DB.
3. **Caminho validação**: Implementar scripts/validate/schemas.sh e validate/contracts.sh; validar examples/messages contra schemas; depois seguir com caminho 1 ou 2.

### 2.5 Checklist "pronto para desenvolver"

- [x] Spec de produto (ex.: Voucher MVP)
- [x] Atores e responsabilidades definidos
- [x] Agentes com SYSTEM_PROMPT por stack/skill
- [x] Contratos (envelope, DoD, checklists)
- [x] Eventos e state machine definidos
- [x] Backlogs de exemplo (Backend, Web)
- [x] Project Charter preenchido (ex.: Voucher MVP)
- [x] STATUS.md preenchido
- [x] message_envelope alinhado à doc (apenas 3 stacks)
- [x] Requisitos técnicos com domínio, Docker (namespace zentriz-genesis), Terraform, k8s
- [ ] **DevOps Docker** (base de provisionamento) implementado
- [ ] API implementada (services/api-node ou api-python)
- [ ] App Web implementada (apps/web-react)
- [ ] Scripts de validação (opcional)
- [ ] Runner ou handlers reais que invoquem agentes
- [ ] IaC mínima para deploy (Terraform + k8s por cloud)

---

## 3. Podemos começar a desenvolver? — Análise

**Sim.** A fundação está pronta: spec, Charter, contratos, agentes (estrutura + SYSTEM_PROMPT), eventos, backlogs, domínio e URLs ([docs/TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md)), e a decisão de provisionar tudo via **Docker** (namespace `zentriz-genesis`), **Terraform** e **Kubernetes** em qualquer infra (AWS, GCP, Azure). O que falta é **implementação** dos agentes e do orquestrador.

### 3.1 Ordem recomendada de desenvolvimento dos agentes

A ordem abaixo garante que a **infra de execução** exista antes do código das aplicações e que o orquestrador venha por último (ele coordena todos).

| # | Agente | Justificativa |
|---|--------|----------------|
| **1** | **devops::docker** | **Fundação.** Todo o projeto é provisionado via Docker (local), Terraform e k8s em qualquer cloud. Sem isso, Dev/QA/PM/Monitor não têm onde rodar nem onde fazer deploy. Namespace `zentriz-genesis`, Compose/Terraform/k8s conforme [TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md). |
| 2 | dev::backend::nodejs | Implementa a API (ex.: Voucher) em Node/TypeScript; consome a base Docker/k8s. |
| 3 | qa::backend::nodejs | Testes e validação do backend Node; depende do dev backend e do ambiente (Docker). |
| 4 | pm::backend::nodejs | Backlog e planejamento da stack Backend; usa outputs do CTO e contrata Dev/QA/DevOps. |
| 5 | monitor::backend::nodejs | Acompanhamento, health e alertas da stack Backend; aciona QA e DevOps quando necessário. |
| 6 | cto | Orquestrador: lê spec, gera Charter, contrata PM(s); consolida decisões e estado. Implementar por último, quando os demais agentes estiverem disponíveis. |

**Resumo**: **devops::docker** primeiro; em seguida os agentes da stack Backend (dev → qa → pm → monitor); **cto** por último.

- Referência de agentes: [agents/README.md](../agents/README.md). DevOps Docker: [agents/devops/docker/](../agents/devops/docker/).
- Ordem também registrada em [docs/TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md) (seção “Ordem de desenvolvimento dos agentes”).

---

## 4. Requisitos técnicos, infra e linguagens

Consulte **[docs/TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md)** para:
- Linguagens e runtimes (Node.js/TypeScript, Python, React, React Native)
- Stack por módulo (Backend, Web, Mobile)
- Infraestrutura e clouds (AWS, Azure, GCP)
- NFR e ferramentas (lint, testes, CI/CD)
- O que instalar para começar

## 5. Referências rápidas

- Spec de exemplo: [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md)
- Charter preenchido: [docs/PROJECT_CHARTER.md](../docs/PROJECT_CHARTER.md)
- Status: [docs/STATUS.md](../docs/STATUS.md)
- Requisitos técnicos: [docs/TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md)
- Atores: [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md)
- Navegação: [docs/NAVIGATION.md](../docs/NAVIGATION.md)

---

*Documento criado em 2026-02-17 — Zentriz Genesis. Atualize este arquivo quando houver mudanças de decisão ou estado.*
