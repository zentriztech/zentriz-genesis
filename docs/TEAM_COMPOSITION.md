# Composição de Times (por Módulo)

Cada módulo (Backend, Web, Mobile) pode operar com o seguinte squad padrão:

- **PM_<AREA>**: define backlog e aprova
- **DEV_<AREA>**: implementa features
- **QA_<AREA>**: valida continuamente e gera QA report
- **DEVOPS_<CLOUD>**: provisiona e opera o deploy no provedor alvo

## DevOps por Cloud
- **DEVOPS_AWS**: AWS (Lambda, API Gateway, DynamoDB/RDS, S3, CloudFront, IAM, CloudWatch, etc.)
- **DEVOPS_AZURE**: Azure (Functions, API Management, Cosmos/SQL, Storage, Front Door, Entra ID, App Insights, etc.)
- **DEVOPS_GCP**: GCP (Cloud Functions/Run, API Gateway, Firestore/Cloud SQL, Storage, Cloud CDN, IAM, Cloud Logging, etc.)

## Regras
- O PM escolhe o provedor com base em `constraints.cloud` do spec/charter.
- DevOps deve entregar: IaC + CI/CD + Observabilidade mínima + runbook ([docs/DEPLOYMENT.md](DEPLOYMENT.md)).
- QA valida também o deploy (smoke tests e evidências).

## Definition of Done DevOps
- Referência: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)

## Smoke tests
- Templates: [tests/smoke/](../tests/smoke/)
- DevOps deve plugar smoke tests no pipeline após deploy.
