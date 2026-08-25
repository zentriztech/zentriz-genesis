# CLAUDE.md — Zentriz Genesis (repo local)

> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br
> Lido automaticamente pelo Claude Code em toda sessão que trabalha neste repositório.
> Regras aqui **vencem** o CLAUDE.md global para tudo que for específico do Genesis.

---

## ⚠️ LEI DE OURO DE INFRAESTRUTURA — ONDE CADA COISA VIVE (canônico, inegociável)

> **NUNCA presuma "prod = este host". Prod e dev são MÁQUINAS DIFERENTES.**
> Antes de dizer "deployado em produção", confirme que agiu em `3.220.66.113` (não neste workstation).
> Um deploy que só recria containers deste host **não chega ao ar** para o cliente.

### 🟢 PRODUÇÃO (o que o cliente vê em `https://genesis.zentriz.com.br`)
| Campo | Valor |
|-------|-------|
| Servidor | **EC2 `i-06e866de4b9ad8cfa`**, EIP público **`3.220.66.113`**, hostname interno `ip-10-10-1-167` |
| Conta AWS | **820198199720** (a EC2 usa **instance role**, sem `--profile`) |
| App dir | **`/opt/zentriz-genesis`** (repo git, branch **`main`**) |
| Compose | **UM único arquivo**: `/opt/zentriz-genesis/docker-compose.yml` — **BUILD-based** (serviços têm `build:`, **sem** `image:`) e **sem overrides** |
| Borda | **nginx (443, certbot)**: `/`→genesis-web · `/api` e `/health`→api |
| Acesso | **`ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113`** (user `ubuntu`; NÃO usar `zentriz-auditor-prod-key`) |
| DB | container `zentriz-genesis-postgres-1` (db `zentriz_genesis`, user `genesis`); migrations auto-aplicam no boot da **api** |
| Segredos | JWT/token de prod no Secrets Manager (inacessíveis daqui); `.pem` GitHub App em `/opt/zentriz-secrets/*.pem` |
| Deadpool/Cyborg | **rodam no MESMO host de prod**, mesmo compose (`zentriz-genesis-deadpool-1` / `-cyborg-1`) |

### 🟡 DEV / BUILD (este workstation — NÃO é produção)
| Campo | Valor |
|-------|-------|
| Host | workstation AWS headless, EIP **`35.169.245.190`** (user IAM `dev.venuxx`, conta 896328489567) |
| Repo | `~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis` (branch **`dev`**) |
| Stack local | Docker Compose project `zentriz-genesis`, subido com **3 arquivos**: `docker-compose.yml` + `docker-compose.override.linux.yml` + `docker-compose.override.foundry.yml` |
| Portas host | **api 3456**→3000 · **genesis-web (portal) 3010**→3001 · agents 8000 · runner 8001 · postgres 5432 · redis 6379 |
| ⚠️ Gotcha | **Todo** `docker compose <cmd>` local DEVE incluir os 3 `-f`. Sem eles: a api tenta subir em `:3000` (colide com o stack `uxt`), derruba api+web e **desconfigura agents/runner** (perdem `GENESIS_LLM_PROVIDER=foundry`/`RAG_ENABLED=live`). |
| LLM local | **Foundry** (override.foundry) — a chave vive em `docker-compose.override.foundry.yml` (**gitignored; NUNCA commitar/logar**) |

---

## 🚀 DEPLOY PARA PRODUÇÃO — fluxo ÚNICO e canônico (ECR, sem git pull no prod)

O compose de prod é BUILD-based → **`docker compose pull` é no-op silencioso** (não há `image:`). Injetar os bytes exatos via ECR é o fluxo estabelecido:

```bash
# 1) LOCAL (build host): buildar as imagens (comando padrão, SEM override.dev → build_target≠dev)
cd ~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis
docker compose -f docker-compose.yml -f docker-compose.override.linux.yml -f docker-compose.override.foundry.yml build api genesis-web

# 2) LOCAL: push ao ECR (login com --profile zentriz; guard recusa bundle web com localhost)
bash project/infra/aws/ecr-push.sh 820198199720 us-east-1 api genesis-web   # + runner agents cyborg deadpool se mudaram

# 3) PROD (via SSH): login ECR pela INSTANCE ROLE (sem --profile), por serviço:
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113
#   a) rollback tag do id atual:  sudo docker tag <ID_ATUAL> rollback-<svc>:pre-<feature>
#   b) login:  aws ecr get-login-password --region us-east-1 | sudo docker login --username AWS --password-stdin 820198199720.dkr.ecr.us-east-1.amazonaws.com
#   c) pull:   sudo docker pull 820198199720.dkr.ecr.us-east-1.amazonaws.com/zentriz-genesis/<ecr>:latest
#   d) retag:  sudo docker tag  .../zentriz-genesis/<ecr>:latest  zentriz-genesis-<svc>:latest
#   e) recreate (API PRIMEIRO — migration no boot; depois genesis-web/deadpool):
#      cd /opt/zentriz-genesis && sudo docker compose up -d --no-build --force-recreate api
#      cd /opt/zentriz-genesis && sudo docker compose up -d --no-build --force-recreate genesis-web

# 4) VERIFICAR (healthy NÃO prova código novo):
#   - digest:  sudo docker inspect --format '{{.Image}}' zentriz-genesis-<svc>-1  == digest que buildei
#   - público: curl https://genesis.zentriz.com.br/health  (versão) + rotas novas → 200
```

**Mapa de nomes** (local→ecr→nome que o compose de prod espera): `api→api→zentriz-genesis-api` · `genesis-web→genesis-web→zentriz-genesis-genesis-web` · `deadpool→deadpool→zentriz-genesis-deadpool`.

### Gotchas de deploy (todos já queimaram)
- **`healthy` não prova deploy** — o container pode ter subido a imagem LOCAL ANTIGA. **Sempre** confira digest do container vs. o que buildou/pushou.
- **Login ECR via SSH:** não faça `aws ecr get-login-password | ssh ... <<'HEREDOC'` (o heredoc consome o stdin → `docker login` recebe senha vazia → 400). Rode o login inteiro **no lado remoto** (`ssh prod 'aws ecr get-login-password | sudo docker login ...'`) ou num ssh separado com pipe direto.
- **Bundle web com localhost:** buildar genesis-web com `override.dev` embute `http://localhost:3000` no bundle → o `ecr-push.sh` **recusa** (guard). Use o build padrão. A MESMA imagem serve local e prod (browser usa URL relativa; Next server faz proxy via `NEXT_INTERNAL_API_URL`).
- **Rollback:** `sudo docker tag rollback-<svc>:pre-<feature> zentriz-genesis-<svc>:latest && docker compose up -d --no-build --force-recreate <svc>` (api primeiro).
- **CI não faz deploy:** `.github/workflows/ci.yml` só faz lint/test/build em push→main. Deploy é **manual** pelo fluxo acima.

---

## Estrutura do repo (essencial)
- `applications/services/api-node/` — API Fastify (Postgres/pg, npm, ESM/TS, vitest). Migrations em `.../migrations/NNN_*.sql`, auto-aplicadas no boot.
- `applications/apps/genesis-web/` — Portal Next.js 14 App Router (MUI 7, MobX). Menu em `components/AppLayout.tsx`.
- `applications/orchestrator/` + `agents`/`runner`/`cyborg` — pipeline autônoma (Python).
- `project/infra/aws/ecr-push.sh` — push das imagens ao ECR.
- `deploy-docker.sh` — sobe/atualiza o stack **LOCAL** deste host (build+up; NÃO faz deploy remoto).

## Convenções
- Trabalhar em **`dev`**; commitar por repositório; só commitar/pushar quando solicitado. **Nunca `git add -A`** (cruft `._*`, `.next/`, `pnpm-lock.yaml` — o repo usa **npm**/`package-lock.json`).
- PT-BR com acentuação completa em prosa/docs/e-mail; código/identificadores em inglês.
- Ao fechar uma frente, **persistir memória** antes de sumarizar (LEI 0 global).
