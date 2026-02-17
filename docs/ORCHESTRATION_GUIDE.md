# Guia de Orquestração — Zentriz Genesis

> Fluxo alinhado à hierarquia de comunicação e responsabilidades em [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md).

---

## 1) Entrada

- **SPEC** (pessoa real) fornece a especificação em [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) com FR/NFR, ou via **upload no portal** (genesis-web). O portal aceita formatos **.md, .txt, .doc/.docx e .pdf**; quando não for .md, um **conversor** do orquestrador gera Markdown formatado e o CTO recebe apenas esse .md. Detalhes: [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
- SPEC comunica-se **apenas** com o CTO.

---

## 2) CTO

- Recebe a spec e interpreta requisitos e constraints.
- Gera [docs/PROJECT_CHARTER.md](PROJECT_CHARTER.md).
- **Contrata** um ou mais PMs conforme as skills necessárias (Backend, Web, Mobile).
- Cria [docs/STATUS.md](STATUS.md) inicial.
- Delega cada stack ao PM responsável (CTO não atribui tarefas a Dev/QA/DevOps/Monitor).
- Ao final, informa ao **SPEC** quando o projeto está finalizado ou quando há bloqueios que exigem decisão.

**Implementação:** Agente CTO em [orchestrator/agents/cto_agent.py](../orchestrator/agents/cto_agent.py). Runner que executa o fluxo spec → CTO → PM Backend: `python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md` ([orchestrator/README.md](../orchestrator/README.md)).

---

## 3) PM (por stack)

- Recebe do CTO o escopo da stack.
- Cria backlog: lista de tasks com FR/NFR (usa [contracts/pm_backlog_template.md](../contracts/pm_backlog_template.md)).
- **Contrata** os atores da stack:
  - **1 ou N pares Dev–QA** (sempre 1 QA para 1 Dev), conforme tamanho e complexidade;
  - **um** DevOps (por cloud: AWS/Azure/GCP — [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md));
  - **um** Monitor.
- Stacks formadas **apenas por atores com as mesmas skills** (ex.: stack Backend → dev/backend/nodejs, qa/backend/nodejs ou lambdas, monitor/backend). Estrutura: [agents/README.md](../agents/README.md).
- **Atribui atividades** a Dev, QA e DevOps (não recebe resultado de testes diretamente do QA — o Monitor orquestra).
- Define DoD específico (linka o [contracts/global_definition_of_done.md](../contracts/global_definition_of_done.md)).
- Recebe do **Monitor** o status de andamento e finalização das atividades.
- Informa ao CTO quando o projeto da stack foi finalizado ou há bloqueios.

---

## 4) Dev

- Recebe **atividades do PM** (não do CTO nem do SPEC).
- Desenvolve de forma contínua (implementação, testes, documentação).
- É **acompanhado** pelo Monitor (progresso, status).
- Quando finaliza uma atividade, o **Monitor** aciona o QA para testes.
- Se o QA reportar problemas, o **Monitor** informa ao Dev para refazer ou melhorar.
- Sempre devolve evidências: arquivos alterados, comandos de teste, logs.

---

## 5) QA

- Recebe **atividades do PM** (o que validar).
- É **acionado pelo Monitor** para realizar testes em atividades finalizadas pelo Dev.
- Retorna ao Monitor: **OK** ou **precisa voltar para o Dev** (com relatório acionável).
- Mantém [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md) (por área).
- Bloqueia (QA_FAIL) se requisitos não atendidos, com referência a FR/NFR.

---

## 6) Monitor (por stack)

- **Acompanha** Dev_<AREA> e QA_<AREA> do módulo (progresso, status de andamento, evidências).
- **Aciona o QA** para realizar testes quando o Dev finaliza uma atividade.
- **Recebe do QA**: está tudo OK ou precisa voltar para o Dev; em caso de refazer, **informa ao Dev** (com base no relatório do QA).
- **Aciona o DevOps** para provisionamento da aplicação — **total** ou **parcial** (parcial quando já puder fornecer produto funcional parcialmente).
- Detecta travas, loops, falhas recorrentes.
- **Informa ao PM_<AREA>** (progresso, status, alertas). Gera [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md) (por área).
- PM avalia e **escala ao CTO** quando crítico.

---

## 7) DevOps (por cloud)

- Recebe **atividades do PM**.
- É **acionado pelo Monitor** para realizar provisionamento (total ou parcial).
- Entrega: IaC, CI/CD, deploy, banco de dados (esquema, migrações quando aplicável), smoke tests pós-deploy, runbook.
- Usa [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md) e [tests/smoke/](../tests/smoke/).

---

## 8) Encerramento

- PM aprova módulo com base nas informações do Monitor e evidências (QA Report, etc.).
- CTO consolida status de todos os PMs e marca projeto como DONE (ou registra bloqueios).
- CTO informa ao **SPEC** que o projeto foi finalizado ou que há bloqueios.

---

## Referências

- [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md) — Atores, responsabilidades e hierarquia
- [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md) — Diagramas Mermaid
- [docs/TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) — Composição da stack
