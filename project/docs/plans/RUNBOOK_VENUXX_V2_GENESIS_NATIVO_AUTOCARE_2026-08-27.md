> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Runbook — Venuxx V2 nativo no Genesis + ligado ao GitHub + Auto Care monitorando

> Objetivo (pedido do Jean): obter o código-fonte dos 28 apps, **ligá-los ao GitHub remoto**,
> fazer **parecer que tudo nasceu no Genesis** (continuidade pela fábrica) e o **Auto Care (Deadpool) monitorar**.
> Continua o seed já aplicado (produto `Venuxx V2` `9c1cc97e-e43c-4c2e-a376-6fb92f4a3791`, 28 projetos).

## Decisões travadas (2026-08-27)
- **GitHub:** apontar para os repos **existentes em `venuxxtech`** (NÃO criar repos novos). `project_github_repos.repo_url → github.com/venuxxtech/venuxx-*`.
- **Auto Care:** usar **A e B** (complementares). A = registro de runtime nativo (repoUrl+installationId+endpoints → gateway Deadpool, `project_deadpool_monitoring.active=true`). B = contratos Connect (Service/Ownership/IntegrationReady) elevando `/diagnose` a Tier 1+.
- **App do GitHub:** `genezis-zentriz-autonomy-app` (install `129756252`) está no **genezis-factory**, NÃO no venuxxtech. **Jean instala o App no org `venuxxtech`** (fluxo de navegador; é owner). Sem isso, o Deadpool não consegue clonar/monitorar os repos venuxxtech de verdade.

## Contexto de infra (canônico)
- **PROD:** EC2 `3.220.66.113`, conta 820198199720, `ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113`. DB no container `zentriz-genesis-postgres-1` (db `zentriz_genesis`, user `genesis`). App dir `/opt/zentriz-genesis`.
- **tenant Venuxx:** `0931c5dc-46eb-474a-a54a-dad12733b4b2` (VENUXX TECHNOLOGIES LTDA, plan_diamante, active, billing_exempt=false — tem crédito R$462k).
- **Código-fonte local dos 28 apps:** `~/workspace/current/venuxx/v2/` (lambdas em `connect/lambdas/*`, packages em `connect/packages/*`, `portal`, `cli`=autonomy-cli dentro do orquestrador, `identity/tax/tms/maya`, `infra/terraform`, `tests`=connect-e2e). Cada lbd/pkg/serviço é repo git próprio com remote `git@github.com:venuxxtech/venuxx-*`.

## Mapa app → repo venuxxtech (26 com repo; 2 sem)
| App | Repo venuxxtech | branch |
|---|---|---|
| logistics-ingest / -admin-api / -webhook / -dlq-admin / -test-webhook-sink / -normalizer / -dlq-consumer / -outbox-publisher / -outbound-dispatcher / -dsl-ai-service / -infra | `venuxx-lbd-<app>` | main |
| core / database-drizzle / database-logistics / dynamodb / logistics-raw / template-engine / rabbitmq / infrastructure / logistics-seed | `venuxx-pkg-<app>` | main |
| portal | `venuxx-logistics-portal` | main |
| autonomy-cli | `venuxx-api-orchestrator` (subpasta `cli/`) | main |
| identity / tax / tms / maya | `venuxx-<app>` | dev |
| **infra-terraform / connect-e2e** | **sem repo** (não versionados; ambos `completed`, não `accepted`) | — |

---

## Camada 1 — Ligação ao GitHub  ✅ script pronto + dry-run PROD verde (2026-08-27)
- Arquivo: `applications/services/api-node/src/db/manual-sql/venuxx-v2-github-link.sql` (SQL puro, idempotente `ON CONFLICT`). NÃO precisa rebuild de imagem.
- Escreve 1× `tenant_github_installations` (venuxxtech, `installation_id`) + 26× `project_github_repos`.
- **Dry-run validado em PROD** (BEGIN…ROLLBACK, inst_id placeholder 129756252): `installations_venuxx=1`, `repos_linkados=26`, `apps_sem_repo={connect-e2e, infra-terraform}`. Nada persistido.
- **Pendente p/ COMMIT:** o `installation_id` REAL do venuxxtech (após o Jean instalar o App). Obter com:
  `gh api /orgs/venuxxtech/installations --jq '.installations[]|"\(.id)\t\(.app_slug)"'` (após instalar).
- Comando de COMMIT (dentro do container postgres, com o inst_id real):
  ```
  scp -i ~/.ssh/zentriz_id <sql> ubuntu@3.220.66.113:/tmp/venuxx-v2-github-link.sql
  ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 'sudo docker cp /tmp/venuxx-v2-github-link.sql zentriz-genesis-postgres-1:/tmp/link.sql && sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -v ON_ERROR_STOP=1 -v inst_id=<REAL> -c "BEGIN" -f /tmp/link.sql -c "COMMIT"'
  ```
- Rollback: bloco comentado ao final do .sql (DELETE escopado por tenant+produto).

## Camada 2 — Obter fontes na fábrica ("parecer feito no Genesis" + portal mostra Código)  ⏳ a executar
- Storage da fábrica (project_storage.py): `PROJECT_FILES_ROOT/<product_id>/<project_id>/{apps,docs,project}`. Root = `/shared/uploads` (volume do container api). O portal lê `apps/` (aba Código), `docs/manifest.json` (Docs) e `project_spec_files` (Specs).
- Plano: por app, `git archive` do branch linkado (exclui node_modules/.next/.venv) → montar árvore `<product_id>/<project_id>/apps/` → empacotar → `scp` p/ prod → `docker cp` p/ dentro do container api no path do volume → gerar `docs/manifest.json` + docs mínimos (charter/CTO/PM/Dev/QA) por projeto. product_id=9c1cc97e…; project_id de cada `SELECT id FROM projects WHERE product_id=… AND title=…`.
- ⚠️ escrita real de fonte proprietária no volume de PROD — operação de arquivos, revisar antes.

## Camada 3 — Auto Care A (runtime nativo)  ⏳ depende do App no venuxxtech
1. **Entitlement:** `tenant_entitlements(tenant_id, product='deadpool', enabled=true)` — via `PUT /api/deadpool/entitlement/:tenantId` (só zentriz_admin) ou INSERT direto (mig 046, PK (tenant_id,product)).
2. **backend_deployments** (mig 033): 1 linha `status='running'` por app **accepted** (15), com `app_url`/`health_url` reais da Venuxx (lambdas/ECS atrás de ALB) e idealmente `log_group` (hoje NULL → CloudWatch limitado; popular à mão p/ métricas). Índice único parcial `uq_backend_active_per_project` = 1 ativo/projeto.
3. **Ativar:** `POST /api/deadpool/projects/:id/activate` por app accepted (requireAdmin). Gates: entitlement + status=accepted + repo_url + installation_id + (deployment running p/ endpoints). Grava `project_deadpool_monitoring.active=true` + `POST {DEADPOOL_BASE_URL}/projects` (monitoring:true).
- ⚠️ **Verificar em PROD** que `DEADPOOL_BASE_URL`/`DEADPOOL_API_TOKEN` estão no env da api — senão `registerProjectWithDeadpool` retorna `skipped` → `/activate` responde 503.
- ⚠️ endpoints reais dos apps Venuxx: obter (API admin, tracking público, FastAPI health) antes de gravar backend_deployments.

## Camada 4 — Auto Care B (Connect / diagnose)  ⏳ a executar
- Gerar por app (accepted) os contratos em `project/connect/v1/`: `service-manifest.json` (serviceId+systemId — obrigatório), `ownership-manifest.json` (reviewers), `integration-ready-contract.json` (declaredTier ≥ tier1). Recomendados p/ tier2: runtimePassport, observabilityBaselineManifest, knownSafeActionsPack.
- Registrar via `POST /diagnose` do gateway Deadpool (`src/zentriz_deadpool/app/http_server.py`). `build_connect_support_profile` exige os 3 required p/ tier1-connect-ready.

## Ordem de execução
1. **[Jean] instala o App no venuxxtech** → pega installation_id.
2. Camada 1 `--commit` (inst_id real) + Camada 3.1 entitlement.
3. Camada 2 (fontes) — obtenção do código na fábrica.
4. Camada 4 (contratos Connect).
5. Camada 3.2/3.3 (backend_deployments + activate por app accepted).
6. Verificar portal (apps nativos, aba Código, "monitorado") + Deadpool recebendo.

## Rollback global
- Camada 1: DELETE escopado (bloco no .sql).
- Camada 2: remover `<product_id>/<project_id>/apps` do volume.
- Camada 3: `POST /deactivate` + DELETE backend_deployments + entitlement enabled=false.
- Seed base (28 projetos): `node dist/db/seed-venuxx-v2.js --rollback` (não tocar sem necessidade).
