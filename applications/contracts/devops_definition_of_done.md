# Definition of Done (DevOps por Cloud)

Uma entrega de DevOps é considerada **DONE** somente se:

## IaC e repetibilidade
- [ ] Existe IaC em [infra/](../infra/) (aws/, azure/, gcp/) (Terraform/CDK/Bicep/etc.)
- [ ] IaC tem variáveis/parametrização para env (dev/staging/prod)
- [ ] IaC documentado (README + comandos)

## CI/CD
- [ ] Pipeline executa: lint -> test -> build -> deploy
- [ ] Pipeline gera artefatos e logs rastreáveis por `request_id`/commit
- [ ] Ambiente dev/staging provisionado automaticamente

## Observabilidade mínima (NFR-03)
- [ ] Logs estruturados (JSON) e correlação por `request_id`
- [ ] Métrica mínima: erros 4xx/5xx e latência (p95)
- [ ] Alarmes básicos definidos (erro elevado / latência alta)

## Segurança mínima (NFR-02)
- [ ] Secrets fora do código (vars/secret manager)
- [ ] Permissões com menor privilégio viável (IAM/Entra/IAM GCP)
- [ ] Política de CORS/headers aplicada (quando web/api)

## Smoke tests
- [ ] Smoke test pós-deploy executado e evidenciado
- [ ] Endpoint de healthcheck definido (quando aplicável)

## Runbook
- [ ] [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) atualizado com:
  - como deployar
  - rollback
  - troubleshooting rápido
