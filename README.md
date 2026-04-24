# 🚀 Zentriz Genesis  
**Autonomous Multi-Agent Software Factory**

Zentriz Genesis é uma **plataforma de orquestração de Agentes de IA** capaz de **conceber, planejar, desenvolver, validar, provisionar e monitorar sistemas de software completos** a partir de **documentos de especificação técnica**.

O projeto implementa uma **fábrica de software autônoma**, orientada por especificação (*spec-driven*), composta por agentes especializados que atuam como **CTO, Engineer, PMs, Desenvolvedores, QA, DevOps e Monitores**, trabalhando de forma coordenada, rastreável e auditável.

## 🎯 Objetivo do Projeto

Permitir que um único documento de especificação ([`PRODUCT_SPEC.md`](project/spec/PRODUCT_SPEC.md)) seja suficiente para:

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

## Suite e interoperabilidade

O **Zentriz Genesis** continua sendo um produto autônomo da suite, com valor e operação próprios. Dentro do ecossistema federado:

- **Genesis** responde por criação, evolução e governança de build/change;
- **Deadpool** responde por monitoramento, diagnóstico, remediação e aprendizado operacional;
- **Zentriz Connect** publica a linguagem contratual comum da suite.

Quando o Genesis produz artefatos como passports, manifests, ownership e observability baselines, eles devem convergir para os contratos versionados do Connect para que Deadpool e demais integrações aderentes falem a mesma língua sem acoplamento de runtime.

## 🏗️ Atores e Responsabilidades

| Ator | Responsabilidade |
|------|------------------|
| **SPEC** (pessoa real) | Dono do projeto; fornece especificação (FR/NFR); recebe do CTO conclusão ou bloqueios. |
| **CTO** | Interpreta a spec (com apoio do Engineer), gera Project Charter, **contrata** um ou mais PMs conforme squads definidas pelo Engineer; informa SPEC quando finalizado ou bloqueado. |
| **Engineer** | Decisões **técnicas**; analisa a spec e define squads/equipes (backend, web, mobile) e dependências; comunica-se **apenas** com o CTO; devolve proposta técnica para o Charter. |
| **PM** | Backlog por FR/NFR; gerencia sua squad; **contrata** Dev(s), QA(s) — sempre em par (1 QA por Dev) —, **um** DevOps e **um** Monitor por squad; atribui atividades; recebe status do Monitor. |
| **Dev** | Especialista em implementação contínua; desenvolve tarefas conforme skills; é acompanhado pelo Monitor; refaz/melhora quando QA indica (via Monitor). |
| **QA** | Especialista em testes, documentação, validação contínua, QA Report; é **acionado pelo Monitor** para testar atividades finalizadas; bloqueia regressões. |
| **DevOps** | Especialista em IaC, CI/CD, deploy, banco de dados, smoke tests; é **acionado pelo Monitor** para provisionamento total ou parcial. |
| **Monitor** | Acompanha Dev/QA; **aciona** QA para testes e DevOps para provisionamento; informa PM (PM escala ao CTO quando crítico). |

**Hierarquia de comunicação**: SPEC ↔ CTO ↔ **Engineer** (CTO e Engineer no mesmo nível). CTO ↔ PM. PM atribui atividades a Dev, QA e DevOps. Monitor ↔ Dev, Monitor ↔ QA, Monitor ↔ DevOps; Monitor → PM.

Documentação completa (comportamentos, hierarquia e diagramas Mermaid): **[project/docs/ACTORS_AND_RESPONSIBILITIES.md](project/docs/ACTORS_AND_RESPONSIBILITIES.md)**. Diagramas visuais: **[ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md)**.

## 🔄 Orquestração Event-Driven

Fluxo baseado em eventos padronizados:
`project.created`, `task.assigned`, `qa.failed`, `devops.deployed`, `project.completed`, entre outros.

Quando o portal inicia o pipeline, o **runner** executa o **fluxo V2**: **CTO spec review** → **loop CTO↔Engineer** (max 3 rodadas) → Charter → **PM** (módulo backend) → seed de tarefas → **Monitor Loop** (Dev/QA/DevOps) até o usuário **aceitar o projeto** ou **parar**. Cada task segue uma **State Machine** formal. Detalhes: **[project/docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](project/docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md)**.

## 📂 Estrutura do Projeto

```
Zentriz-Genesis/
├─ project/              # Documentação e artefatos do projeto (não distribuição)
│   ├─ docs/             # adr/, rfc/, guias (ver project/docs/PROJECT_STRUCTURE_AND_REFACTORING.md)
│   ├─ context/          # Contexto para novos chats e onboarding
│   ├─ spec/             # PRODUCT_SPEC.md, template
│   ├─ reports/          # Templates de relatório
│   ├─ tests/            # smoke, etc.
│   ├─ infra/            # IaC (aws/, azure/, gcp/)
│   ├─ k8s/              # Manifests Kubernetes
│   ├─ examples/         # Exemplos
│   └─ scripts/          # Scripts de manutenção
└─ applications/         # Produto final
    ├─ agents/           # cto/, engineer/, pm/, dev/, qa/, devops/, monitor/
    ├─ orchestrator/     # Runner, agents server
    ├─ contracts/        # DoD, envelopes, checklists
    ├─ services/         # api-node
    └─ apps/             # genesis-web
```

## 📚 Contexto para Novos Chats e Onboarding

O projeto Zentriz Genesis é extenso, com dezenas de documentos e múltiplas camadas. Para facilitar a **continuidade entre sessões** e o **onboarding de novos chats** (assistentes de IA) ou desenvolvedores:

- **Pasta `project/context/`**: Armazena documentos de contexto que condensam o cenário completo do projeto.
- **Próximo chat / novo trabalho?** Leia [project/context/NEXT_CHAT_CONTEXT.md](project/context/NEXT_CHAT_CONTEXT.md) para o estado recente e orientação; depois [project/context/PROJECT_OVERVIEW.md](project/context/PROJECT_OVERVIEW.md) para o contexto completo.
- **Referência rápida?** Consulte [project/context/QUICK_REFERENCE.md](project/context/QUICK_REFERENCE.md).
- **Detalhes**: Veja [project/context/README.md](project/context/README.md) para entender o propósito e uso da pasta.

Essa abordagem permite que **novos chats aproveitem o contexto dos chats anteriores**, mantendo consistência e evitando perda de conhecimento entre sessões de trabalho.

## 📜 Documentos Fundamentais

- [PRODUCT_SPEC.md](project/spec/PRODUCT_SPEC.md)
- **[ACTORS_AND_RESPONSIBILITIES.md](project/docs/ACTORS_AND_RESPONSIBILITIES.md)** — Atores, responsabilidades e hierarquia de comunicação
- **[CONNECT_DEADPOOL_READY_CHECKLIST.md](project/docs/CONNECT_DEADPOOL_READY_CHECKLIST.md)** — Contratos mínimos do Connect para tornar o Genesis Deadpool Ready
- [ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md) — Diagramas Mermaid (fluxo, squads, etapas)
- [PROJECT_CHARTER.md](project/docs/PROJECT_CHARTER.md)
- [ARCHITECTURE.md](project/docs/ARCHITECTURE.md)
- [BACKLOG_*.md](project/docs/BACKLOG_BACKEND.md)
- [ORCHESTRATOR_BLUEPRINT.md](project/docs/ORCHESTRATOR_BLUEPRINT.md)
- [TASK_STATE_MACHINE.md](project/docs/TASK_STATE_MACHINE.md)
- [DEPLOYMENT.md](project/docs/DEPLOYMENT.md) — Deploy local (inclui uso do script [deploy-docker.sh](deploy-docker.sh)), Kubernetes, CI/CD

### Testar tudo no Docker (portal + pipeline)

1. Configure `.env` na raiz com pelo menos `CLAUDE_API_KEY` (e opcionalmente `JWT_SECRET`).
2. Execute `./deploy-docker.sh --create` (ou `./deploy-docker.sh` para atualizar).
3. Acesse o portal em **http://localhost:3001**; a API em **http://localhost:3000**.
4. Faça login (usuários do seed: ver `applications/services/api-node/README.md`), crie um projeto e envie uma spec em **Markdown**.
5. Na página do projeto, clique em **Iniciar pipeline**. O runner (serviço `runner`) executa o fluxo V2 (CTO spec review → CTO↔Engineer → PM → Monitor Loop) em background; o diálogo e o status são atualizados na página (polling).
- [STATUS.md](project/docs/STATUS.md)
- **[project/context/PROJECT_OVERVIEW.md](project/context/PROJECT_OVERVIEW.md)** — Contexto completo para novos chats e onboarding
- **[project/docs/adr/](project/docs/adr/)** — Architecture Decision Records (decisões arquiteturais)
- **[project/docs/rfc/](project/docs/rfc/)** — Request for Comments (propostas formais)
- **[project/docs/AGENTS_CAPABILITIES.md](project/docs/AGENTS_CAPABILITIES.md)** — Documentação consolidada de agentes
- **[project/docs/PERFORMANCE_METRICS.md](project/docs/PERFORMANCE_METRICS.md)** — Targets de latência, cobertura e qualidade
- **[project/docs/NAVIGATION.md](project/docs/NAVIGATION.md)** — Índice central de links para navegação
- **[project/docs/PROJECT_STRUCTURE_AND_REFACTORING.md](project/docs/PROJECT_STRUCTURE_AND_REFACTORING.md)** — Estrutura e refatoração project/ e applications/

## ✅ Qualidade e Governança

- [Definition of Done](applications/contracts/global_definition_of_done.md) global e [DevOps](applications/contracts/devops_definition_of_done.md)
- [Checklists](applications/contracts/checklists/) por squad (React, RN, Backend)
- Testes automatizados e [smoke tests](project/tests/smoke/) pós-deploy

## 🌐 Clouds Suportadas

- AWS
- Azure
- GCP

## 🧬 O que é o Zentriz Genesis
- Um framework de engenharia orientado a agentes

---

## Ativar agente git ssh
```
$ eval "$(ssh-agent -s)"

$ ssh-add
```

---

**Zentriz Genesis** — Engenharia de Software Autônoma por Design.