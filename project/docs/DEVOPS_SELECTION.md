# Seleção automática do DevOps Agent (por PM)

## Contexto: Engineer e squads do projeto
A **proposta do Engineer** (squads/equipes necessárias) define *quais* PMs são acionados pelo CTO (ex.: PM Backend, PM Web). Cada PM é responsável por sua squad e, ao planejar entregas com deploy ou infra, aplica as regras abaixo. O Engineer não escolhe o agente DevOps; a **seleção do agente DevOps** é de responsabilidade do **PM** conforme este documento.

## Regra
O PM deve instanciar o **DevOps Docker** como base em todo projeto (provisionamento via Docker, Terraform e k8s em qualquer infra). Em seguida, quando houver deploy em cloud, selecionar o DevOps da cloud conforme `constraints.cloud`.

### DevOps Docker (sempre primeiro)
- **devops/docker** ([agents/devops/docker/](../agents/devops/docker/)) — Base: Docker (namespace `zentriz-genesis`), Terraform e Kubernetes. Deve ser acionado **antes** dos demais; toda a stack local e a IaC (Terraform/k8s) partem daqui. Ver [docs/TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) e [context/DEVELOPMENT_CONTEXT.md](../context/DEVELOPMENT_CONTEXT.md).

### Mapeamento por cloud (quando deploy em cloud)
- `constraints.cloud = "AWS"`   -> DevOps AWS   ([agents/devops/aws/](../agents/devops/aws/))
- `constraints.cloud = "Azure"` -> DevOps Azure ([agents/devops/azure/](../agents/devops/azure/))
- `constraints.cloud = "GCP"`   -> DevOps GCP   ([agents/devops/gcp/](../agents/devops/gcp/))

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
