#!/bin/bash
# Zentriz Genesis — bootstrap EC2 (Ubuntu 24.04)
# Executado uma vez na criação da instância via terraform user_data
# Log completo em: /var/log/zentriz-bootstrap.log

set -euo pipefail
exec > >(tee /var/log/zentriz-bootstrap.log | logger -t zentriz-bootstrap) 2>&1

echo "=== [$(date)] Zentriz Genesis Bootstrap START ==="

# ──────────────────────────────────────────────
# 1. SISTEMA E DEPENDÊNCIAS
# ──────────────────────────────────────────────

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq \
  curl git unzip jq dnsutils \
  ca-certificates gnupg lsb-release \
  nginx certbot python3-certbot-nginx

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

# Node.js 20 (para Claude Code CLI)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -yq nodejs

# Claude Code CLI (FT-14 — Autonomous Monitor)
npm install -g @anthropic-ai/claude-code || true

echo "=== [$(date)] Dependências instaladas ==="

# ──────────────────────────────────────────────
# 2. SECRETS → ENV FILE
# ──────────────────────────────────────────────

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "${secret_arn}" \
  --region "${aws_region}" \
  --query SecretString \
  --output text)

JWT_SECRET_VAL=$(echo "$SECRET_JSON" | jq -r '.JWT_SECRET')
PG_PASSWORD=$(echo "$SECRET_JSON" | jq -r '.PGPASSWORD')
GENESIS_API_TOKEN_VAL=$(echo "$SECRET_JSON" | jq -r '.GENESIS_API_TOKEN')
# Credenciais da Conta B (Bedrock) — lidas do secret, nunca hardcoded
BEDROCK_KEY_ID=$(echo "$SECRET_JSON" | jq -r '.BEDROCK_ACCESS_KEY_ID')
BEDROCK_SECRET=$(echo "$SECRET_JSON" | jq -r '.BEDROCK_SECRET_ACCESS_KEY')

# Gera valores aleatórios se não definidos no secret
[ -z "$JWT_SECRET_VAL" ] || [ "$JWT_SECRET_VAL" = "null" ] && \
  JWT_SECRET_VAL=$(openssl rand -hex 32)

[ -z "$GENESIS_API_TOKEN_VAL" ] || [ "$GENESIS_API_TOKEN_VAL" = "null" ] && \
  GENESIS_API_TOKEN_VAL=$(openssl rand -hex 24)

[ -z "$PG_PASSWORD" ] || [ "$PG_PASSWORD" = "null" ] && \
  PG_PASSWORD="${pg_password}"

echo "=== [$(date)] Secrets carregados ==="

# ──────────────────────────────────────────────
# 3. CLONE DO REPOSITÓRIO (apenas docker-compose.yml e .env)
# Imagens vêm do ECR — não é necessário buildar na EC2
# ──────────────────────────────────────────────

APP_DIR="/opt/zentriz-genesis"
mkdir -p "$APP_DIR"

git clone --branch "${github_repo_branch}" --depth 1 --filter=blob:none \
  "${github_repo_url}" "$APP_DIR" || {
  echo "WARN: clone falhou — assumindo deploy manual via scp/rsync"
}

chown -R ubuntu:ubuntu "$APP_DIR"

echo "=== [$(date)] Repositório clonado ==="

# ──────────────────────────────────────────────
# 4. DIRETÓRIOS DE DADOS
# ──────────────────────────────────────────────

PROJECT_FILES="${project_files_dir}"
mkdir -p "$PROJECT_FILES"
mkdir -p "$PROJECT_FILES/.runner-state"
mkdir -p /opt/zentriz-secrets

chown -R ubuntu:ubuntu "$PROJECT_FILES"

# Placeholder do GitHub App private key (substitua o arquivo real via scp)
touch /opt/zentriz-secrets/zentriz-autonomy.private-key.pem

echo "=== [$(date)] Diretórios criados ==="

# ──────────────────────────────────────────────
# 5. .ENV PARA O DOCKER COMPOSE
# ──────────────────────────────────────────────

cat > "$APP_DIR/.env" << EOF
# Gerado automaticamente pelo bootstrap — não editar manualmente
# Para alterar: editar /opt/zentriz-genesis/.env e rodar: docker compose up -d

# ── LLM — Bedrock na Conta B (créditos separados) ────────────
GENESIS_LLM_PROVIDER=bedrock
CLAUDE_MODEL=${bedrock_model_id}
GENESIS_AWS_REGION=${bedrock_region}
# Credenciais explícitas da Conta B — lidas do Secrets Manager da Conta A
AWS_ACCESS_KEY_ID=$BEDROCK_KEY_ID
AWS_SECRET_ACCESS_KEY=$BEDROCK_SECRET
LOG_LEVEL=INFO
SHOW_TRACEBACK=false

# ── API ──────────────────────────────────────
JWT_SECRET=$JWT_SECRET_VAL
GENESIS_API_TOKEN=$GENESIS_API_TOKEN_VAL

# ── Banco de dados ────────────────────────────
PGHOST=postgres
PGUSER=${pg_user}
PGPASSWORD=$PG_PASSWORD
PGDATABASE=${pg_database}
PGPORT=5432

# ── Volumes / paths ───────────────────────────
HOST_PROJECT_FILES_ROOT=$PROJECT_FILES
RUNNER_UPLOAD_DIR=/shared/uploads

# ── URLs internas (Docker) ───────────────────
API_BASE_URL=http://api:3000
RUNNER_SERVICE_URL=http://runner:8001
API_AGENTS_URL=http://agents:8000

# ── Portal ────────────────────────────────────
NEXT_PUBLIC_API_BASE_URL=${next_public_api_url}
NODE_ENV=production

# ── Runner ────────────────────────────────────
PIPELINE_FULL_STACK=true
CLAUDE_BIN=/usr/bin/claude
FULL_TEST_SERVER_URL=http://host.docker.internal:7878

# ── Connect ───────────────────────────────────
ZENTRIZ_CONNECT_ROOT=/zentriz-connect
EOF

chmod 600 "$APP_DIR/.env"

# docker-compose.yml: ajusta secrets path para EC2 (sem ~/Documents)
# Substitui o volume de GitHub secrets pelo path EC2
sed -i 's|$${HOME}/Documents/zentriz/github|/opt/zentriz-secrets|g' \
  "$APP_DIR/docker-compose.yml" || true

# Volumes do zentriz-connect: aponta para diretório vazio se não existir
if [ ! -d /opt/zentriz-connect ]; then
  mkdir -p /opt/zentriz-connect
fi

echo "=== [$(date)] .env e docker-compose configurados ==="

# ──────────────────────────────────────────────
# 6. POSTGRES PASSWORD REAL
# ──────────────────────────────────────────────

# Atualiza a senha do postgres no docker-compose com valor do secret
sed -i "s|POSTGRES_PASSWORD: genesis_dev|POSTGRES_PASSWORD: $PG_PASSWORD|g" \
  "$APP_DIR/docker-compose.yml" || true

# ──────────────────────────────────────────────
# 7. LOGIN ECR + PULL DAS IMAGENS + SUBIR CONTAINERS
# ──────────────────────────────────────────────

ECR_REGISTRY="${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com"
ECR_NAMESPACE="${namespace}"

# Login no ECR usando instance profile (sem access key)
aws ecr get-login-password --region "${aws_region}" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Sobrescreve as entradas "build:" do docker-compose para usar imagens ECR
# O sed transforma cada serviço que tem "build:" para usar "image: <ecr>/<nome>:latest"
for SVC in api runner agents genesis-web; do
  ECR_IMAGE="$ECR_REGISTRY/$ECR_NAMESPACE/$SVC:latest"
  # Injeta variável de ambiente para o docker compose usar
  export IMAGE_$(echo $SVC | tr '-' '_' | tr '[:lower:]' '[:upper:]')="$ECR_IMAGE"
done

cd "$APP_DIR"

# Gera docker-compose.override.yml apontando para imagens ECR
# O override de "image:" tem precedência sobre "build:" — não precisa remover o build
cat > docker-compose.override.yml << OVERRIDE
services:
  api:
    image: $ECR_REGISTRY/$ECR_NAMESPACE/api:latest
  runner:
    image: $ECR_REGISTRY/$ECR_NAMESPACE/runner:latest
  agents:
    image: $ECR_REGISTRY/$ECR_NAMESPACE/agents:latest
  genesis-web:
    image: $ECR_REGISTRY/$ECR_NAMESPACE/genesis-web:latest
OVERRIDE

docker compose pull
docker compose up -d

echo "=== [$(date)] Containers subindo — aguardando healthchecks ==="

# Aguarda API ficar healthy (max 3 min)
for i in $(seq 1 18); do
  sleep 10
  STATUS=$(docker compose ps --format json 2>/dev/null | jq -r '.[] | select(.Name | contains("api")) | .Health' 2>/dev/null || echo "unknown")
  echo "  [$${i}] API health: $STATUS"
  [ "$STATUS" = "healthy" ] && break
done

echo "=== [$(date)] Containers status ==="
docker compose ps

# ──────────────────────────────────────────────
# 8. NGINX REVERSE PROXY + TLS (Let's Encrypt)
# Portal (3001) e API (3000) expostos em genesis.zentriz.com.br
# ──────────────────────────────────────────────

FQDN="${subdomain}.${domain}"

# Configuração Nginx inicial (HTTP — necessária para o desafio ACME)
cat > /etc/nginx/sites-available/genesis << NGINX
server {
    listen 80;
    server_name $FQDN;

    # Proxy para o portal Next.js
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
    }

    # Proxy para a API Fastify
    # As rotas já têm /api/ no path internamente — passa sem strip
    location /api {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    # Health check direto
    location /health {
        proxy_pass         http://127.0.0.1:3000/health;
        proxy_http_version 1.1;
        access_log off;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/genesis /etc/nginx/sites-enabled/genesis
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== [$(date)] Nginx configurado ==="

# Aguarda DNS propagar (Route53 TTL=60s, mas EC2 pode demorar até 2 min)
echo "Aguardando DNS propagar para $FQDN..."
for i in $(seq 1 24); do
  sleep 5
  RESOLVED=$(dig +short "$FQDN" 2>/dev/null | head -1)
  PUBLIC_IP=$(curl -s checkip.amazonaws.com 2>/dev/null)
  echo "  [$i] DNS resolve: $RESOLVED | IP esperado: $PUBLIC_IP"
  [ "$RESOLVED" = "$PUBLIC_IP" ] && break
done

# Emite certificado TLS via Certbot (Let's Encrypt)
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "ti@zentriz.com.br" \
  --domains "$FQDN" \
  --redirect && echo "=== [$(date)] TLS emitido com sucesso ===" || \
  echo "WARN: Certbot falhou — acesse via HTTP até o DNS propagar e rode: certbot --nginx -d $FQDN"

# Renovação automática (cron diário às 3h)
echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" \
  > /etc/cron.d/certbot-renew

echo "=== [$(date)] HTTPS configurado ==="

# ──────────────────────────────────────────────
# 10. FT-14 — CLAUDE CODE AUTONOMOUS MONITOR
# Instala Claude Code como serviço systemd para monitorar tasks BLOCKED
# ──────────────────────────────────────────────

cat > /etc/systemd/system/genesis-monitor.service << 'UNIT'
[Unit]
Description=Zentriz Genesis — Claude Code Autonomous Monitor (FT-14)
After=docker.service
Requires=docker.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/zentriz-genesis
Environment=HOME=/home/ubuntu
EnvironmentFile=/opt/zentriz-genesis/.env
ExecStartPre=/bin/sleep 30
ExecStart=/usr/bin/claude \
  --headless \
  --model claude-sonnet-4-6 \
  --print \
  "Você é o Autonomous Monitor do Zentriz Genesis (FT-14). \
   Monitore continuamente a API em http://localhost:3000 buscando tasks com status BLOCKED. \
   Para cada BLOCKED task: (1) leia o erro no diálogo, (2) identifique a causa raiz, \
   (3) acione o agente Dev ou DevOps adequado via POST /api/v1/tasks/:id/retry com análise do problema, \
   (4) registre no diálogo a ação tomada. \
   Rode em loop com intervalo de 60 segundos. \
   Use GENESIS_API_TOKEN do environment para autenticação."
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

# FT-14: Claude Code — Bedrock com mesmas configurações do ambiente local
# Credenciais já estão em $BEDROCK_KEY_ID / $BEDROCK_SECRET (lidas do Secrets Manager)

# AWS credentials para o profile "bedrock" do usuário ubuntu
mkdir -p /home/ubuntu/.aws
cat > /home/ubuntu/.aws/credentials << EOF2
[bedrock]
aws_access_key_id=$BEDROCK_KEY_ID
aws_secret_access_key=$BEDROCK_SECRET
EOF2
chmod 600 /home/ubuntu/.aws/credentials
chown -R ubuntu:ubuntu /home/ubuntu/.aws

# settings.json do Claude Code — espelha configuração local (CLAUDE_CODE_USE_BEDROCK)
mkdir -p /home/ubuntu/.claude
cat > /home/ubuntu/.claude/settings.json << EOF3
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "${bedrock_region}",
    "AWS_PROFILE": "bedrock",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "us.anthropic.claude-sonnet-4-6[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "us.anthropic.claude-opus-4-7[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0"
  },
  "skipDangerousModePermissionPrompt": true
}
EOF3
chmod 600 /home/ubuntu/.claude/settings.json
chown -R ubuntu:ubuntu /home/ubuntu/.claude

systemctl daemon-reload
systemctl enable genesis-monitor
# Monitor só sobe se claude CLI estiver instalado com sucesso
which claude > /dev/null 2>&1 && systemctl start genesis-monitor || \
  echo "WARN: claude CLI não encontrado — genesis-monitor não iniciado (instale manualmente)"

echo "=== [$(date)] FT-14 Monitor configurado ==="

# ──────────────────────────────────────────────
# 11. CLOUDWATCH LOGS AGENT
# ──────────────────────────────────────────────

cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOF3
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/zentriz-bootstrap.log",
            "log_group_name": "/zentriz/genesis/${environment}",
            "log_stream_name": "{instance_id}/bootstrap",
            "retention_in_days": 7
          }
        ]
      }
    }
  }
}
EOF3

# Instala o agente se disponível
wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb \
  -O /tmp/amazon-cloudwatch-agent.deb && \
  dpkg -i /tmp/amazon-cloudwatch-agent.deb && \
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json || \
  echo "WARN: CloudWatch agent não instalado"

echo "=== [$(date)] Zentriz Genesis Bootstrap CONCLUÍDO ==="
echo ""
echo "  Portal:  https://${subdomain}.${domain}"
echo "  API:     https://${subdomain}.${domain}/api"
echo "  Health:  https://${subdomain}.${domain}/api/health"
echo ""
