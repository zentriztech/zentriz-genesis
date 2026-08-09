#!/usr/bin/env bash
# gen-bedrock-creds-override.sh — gera docker-compose.override.bedrock.yml com credenciais
# TEMPORÁRIAS da role da instância (IMDSv2), injetadas como env nos serviços que chamam Bedrock.
#
# Necessário porque: (1) o container não alcança o IMDS via bridge Docker (hop limit=1 e sem
# permissão p/ bumpar), e (2) o ~/.aws/credentials do host tem perfis de OUTRA conta (venuxx/
# v2-297) — montá-lo faria o boto3 pegar a conta errada. As credenciais da role (conta 820)
# vêm do IMDS e são injetadas diretas. Expiram ~6h; rode de novo se expirar.
#
# NUNCA commitar o override gerado (credenciais em claro) — está no .gitignore.
set -euo pipefail

OUT="${1:-docker-compose.override.bedrock.yml}"
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
ROLE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/)
CREDS=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE")

AK=$(echo "$CREDS"  | python3 -c "import sys,json;print(json.load(sys.stdin)['AccessKeyId'])")
SK=$(echo "$CREDS"  | python3 -c "import sys,json;print(json.load(sys.stdin)['SecretAccessKey'])")
ST=$(echo "$CREDS"  | python3 -c "import sys,json;print(json.load(sys.stdin)['Token'])")
EXP=$(echo "$CREDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['Expiration'])")

# Serviços que chamam Bedrock: api (spec intake), agents (todos os cargos), runner, cyborg.
# Injetamos as 3 env de credencial + região. Sem volume ~/.aws (evita perfil errado).
cat > "$OUT" <<YAML
# GERADO por gen-bedrock-creds-override.sh — NÃO COMMITAR (credenciais temporárias em claro).
# Expira: ${EXP}
services:
  api:
    environment:
      - AWS_ACCESS_KEY_ID=${AK}
      - AWS_SECRET_ACCESS_KEY=${SK}
      - AWS_SESSION_TOKEN=${ST}
      - AWS_REGION=us-east-1
      - GENESIS_LLM_PROVIDER=bedrock
  agents:
    environment:
      - AWS_ACCESS_KEY_ID=${AK}
      - AWS_SECRET_ACCESS_KEY=${SK}
      - AWS_SESSION_TOKEN=${ST}
      - AWS_REGION=us-east-1
      - GENESIS_LLM_PROVIDER=bedrock
  runner:
    environment:
      - AWS_ACCESS_KEY_ID=${AK}
      - AWS_SECRET_ACCESS_KEY=${SK}
      - AWS_SESSION_TOKEN=${ST}
      - AWS_REGION=us-east-1
      - GENESIS_LLM_PROVIDER=bedrock
  cyborg:
    environment:
      - AWS_ACCESS_KEY_ID=${AK}
      - AWS_SECRET_ACCESS_KEY=${SK}
      - AWS_SESSION_TOKEN=${ST}
      - AWS_REGION=us-east-1
      - GENESIS_LLM_PROVIDER=bedrock
YAML

echo "✓ $OUT gerado (expira $EXP)"
