# Guia de Orquestração — Zentriz Genesis

> Fluxo alinhado à hierarquia de comunicação e responsabilidades em [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md).

---

## 1) Entrada

- **SPEC** (pessoa real) fornece a especificação em [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) com FR/NFR, ou via **upload no portal** (genesis-web). O portal aceita formatos **.md, .txt, .doc/.docx e .pdf**; quando não for .md, um **conversor** do orquestrador gera Markdown formatado e o CTO recebe apenas esse .md. Detalhes: [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
- SPEC comunica-se **apenas** com o CTO.

---

## 2) Engineer (antes do CTO)

- **CTO** envia a spec (e contexto) ao **Engineer**.
- **Engineer** analisa e devolve **proposta técnica**: quais squads/equipes o projeto precisa (ex.: web básica para landings, web avançada para app com API/auth, backend para APIs) e **dependências** entre equipes (ex.: Web SaaS depende de Backend API — obter URLs e endpoints via CTO).
- Engineer comunica-se **apenas** com o CTO. Competências em [agents/engineer/skills.md](../../applications/agents/engineer/skills.md).

**Implementação (fluxo V2):** Runner faz **CTO spec review** primeiro; depois **loop CTO↔Engineer** (max 3 rodadas): CTO envia spec (e questionamentos se rodada >1) ao Engineer; Engineer devolve proposta; CTO valida ou questiona até Charter. Endpoint `POST /invoke/engineer`; Engineer recebe `context.cto_questionamentos` quando houver. Ver [PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md](PIPELINE_V2_AUTONOMOUS_FLOW_PLAN.md).

---

## 3) CTO

- Recebe a spec e **primeiro fala com o Engineer**; usa a proposta técnica para decidir squads e dependências.
- Gera [docs/PROJECT_CHARTER.md](PROJECT_CHARTER.md) com base na proposta do Engineer.
- **Contrata** um ou mais PMs conforme as squads/equipes definidas pelo Engineer (Backend, Web Básica, Web Avançada, Mobile).
- Cria [docs/STATUS.md](STATUS.md) inicial.
- Delega cada squad ao PM e informa **dependências** (ex.: “PM Web: obter lista de endpoints do PM Backend via mim”). PMs **conversam entre si via CTO** (não diretamente).
- Ao final, informa ao **SPEC** quando o projeto está finalizado ou quando há bloqueios que exigem decisão.
- Em **bloqueios cross-team** (ex.: endpoint falhou), CTO pode consultar o Engineer para solução e repassar ao PM responsável.

**Implementação (fluxo V2):** Runner: **CTO spec review** (entende spec, grava em docs) → **loop CTO↔Engineer** → Charter → **PM** (com module e proposta) → seed tasks → Monitor Loop. Agente CTO: [orchestrator/agents/cto](../../applications/agents/cto). Runner: `python -m orchestrator.runner --spec project/spec/PRODUCT_SPEC.md` ou via API com PROJECT_ID.

---

## 4) PM (por squad)

- Recebe do CTO o escopo da squad.
- Cria backlog: lista de tasks com FR/NFR (usa [contracts/pm_backlog_template.md](../contracts/pm_backlog_template.md)).
- **Contrata** os atores da squad:
  - **1 ou N pares Dev–QA** (sempre 1 QA para 1 Dev), conforme tamanho e complexidade;
  - **um** DevOps (por cloud: AWS/Azure/GCP — [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md));
  - **um** Monitor.
- Squads formadas **apenas por atores com as mesmas skills** (ex.: squad Backend → dev/backend/nodejs, qa/backend/nodejs ou lambdas, monitor/backend). Estrutura: [agents/README.md](../agents/README.md).
- **Atribui atividades** a Dev, QA e DevOps (não recebe resultado de testes diretamente do QA — o Monitor orquestra).
- Define DoD específico (linka o [contracts/global_definition_of_done.md](../contracts/global_definition_of_done.md)).
- Recebe do **Monitor** o status de andamento e finalização das atividades.
- Informa ao CTO quando o projeto da squad foi finalizado ou há bloqueios.

---

## 5) Dev

- Recebe **atividades do PM** (não do CTO nem do SPEC).
- Desenvolve de forma contínua (implementação, testes, documentação).
- É **acompanhado** pelo Monitor (progresso, status).
- Quando finaliza uma atividade, o **Monitor** aciona o QA para testes.
- Se o QA reportar problemas, o **Monitor** informa ao Dev para refazer ou melhorar.
- Sempre devolve evidências: arquivos alterados, comandos de teste, logs.

---

## 6) QA

- Recebe **atividades do PM** (o que validar).
- É **acionado pelo Monitor** para realizar testes em atividades finalizadas pelo Dev.
- Retorna ao Monitor: **OK** ou **precisa voltar para o Dev** (com relatório acionável).
- Mantém [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md) (por área).
- Bloqueia (QA_FAIL) se requisitos não atendidos, com referência a FR/NFR.

---

## 7) Monitor (por squad)

- **Acompanha** Dev_<AREA> e QA_<AREA> do módulo (progresso, status de andamento, evidências).
- **Aciona o QA** para realizar testes quando o Dev finaliza uma atividade.
- **Recebe do QA**: está tudo OK ou precisa voltar para o Dev; em caso de refazer, **informa ao Dev** (com base no relatório do QA). **Após bloqueio resolvido (PM/CTO)**, o **Monitor** reativa o Dev (reaciona o agente para a task desbloqueada).
- **Aciona o DevOps** para provisionamento da aplicação — **total** ou **parcial** (parcial quando já puder fornecer produto funcional parcialmente).
- Detecta travas, loops, falhas recorrentes.
- **Informa ao PM_<AREA>** (progresso, status, alertas). Gera [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md) (por área).
- PM avalia e **escala ao CTO** quando crítico.

**Implementação (portal + API):** O runner, após PM Backend, entra no **Monitor Loop** (Fase 2): lê estado das tasks na API, decide qual agente acionar (Dev/QA/DevOps), invoca e atualiza tasks; o loop só encerra quando o usuário clica em **Aceitar projeto** no portal (POST `/api/projects/:id/accept`) ou em **Parar**. Ver [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).

---

## 8) DevOps (por cloud)

- Recebe **atividades do PM**.
- É **acionado pelo Monitor** para realizar provisionamento (total ou parcial).
- Entrega: IaC, CI/CD, deploy, banco de dados (esquema, migrações quando aplicável), smoke tests pós-deploy, runbook.
- Usa [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md) e [tests/smoke/](../tests/smoke/).

---

## 9) Encerramento

- PM aprova módulo com base nas informações do Monitor e evidências (QA Report, etc.).
- CTO consolida status de todos os PMs e marca projeto como DONE (ou registra bloqueios).
- CTO informa ao **SPEC** que o projeto foi finalizado ou que há bloqueios.

---

## Referências

- [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md) — Atores, responsabilidades e hierarquia
- [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md) — Diagramas Mermaid
- [docs/TEAM_COMPOSITION.md](TEAM_COMPOSITION.md) — Composição da squad
