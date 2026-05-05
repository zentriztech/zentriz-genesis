# RUNBOOK INFRA — Zentriz Cyborg

Complementa o RUNBOOK_BASE para projetos do grupo **Infra / DevOps**:
`infra_iac`, `infra_cicd`, `infra_monitoring`, `infra_data_lake`

---

## FASE 1 — Artefatos obrigatórios

- [ ] Para IaC (Terraform/CDK): `main.tf` / `lib/*.ts` presente
- [ ] Para CI/CD: `.github/workflows/*.yml` ou `.gitlab-ci.yml` presente
- [ ] Para Monitoring: `docker-compose.yml` com Prometheus/Grafana/Loki ou equivalente
- [ ] Para Data Lake: pipeline de ingestão presente (Spark, dbt, Airbyte config)
- [ ] `README.md` com instruções de execução

## FASE 1.1 — Validação estática

```bash
# Terraform
command -v terraform && terraform -chdir=$PROJECT_DIR init -backend=false && terraform -chdir=$PROJECT_DIR validate

# CDK (TypeScript)
cd $PROJECT_DIR && npx tsc --noEmit

# Docker Compose (monitoring stack)
cd $PROJECT_DIR && docker compose config 2>&1 | head -20
```

## FASE 2 — Infraestrutura (se docker-compose.yml presente)

```bash
cd $PROJECT_DIR && docker compose up -d
sleep 20
docker compose ps
docker compose logs --tail=30
```

## FASE 3 — Smoke test Infra

**Monitoring stack:**
```bash
# Prometheus
curl -sf http://localhost:9090/-/healthy
# Grafana
curl -sf http://localhost:3000/api/health
```

**IaC:** validação estática já é o smoke test — não deployar em nuvem real sem confirmação humana.

## Bugs críticos

- [ ] **B-INFRA-01**: `terraform validate` com módulo faltando → verificar `source` dos módulos
- [ ] **B-INFRA-02**: `docker-compose.yml` sem volumes para persistência → dados perdidos ao restartar
- [ ] **B-INFRA-03**: Portas de monitoring conflitando com Genesis (3000, 5432) → usar portas acima de 9000

## Critério PASS Infra

- [ ] Validação estática sem erros (terraform validate / tsc --noEmit)
- [ ] `docker compose config` sem erros (se presente)
- [ ] Containers de monitoring sobem (se presente)
- [ ] Health endpoints respondem 200
