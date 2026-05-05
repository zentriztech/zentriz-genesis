# Zentriz Genesis — Deploy AWS (EC2 + Docker Compose)

> Estratégia: EC2 t3.large + Docker Compose (mesma stack local) + Elastic IP para demo estável.
> Deploy completo em ~30-40 minutos. Sem ECS/EKS/Fargate — sem overhead para demo.

---

## Arquitetura

```
Internet
    │
    ▼
Elastic IP (fixo — URL estável para demo)
    │
    ▼
EC2 t3.large (Ubuntu 24.04)
    │
    ├─ genesis-web:3001   → Portal Next.js (PÚBLICO)
    ├─ api:3000           → API Fastify/TS (PÚBLICO)
    ├─ runner:8001        → Orquestrador Python (INTERNO)
    ├─ agents:8000        → Agentes Claude (INTERNO)
    ├─ postgres:5432      → Banco (INTERNO)
    └─ redis:6379         → Cache (INTERNO)
    │
    └─ systemd: genesis-monitor  → Claude Code FT-14 (Autonomous Monitor)

IAM Instance Profile → Bedrock (sem API key)
    └─ bedrock:InvokeModel / InvokeModelWithResponseStream

Secrets Manager
    └─ zentriz-genesis/staging/env
           ├─ JWT_SECRET
           ├─ PGPASSWORD
           └─ GENESIS_API_TOKEN
```

---

## Pré-requisitos

```bash
# Ferramentas locais
brew install terraform awscli
terraform -version  # >= 1.5
aws --version

# Credenciais AWS configuradas
aws configure  # ou: export AWS_PROFILE=...
aws sts get-caller-identity  # deve retornar seu account
```

---

## Deploy em 5 passos

### 1. Configurar variáveis

```bash
cd project/infra/aws
cp terraform.tfvars.example terraform.tfvars
# Edite terraform.tfvars — preencha obrigatoriamente:
#   ssh_public_key    (cat ~/.ssh/zentriz-genesis-aws.pub)
#   admin_cidr_blocks (["$(curl -s ifconfig.me)/32"])
#   bedrock_model_id  (confirme que está habilitado na sua conta)
# CLAUDE_API_KEY não é necessário — acesso via IAM instance profile
```

**Pré-requisito Bedrock:** confirme que o modelo está habilitado na sua conta:
`AWS Console → Amazon Bedrock → Model access → Request access` para `Claude Sonnet`.

### 2. Gerar par de chaves SSH (se ainda não tiver)

```bash
ssh-keygen -t ed25519 -C "zentriz-genesis-aws" -f ~/.ssh/zentriz-genesis-aws
# O terraform.tfvars já aponta para ~/.ssh/zentriz-genesis-aws.pub por padrão
# Terraform lê o arquivo automaticamente via file(pathexpand(...))
```

### 3. Terraform apply

```bash
terraform init
terraform plan   # revise o plano — ~15 recursos
terraform apply  # confirme com "yes"
```

Aguarde ~2 minutos. Outputs ao final:

```
portal_url  = "http://X.X.X.X:3001"
api_url     = "http://X.X.X.X:3000"
ssh_command = "ssh -i ~/.ssh/zentriz-genesis-aws ubuntu@X.X.X.X"
```

### 4. Acompanhar bootstrap na EC2

O `user_data` leva ~15-20 minutos (build das imagens Docker).

```bash
# SSH na instância (aguarde 1-2 min após apply para a instância inicializar)
ssh -i ~/.ssh/zentriz-genesis-aws ubuntu@<IP>

# Acompanhar log do bootstrap
tail -f /var/log/zentriz-bootstrap.log

# Ver status dos containers
cd /opt/zentriz-genesis && docker compose ps
```

### 5. Verificar saúde

```bash
# Da sua máquina local:
curl http://<IP>:3000/health      # API
curl http://<IP>:8001/health      # Runner (via SSH tunnel)

# Portal no browser:
open http://<IP>:3001
```

---

## Copiar GitHub App private key (se usar FT-12)

O bootstrap cria um placeholder em `/opt/zentriz-secrets/`. Substitua:

```bash
scp -i ~/.ssh/zentriz-genesis-aws \
  ~/Documents/zentriz/github/zentriz-autonomy.2026-04-24.private-key.pem \
  ubuntu@<IP>:/opt/zentriz-secrets/zentriz-autonomy.2026-04-24.private-key.pem

# Reiniciar a API para recarregar o secret
ssh -i ~/.ssh/zentriz-genesis-aws ubuntu@<IP> \
  "cd /opt/zentriz-genesis && docker compose restart api"
```

---

## FT-14 — Autonomous Monitor (Claude Code)

O serviço `genesis-monitor` (systemd) roda o Claude Code em modo headless, monitorando tasks BLOCKED e acionando Dev/DevOps automaticamente.

```bash
# Status
systemctl status genesis-monitor

# Logs
journalctl -u genesis-monitor -f

# Parar (para demo manual)
systemctl stop genesis-monitor

# Reiniciar após alterar o prompt
systemctl restart genesis-monitor
```

O monitor usa a mesma `CLAUDE_API_KEY` do `.env`. Credenciais ficam em `/home/ubuntu/.config/claude/credentials.json` (modo 600).

---

## Variáveis de ambiente pós-deploy

Para alterar qualquer configuração sem novo `terraform apply`:

```bash
ssh -i ~/.ssh/zentriz-genesis-aws ubuntu@<IP>
cd /opt/zentriz-genesis

# Editar .env
nano .env

# Aplicar (rebuild só se Dockerfile mudou)
docker compose up -d

# Se alterou apenas env vars (sem rebuild):
docker compose down && docker compose up -d
```

---

## Atualizar o código (nova versão)

```bash
ssh -i ~/.ssh/zentriz-genesis-aws ubuntu@<IP>
cd /opt/zentriz-genesis

git pull origin main
docker compose build --parallel
docker compose up -d
```

---

## Destruir o ambiente

```bash
# ATENÇÃO: destroi EC2, EIP, SG, VPC, Secrets Manager
# Dados em volumes Docker (postgres, redis) são perdidos
terraform destroy
```

---

## Custos estimados (us-east-1)

| Recurso | Custo/hora | Custo/mês |
|---------|-----------|-----------|
| EC2 t3.large | ~$0.083 | ~$60 |
| Elastic IP (associado) | $0 | $0 |
| Elastic IP (parado) | $0.005/h | ~$3.60 |
| Secrets Manager | $0.40/secret | ~$0.40 |
| EBS 40 GB gp3 | ~$0.08/GB | ~$3.20 |
| CloudWatch Logs | ~$0.50/GB | variável |
| **Total estimado** | | **~$65-70/mês** |

Para demo pontual: **pare a instância após a apresentação** (`aws ec2 stop-instances --instance-ids <id>`). O EIP só cobra se desassociado.

---

## Roadmap para escala (pós-demo)

| Fase | Quando | O que muda |
|------|--------|-----------|
| **Multi-tenant** | +1 mês | ECS Fargate + RDS + ElastiCache |
| **CI/CD** | +2 meses | GitHub Actions → ECR → rolling deploy |
| **Bedrock Agents** | +6-7 meses | Migração arquitetural completa |
| **Observabilidade** | +3 meses | CloudWatch dashboards + alertas SNS |
