# Guia de Orquestração (CTO -> PM -> Dev/QA -> Monitor)

## 1) Entrada
- Spec em [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md) com FR/NFR.

## 2) CTO
- Gera [docs/PROJECT_CHARTER.md](PROJECT_CHARTER.md).
- Decide PMs necessários (backend/web/mobile/infra).
- Cria [docs/STATUS.md](STATUS.md) inicial.

## 3) PM
- Cria backlog: lista de tasks com FR/NFR.
- Instancia Dev+QA (N instâncias conforme workload).
- Define DoD específico (linka o global).

## 4) Dev
- Implementa incremental.
- Sempre devolve evidências: arquivos alterados, comandos de teste, etc.

## 5) QA
- Roda validações contínuas.
- Mantém [reports/QA_REPORT_TEMPLATE.md](../reports/QA_REPORT_TEMPLATE.md) (por área).
- Bloqueia (FAIL) se requisitos não atendidos.

## 6) Monitor
- Observa histórico de respostas/relatórios.
- Gera [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md) (por área) e alerta PM/CTO.

## 7) Encerramento
- PM aprova módulo.
- CTO consolida e marca DONE.

## 3.1) DevOps por Cloud (parte do squad)
- PM decide o provedor (AWS/Azure/GCP).
- Instancia **DEVOPS_<CLOUD>** para o módulo.
- DevOps prepara IaC + CI/CD + Observabilidade e apoia o Dev no deploy.
