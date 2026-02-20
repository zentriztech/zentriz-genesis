# 🚀 Zentriz Genesis  
**Autonomous Multi-Agent Software Factory**

Zentriz Genesis is an **AI Agent Orchestration Platform** capable of **conceiving, planning, developing, validating, provisioning, and monitoring complete software systems** from **technical specification documents**.

The project implements an **autonomous software factory**, specification-oriented (*spec-driven*), composed of specialized agents acting as **CTO, Engineer, PMs, Developers, QA, DevOps, and Monitors**, working in a coordinated, traceable, and auditable way.

## 🎯 Project Objective

Allow a single specification document ([`PRODUCT_SPEC.md`](project/spec/PRODUCT_SPEC.md)) to be sufficient to:

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
Interprets the spec (with Engineer input), creates the Project Charter, hires PM(s), and consolidates status. In **flow V2**: CTO spec review first, then loop with Engineer (max 3 rounds) until Charter.

### Engineer Agent
Technical decisions; analyzes the spec and defines squads/teams (backend, web, mobile) and dependencies; communicates **only** with the CTO; delivers technical proposal for the Charter.

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
Monitor **Dev/QA** per squad (Backend, Web, Mobile) — progress, activity status — and **inform the responsible PM** (who escalates to CTO when critical).

## 🔄 Event-Driven Orchestration

Workflow based on standardized events:  
`project.created`, `task.assigned`, `qa.failed`, `devops.deployed`, `project.completed`, among others.

When the portal starts the pipeline, the **runner** runs **flow V2**: **CTO spec review** → **CTO↔Engineer loop** (max 3 rounds) → Charter → **PM** (backend module) → seed tasks → **Monitor Loop** (Dev/QA/DevOps) until the user **accepts** or **stops**. Each task follows a formal **State Machine**. See [project/docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](project/docs/PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).

## 📂 Project Structure

```
Zentriz-Genesis/
├─ project/           # Docs, context, spec, scripts, infra, k8s (see project/docs/PROJECT_STRUCTURE_AND_REFACTORING.md)
└─ applications/     # agents, orchestrator, contracts, services, apps
```

## 📚 Context for New Chats and Onboarding

The Zentriz Genesis project is extensive, with dozens of documents and multiple layers. To facilitate **continuity between sessions** and **onboarding of new chats** (AI assistants) or developers:

- **`project/context/` folder**: Stores context documents that summarize the full project scenario.
- **New chat starting work?** Read [context/PROJECT_OVERVIEW.md](context/PROJECT_OVERVIEW.md) to load the full context without traversing all .md files in the repository.
- **Quick reference?** See [context/QUICK_REFERENCE.md](project/context/QUICK_REFERENCE.md).
- **Details**: See [context/README.md](project/context/README.md) for the purpose and usage of this folder.

This approach allows **new chats to leverage context from previous chats**, maintaining consistency and avoiding knowledge loss between work sessions.

## 📜 Core Documents

- [PRODUCT_SPEC.md](project/spec/PRODUCT_SPEC.md)
- [PROJECT_CHARTER.md](project/docs/PROJECT_CHARTER.md)
- [ARCHITECTURE.md](project/docs/ARCHITECTURE.md)
- [BACKLOG_*.md](project/docs/BACKLOG_BACKEND.md)
- [ORCHESTRATOR_BLUEPRINT.md](project/docs/ORCHESTRATOR_BLUEPRINT.md)
- [TASK_STATE_MACHINE.md](project/docs/TASK_STATE_MACHINE.md)
- [DEPLOYMENT.md](project/docs/DEPLOYMENT.md)
- [STATUS.md](project/docs/STATUS.md)
- **[context/PROJECT_OVERVIEW.md](project/context/PROJECT_OVERVIEW.md)** — Full context for new chats and onboarding

## ✅ Quality and Governance

- [Global Definition of Done](applications/contracts/global_definition_of_done.md) (including [DevOps](applications/contracts/devops_definition_of_done.md))
- [Stack checklists](applications/contracts/checklists/) (React, RN, Backend)
- Automated tests and [post-deploy smoke tests](project/tests/smoke/)

## 🌐 Supported Clouds

- AWS
- Azure
- GCP

## 🧬 What is Zentriz Genesis
- An agent-oriented software engineering framework

---

**Zentriz Genesis** — Autonomous Software Engineering by Design.
