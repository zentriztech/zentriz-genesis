# Composição de Times (por Módulo)

Cada módulo (Backend, Web, Mobile, Infra) opera com o seguinte squad padrão:

- **PM_<AREA>**: define backlog, aprova entregas e recebe alertas do Monitor
- **DEV_<AREA>**: implementa features
- **QA_<AREA>**: valida continuamente e gera QA report
- **MONITOR_<AREA>**: monitora **Dev_<AREA>** e **QA_<AREA>** do módulo (progresso, status de andamento), informa ao PM_<AREA> (que escala ao CTO quando necessário)
- **DEVOPS_<CLOUD>**: provisiona e opera o deploy no provedor alvo

## DevOps por Cloud
- **DEVOPS_AWS**: AWS (Lambda, API Gateway, DynamoDB/RDS, S3, CloudFront, IAM, CloudWatch, etc.)
- **DEVOPS_AZURE**: Azure (Functions, API Management, Cosmos/SQL, Storage, Front Door, Entra ID, App Insights, etc.)
- **DEVOPS_GCP**: GCP (Cloud Functions/Run, API Gateway, Firestore/Cloud SQL, Storage, Cloud CDN, IAM, Cloud Logging, etc.)

## Fluxo de alertas (Monitor → PM → CTO)
- **Monitor_<AREA>** monitora **Dev_<AREA>** e **QA_<AREA>** (progresso, status, evidências).
- Monitor informa ao **PM_<AREA>** responsável pelo módulo. Emite `monitor.alert` quando há risco ou bloqueio.
- PM avalia, toma ação ou escala ao CTO quando crítico.
- CTO recebe consolidação dos PMs e alertas escalados.

## Regras
- O PM escolhe o provedor com base em `constraints.cloud` do spec/charter.
- DevOps deve entregar: IaC + CI/CD + Observabilidade mínima + runbook ([docs/DEPLOYMENT.md](DEPLOYMENT.md)).
- QA valida também o deploy (smoke tests e evidências).

## Definition of Done DevOps
- Referência: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)

## Smoke tests
- Templates: [tests/smoke/](../tests/smoke/)
- DevOps deve plugar smoke tests no pipeline após deploy.
