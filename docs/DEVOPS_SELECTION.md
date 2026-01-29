# Seleção automática do DevOps Agent (por PM)

## Regra
O PM deve selecionar o DevOps Agent baseado em `constraints.cloud` (na mensagem recebida do CTO) e instanciá-lo como parte do squad.

### Mapeamento
- `constraints.cloud = "AWS"`   -> `DEVOPS_AWS`   ([agents/devops-aws/](../agents/devops-aws/))
- `constraints.cloud = "Azure"` -> `DEVOPS_AZURE` ([agents/devops-azure/](../agents/devops-azure/))
- `constraints.cloud = "GCP"`   -> `DEVOPS_GCP`   ([agents/devops-gcp/](../agents/devops-gcp/))

## Quando instanciar
- Sempre que houver entregas com **deploy** e/ou **infra** (Backend/Web/Mobile).
- Em projetos “somente código local” (POC), o PM pode marcar como opcional, mas deve justificar no Status.

## Saída esperada do PM
- Backlog inclui pelo menos 1 task de DevOps:
  - IaC
  - CI/CD
  - Observabilidade mínima
  - Smoke tests pós-deploy
  - Runbook ([docs/DEPLOYMENT.md](DEPLOYMENT.md))
