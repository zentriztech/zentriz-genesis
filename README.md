# 🚀 Zentriz Genesis  
**Autonomous Multi-Agent Software Factory**

Zentriz Genesis é uma **plataforma de orquestração de Agentes de IA** capaz de **conceber, planejar, desenvolver, validar, provisionar e monitorar sistemas de software completos** a partir de **documentos de especificação técnica**.

O projeto implementa uma **fábrica de software autônoma**, orientada por especificação (*spec-driven*), composta por agentes especializados que atuam como **CTO, PMs, Desenvolvedores, QA, DevOps e Monitores**, trabalhando de forma coordenada, rastreável e auditável.

## 🎯 Objetivo do Projeto

Permitir que um único documento de especificação ([`PRODUCT_SPEC.md`](spec/PRODUCT_SPEC.md)) seja suficiente para:

- Planejar projetos complexos (API, Web, Mobile)
- Montar automaticamente squads virtuais por especialidade
- Desenvolver aplicações completas (backend, frontend, mobile)
- Provisionar infraestrutura em **AWS, Azure ou GCP**
- Executar QA contínuo e testes automatizados
- Operar de forma **event-driven**, paralela e observável
- Entregar software com **evidências, rastreabilidade e governança**

## 🧠 Conceitos-chave

- **Spec-Driven Development**
- **Multi-Agent Architecture**
- **Event-Driven Orchestration**
- **Cloud-Agnostic / Serverless-First**
- **Governança e Qualidade por Design**

## 🏗️ Atores e Responsabilidades

| Ator | Responsabilidade |
|------|------------------|
| **SPEC** (pessoa real) | Dono do projeto; fornece especificação (FR/NFR); recebe do CTO conclusão ou bloqueios. |
| **CTO** | Interpreta a spec, gera Project Charter, **contrata** um ou mais PMs conforme skills; informa SPEC quando finalizado ou bloqueado. |
| **PM** | Backlog por FR/NFR; gerencia sua stack; **contrata** Dev(s), QA(s) — sempre em par (1 QA por Dev) —, **um** DevOps e **um** Monitor por stack; atribui atividades; recebe status do Monitor. |
| **Dev** | Especialista em implementação contínua; desenvolve tarefas conforme skills; é acompanhado pelo Monitor; refaz/melhora quando QA indica (via Monitor). |
| **QA** | Especialista em testes, documentação, validação contínua, QA Report; é **acionado pelo Monitor** para testar atividades finalizadas; bloqueia regressões. |
| **DevOps** | Especialista em IaC, CI/CD, deploy, banco de dados, smoke tests; é **acionado pelo Monitor** para provisionamento total ou parcial. |
| **Monitor** | Acompanha Dev/QA; **aciona** QA para testes e DevOps para provisionamento; informa PM (PM escala ao CTO quando crítico). |

**Hierarquia de comunicação**: SPEC ↔ CTO ↔ PM. PM atribui atividades a Dev, QA e DevOps. Monitor ↔ Dev, Monitor ↔ QA, Monitor ↔ DevOps; Monitor → PM.

Documentação completa (comportamentos, hierarquia e diagramas Mermaid): **[docs/ACTORS_AND_RESPONSIBILITIES.md](docs/ACTORS_AND_RESPONSIBILITIES.md)**. Diagramas visuais: **[ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md)**.

## 🔄 Orquestração Event-Driven

Fluxo baseado em eventos padronizados:
`project.created`, `task.assigned`, `qa.failed`, `devops.deployed`, `project.completed`, entre outros.

Cada task segue uma **State Machine** formal garantindo rastreabilidade e controle.

## 📂 Estrutura do Projeto

```
Zentriz-Genesis/
├─ spec/
├─ docs/             # Inclui adr/, rfc/, guias
├─ agents/           # Estrutura por tipo e skill: cto/, pm/, dev/, qa/, devops/, monitor/ (ver agents/README.md)
├─ contracts/
├─ reports/
├─ tests/smoke/
├─ infra/
├─ orchestrator/
├─ services/
├─ apps/
├─ examples/
├─ scripts/          ← Scripts de manutenção (validação, geração)
└─ context/          ← Contexto para novos chats e onboarding
```

## 📚 Contexto para Novos Chats e Onboarding

O projeto Zentriz Genesis é extenso, com dezenas de documentos e múltiplas camadas. Para facilitar a **continuidade entre sessões** e o **onboarding de novos chats** (assistentes de IA) ou desenvolvedores:

- **Pasta `context/`**: Armazena documentos de contexto que condensam o cenário completo do projeto.
- **Novo chat iniciando trabalho?** Leia [context/PROJECT_OVERVIEW.md](context/PROJECT_OVERVIEW.md) para carregar o contexto completo sem percorrer todos os .md do repositório.
- **Referência rápida?** Consulte [context/QUICK_REFERENCE.md](context/QUICK_REFERENCE.md).
- **Detalhes**: Veja [context/README.md](context/README.md) para entender o propósito e uso da pasta.

Essa abordagem permite que **novos chats aproveitem o contexto dos chats anteriores**, mantendo consistência e evitando perda de conhecimento entre sessões de trabalho.

## 📜 Documentos Fundamentais

- [PRODUCT_SPEC.md](spec/PRODUCT_SPEC.md)
- **[ACTORS_AND_RESPONSIBILITIES.md](docs/ACTORS_AND_RESPONSIBILITIES.md)** — Atores, responsabilidades e hierarquia de comunicação
- [ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md) — Diagramas Mermaid (fluxo, stacks, etapas)
- [PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md)
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [BACKLOG_*.md](docs/BACKLOG_BACKEND.md)
- [ORCHESTRATOR_BLUEPRINT.md](docs/ORCHESTRATOR_BLUEPRINT.md)
- [TASK_STATE_MACHINE.md](docs/TASK_STATE_MACHINE.md)
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — Deploy local (inclui uso do script [deploy-docker.sh](deploy-docker.sh)), Kubernetes, CI/CD
- [STATUS.md](docs/STATUS.md)
- **[context/PROJECT_OVERVIEW.md](context/PROJECT_OVERVIEW.md)** — Contexto completo para novos chats e onboarding
- **[docs/adr/](docs/adr/)** — Architecture Decision Records (decisões arquiteturais)
- **[docs/rfc/](docs/rfc/)** — Request for Comments (propostas formais)
- **[docs/AGENTS_CAPABILITIES.md](docs/AGENTS_CAPABILITIES.md)** — Documentação consolidada de agentes
- **[docs/PERFORMANCE_METRICS.md](docs/PERFORMANCE_METRICS.md)** — Targets de latência, cobertura e qualidade
- **[docs/NAVIGATION.md](docs/NAVIGATION.md)** — Índice central de links para navegação

## ✅ Qualidade e Governança

- [Definition of Done](contracts/global_definition_of_done.md) global e [DevOps](contracts/devops_definition_of_done.md)
- [Checklists](contracts/checklists/) por stack (React, RN, Backend)
- Testes automatizados e [smoke tests](tests/smoke/) pós-deploy

## 🌐 Clouds Suportadas

- AWS
- Azure
- GCP

## 🧬 O que é o Zentriz Genesis
- Um framework de engenharia orientado a agentes

---

**Zentriz Genesis** — Engenharia de Software Autônoma por Design.