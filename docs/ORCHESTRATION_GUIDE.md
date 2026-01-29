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

## 6) Monitor (por módulo)
- **Monitor_<AREA>** (Backend, Web, Mobile, Infra): monitora **Dev_<AREA>** e **QA_<AREA>** do seu módulo.
- Objetivo: entender **progresso**, **status de andamento** das atividades, evidências, bloqueios.
- Detecta travas, loops, falhas recorrentes.
- **Informa ao PM_<AREA>** responsável pelo módulo (progresso, status, alertas).
- Gera [reports/MONITOR_HEALTH_TEMPLATE.md](../reports/MONITOR_HEALTH_TEMPLATE.md) (por área).
- **Fluxo**: Monitor → PM_<AREA> → CTO. PM avalia, toma ação ou escala ao CTO quando crítico.

## 7) Encerramento
- PM aprova módulo.
- CTO consolida e marca DONE.

## 3.1) DevOps por Cloud (parte do squad)
- PM decide o provedor (AWS/Azure/GCP).
- Instancia **DEVOPS_<CLOUD>** para o módulo.
- DevOps prepara IaC + CI/CD + Observabilidade e apoia o Dev no deploy.
