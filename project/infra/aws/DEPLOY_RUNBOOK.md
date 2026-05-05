# Genesis AWS — Deploy Runbook

> Ambiente provisionado em 2026-05-04. EC2 + Docker Compose + ECR + Route53 + TLS.

---

## Visão geral

```
Mac (local)                     AWS Conta A (820198199720, profile: zentriz)
────────────────                ────────────────────────────────────────────
terraform apply         →       VPC / SG / EC2 t3.large / EIP / Route53
ecr-push.sh             →       ECR (4 repositórios de imagem)
                                Secrets Manager (JWT, PG, Bedrock creds)

                                EC2: 3.220.66.113
                                  ├─ Nginx (443 → 3001/3000)
                                  ├─ genesis-web:3001  (Next.js)
                                  ├─ api:3000          (Fastify)
                                  ├─ runner:8001       (Python orquestrador)
                                  ├─ agents:8000       (Python agentes)
                                  ├─ postgres:5432     (PostgreSQL 16)
                                  └─ redis:6379        (Redis 7)

                                Bedrock LLM → Conta B (credenciais no Secrets Manager)
```

**URLs:**
- Portal: `https://genesis.zentriz.com.br`
- API: `https://genesis.zentriz.com.br/api`
- Health: `https://genesis.zentriz.com.br/health`

---

## Pré-requisitos

```bash
brew install terraform awscli
aws configure list-profiles   # deve conter: zentriz
terraform -version             # >= 1.5
docker info                    # Docker rodando
```

---

## Fluxo completo (primeiro deploy ou re-deploy total)

### 1. Terraform apply

```bash
cd zentriz-genesis/project/infra/aws
terraform init
terraform apply -auto-approve
```

Cria: VPC, SG, EC2, EIP, Secrets Manager, ECR (4 repos), Route53 record, CloudWatch, S3 bootstrap bucket.

### 2. Build das imagens

> **OBRIGATÓRIO para genesis-web:** passar `--build-arg NEXT_PUBLIC_API_BASE_URL`.
> `NEXT_PUBLIC_*` é embutida em build time no Next.js — não funciona via env em runtime.

```bash
cd zentriz-genesis

# Portal (obrigatório com --build-arg)
docker build \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://genesis.zentriz.com.br \
  -t zentriz-genesis-genesis-web:latest \
  -f applications/apps/genesis-web/Dockerfile \
  applications/apps/genesis-web/

# Demais imagens (via docker compose)
docker compose build api runner agents
```

### 3. Push para ECR

```bash
bash project/infra/aws/ecr-push.sh 820198199720 us-east-1
```

O script usa `--profile zentriz` explicitamente para evitar conflito com outros profiles AWS.

### 4. Acompanhar bootstrap da EC2

```bash
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113
tail -f /var/log/zentriz-bootstrap.log
```

O bootstrap roda em background e leva ~15 min. Passos: apt-get → Docker → Node → AWS CLI → Secrets → Clone → .env → ECR pull → Docker up → Nginx → Certbot → Claude Code.

---

## Atualizar só uma imagem (sem recriar EC2)

```bash
# 1. Rebuild local (genesis-web precisa de --build-arg)
docker build --build-arg NEXT_PUBLIC_API_BASE_URL=https://genesis.zentriz.com.br \
  -t zentriz-genesis-genesis-web:latest \
  -f applications/apps/genesis-web/Dockerfile applications/apps/genesis-web/

# 2. Push para ECR
ECR="820198199720.dkr.ecr.us-east-1.amazonaws.com"
aws ecr get-login-password --region us-east-1 --profile zentriz | \
  docker login --username AWS --password-stdin $ECR
docker tag zentriz-genesis-genesis-web:latest $ECR/zentriz-genesis/genesis-web:latest
docker push $ECR/zentriz-genesis/genesis-web:latest

# 3. Atualizar na EC2
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 \
  "cd /opt/zentriz-genesis && sudo docker compose pull genesis-web && sudo docker compose up -d --force-recreate genesis-web"
```

---

## Comandos úteis na EC2

```bash
# SSH
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113

# Status dos containers
sudo docker compose -f /opt/zentriz-genesis/docker-compose.yml ps

# Logs de um serviço
sudo docker logs zentriz-genesis-api-1 -f

# Restart de um serviço
cd /opt/zentriz-genesis && sudo docker compose restart api

# Log do bootstrap
cat /var/log/zentriz-bootstrap.log

# Status do Nginx
sudo systemctl status nginx
sudo nginx -t && sudo systemctl reload nginx

# Status do TLS
sudo certbot certificates

# Monitor autônomo (FT-14)
sudo systemctl status genesis-monitor
journalctl -u genesis-monitor -f
```

---

## Usuários seed (idênticos ao local)

| Email | Senha | Role |
|-------|-------|------|
| `admin@zentriz.com` | `#Jean@2026!` | zentriz_admin |
| `admin@tenant.com` | `#Tenant@2026!` | tenant_admin |
| `user@tenant.com` | `#User@2026!` | user |

---

## Bugs conhecidos no docker-compose.yml (corrigir no repo dev)

**Bug 1 — `FULL_TEST_SERVER_URL` na seção errada:**
No serviço `runner`, a linha abaixo está em `volumes:` mas deveria estar em `environment:`:
```yaml
# ERRADO (em volumes:)
- FULL_TEST_SERVER_URL=${FULL_TEST_SERVER_URL:-http://host.docker.internal:7878}
```
Workaround aplicado na EC2: linha removida via `sed`.

**Bug 2 — `PGPASSWORD` hardcoded:**
O serviço `api` tem `PGPASSWORD=genesis_dev` hardcoded em vez de `${PGPASSWORD}`.
Isso sobrescreve o valor do `.env` e faz a API falhar se a senha do Postgres for diferente.
Workaround aplicado na EC2: substituído via `sed`.

---

## Configuração Bedrock / LLM

A EC2 usa credenciais da **Conta B** (Bedrock com créditos) armazenadas no Secrets Manager da Conta A.

```
Secrets Manager ARN: arn:aws:secretsmanager:us-east-1:820198199720:secret:zentriz-genesis/staging/env-iJdR9S
Campos: JWT_SECRET, PGPASSWORD, GENESIS_API_TOKEN, BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY
```

O Claude Code CLI (FT-14) está configurado em `/home/ubuntu/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "us-east-1",
    "AWS_PROFILE": "bedrock",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-4-6[1m]"
  }
}
```

---

## Custos estimados

| Recurso | Custo/mês |
|---------|-----------|
| EC2 t3.large (24/7) | ~$60 |
| EBS 40 GB gp3 | ~$3 |
| Secrets Manager | ~$0.40 |
| ECR (4 repos) | ~$1 |
| CloudWatch Logs | variável |
| **Total** | **~$65-70/mês** |

Para economizar: `aws ec2 stop-instances --instance-ids i-06e866de4b9ad8cfa --profile zentriz` após a demo. O EIP só cobra se desassociado.

---

## Destruir o ambiente

```bash
cd zentriz-genesis/project/infra/aws
terraform destroy
```

**ATENÇÃO:** destrói EC2, EIP, SG, VPC, ECR, S3, Secrets Manager. Dados do PostgreSQL são perdidos.
