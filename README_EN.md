# 🚀 Zentriz Genesis  
**Autonomous Multi-Agent Software Factory**

Zentriz Genesis is an **AI Agent Orchestration Platform** capable of **conceiving, planning, developing, validating, provisioning, and monitoring complete software systems** from **technical specification documents**.

The project implements an **autonomous software factory**, specification-oriented (*spec-driven*), composed of specialized agents acting as **CTO, PMs, Developers, QA, DevOps, and Monitors**, working in a coordinated, traceable, and auditable way.

## 🎯 Project Objective

Allow a single specification document ([`PRODUCT_SPEC.md`](spec/PRODUCT_SPEC.md)) to be sufficient to:

- Plan complex projects (API, Web, Mobile, Infrastructure)
- Automatically assemble virtual squads by specialty
- Develop complete applications (backend, frontend, mobile)
- Provision infrastructure on **AWS, Azure, or GCP**
- Run continuous QA and automated tests
- Operate in an **event-driven**, parallel, and observable manner
- Deliver software with **evidence, traceability, and governance**

## 🧠 Key Concepts

- **Spec-Driven Development**
- **Multi-Agent Architecture**
- **Event-Driven Orchestration**
- **Cloud-Agnostic / Serverless-First**
- **Governance and Quality by Design**

## 🏗️ Agent Architecture

### CTO Agent (Orchestrator)
Responsible for interpreting the Product Spec, creating the Project Charter, defining modules, delegating PMs, and consolidating the final project status.

### PM Agents (by specialty)
Backend, Web, Mobile, and Infrastructure.  
They automatically generate backlogs from FR/NFRs, instantiate Dev/QA/DevOps agents, and approve deliverables.

### Dev Agents
Implement code, tests, and documentation according to the backlog.

### QA Agents
Perform continuous validation, generate QA Reports, and block regressions.

### DevOps Agents (by Cloud)
AWS, Azure, and GCP.  
They provision infrastructure, CI/CD, observability, and execute smoke tests.

### Monitor Agents
Monitor agent health, detect failures, and alert PMs/CTO.

## 🔄 Event-Driven Orchestration

Workflow based on standardized events:  
`project.created`, `task.assigned`, `qa.failed`, `devops.deployed`, `project.completed`, among others.

Each task follows a formal **State Machine**, ensuring traceability and control.

## 📂 Project Structure

```
Zentriz-Genesis/
├─ spec/
├─ docs/
├─ agents/
├─ contracts/
├─ reports/
├─ tests/smoke/
├─ infra/
├─ orchestrator/
├─ services/
├─ apps/
├─ examples/
└─ context/          ← Context for new chats and onboarding
```

## 📚 Context for New Chats and Onboarding

The Zentriz Genesis project is extensive, with dozens of documents and multiple layers. To facilitate **continuity between sessions** and **onboarding of new chats** (AI assistants) or developers:

- **`context/` folder**: Stores context documents that summarize the full project scenario.
- **New chat starting work?** Read [context/PROJECT_OVERVIEW.md](context/PROJECT_OVERVIEW.md) to load the full context without traversing all .md files in the repository.
- **Quick reference?** See [context/QUICK_REFERENCE.md](context/QUICK_REFERENCE.md).
- **Details**: See [context/README.md](context/README.md) for the purpose and usage of this folder.

This approach allows **new chats to leverage context from previous chats**, maintaining consistency and avoiding knowledge loss between work sessions.

## 📜 Core Documents

- [PRODUCT_SPEC.md](spec/PRODUCT_SPEC.md)
- [PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md)
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [BACKLOG_*.md](docs/BACKLOG_BACKEND.md)
- [ORCHESTRATOR_BLUEPRINT.md](docs/ORCHESTRATOR_BLUEPRINT.md)
- [TASK_STATE_MACHINE.md](docs/TASK_STATE_MACHINE.md)
- [DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [STATUS.md](docs/STATUS.md)
- **[context/PROJECT_OVERVIEW.md](context/PROJECT_OVERVIEW.md)** — Full context for new chats and onboarding

## ✅ Quality and Governance

- [Global Definition of Done](contracts/global_definition_of_done.md) (including [DevOps](contracts/devops_definition_of_done.md))
- [Stack checklists](contracts/checklists/) (React, RN, Backend)
- Automated tests and [post-deploy smoke tests](tests/smoke/)

## 🌐 Supported Clouds

- AWS
- Azure
- GCP

## 🧬 What is Zentriz Genesis
- An agent-oriented software engineering framework

---

**Zentriz Genesis** — Autonomous Software Engineering by Design.
