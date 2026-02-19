# Composição de Times (por Squad) — Zentriz Genesis

> Regras alinhadas a [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md).

---

## Regras de composição

Cada **squad** (Backend, Web, Mobile) é formada **apenas por atores com as mesmas skills**. A infraestrutura (IaC, CI/CD) faz parte de cada squad via **DevOps**; não existe squad "Infra" nem atores PM/Dev/QA/Monitor Infra. O **PM** da squad é responsável por **contratar** (instanciar) os atores.

| Papel | Quantidade por squad | Observação |
|-------|----------------------|------------|
| **PM_<AREA>** | 1 | Gerencia a squad; cria backlog; atribui atividades. |
| **Dev_<AREA>** | 1 ou N | Sempre em par com QA (1 QA por 1 Dev). |
| **QA_<AREA>** | 1 ou N | Um QA para cada Dev (par Dev–QA). |
| **Monitor_<AREA>** | 1 | Acompanha Dev/QA; aciona QA e DevOps; informa PM. |
| **DevOps_<CLOUD>** | 1 | Por projeto/squad; escolhido por cloud (AWS, Azure ou GCP). |

---

## Exemplo: Squad Backend

- **PM Backend**: 1
- **Dev Backend**: 1 ou mais (conforme complexidade)
- **QA Backend**: mesmo número de Devs (par Dev–QA)
- **Monitor Backend**: 1
- **DevOps** (AWS ou Azure ou GCP): 1

O PM atribui atividades aos Devs e QAs; não recebe resultado de testes diretamente do QA — o **Monitor** aciona o QA para testes e recebe OK ou “volta para Dev”, e informa o PM sobre status e andamento.

---

## DevOps por Cloud

- **devops/aws**: AWS (Lambda, API Gateway, DynamoDB/RDS, S3, CloudFront, IAM, CloudWatch, etc.)
- **devops/azure**: Azure (Functions, API Management, Cosmos/SQL, Storage, Front Door, Entra ID, App Insights, etc.)
- **devops/gcp**: GCP (Cloud Functions/Run, API Gateway, Firestore/Cloud SQL, Storage, Cloud CDN, IAM, Cloud Logging, etc.)

O PM escolhe o provedor com base em `constraints.cloud` do spec/charter — [docs/DEVOPS_SELECTION.md](DEVOPS_SELECTION.md). Agentes em [agents/devops/](../agents/devops/).

---

## Fluxo de comunicação na squad

- **PM → Dev, QA, DevOps**: atribui atividades.
- **Monitor ↔ Dev**: acompanha desenvolvimento; informa refazer/melhorar quando QA indica.
- **Monitor ↔ QA**: Monitor aciona testes; QA retorna OK ou volta para Dev.
- **Monitor ↔ DevOps**: Monitor aciona provisionamento (total ou parcial).
- **Monitor → PM**: status de andamento, finalização, alertas (`monitor.alert`).
- **PM → CTO**: conclusão da squad ou bloqueios.

---

## Regras técnicas

- DevOps entrega: IaC + CI/CD + Observabilidade mínima + runbook ([docs/DEPLOYMENT.md](DEPLOYMENT.md)); também responsável por banco de dados (esquema, migrações quando aplicável).
- QA valida com smoke tests e evidências pós-deploy.
- Definition of Done DevOps: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)
- Smoke tests: [tests/smoke/](../tests/smoke/) — DevOps pluga no pipeline após deploy.
