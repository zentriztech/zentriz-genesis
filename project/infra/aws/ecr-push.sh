#!/bin/bash
# Zentriz Genesis — push das imagens locais para o ECR
# Uso: bash project/infra/aws/ecr-push.sh <account-id> <region>
# Exemplo: bash project/infra/aws/ecr-push.sh 123456789012 us-east-1
#
# Pré-requisito: terraform apply já executado (repositórios ECR criados)
# Rodar do root do repo: zentriz-genesis/

set -euo pipefail

ACCOUNT_ID="${1:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${2:-us-east-1}"
NAMESPACE="zentriz-genesis"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

echo "=== ECR Push — Zentriz Genesis ==="
echo "  Registry : $REGISTRY"
echo "  Namespace: $NAMESPACE"
echo "  Region   : $REGION"
echo ""

# Login no ECR — usa profile zentriz (Conta A) explicitamente
echo "[1/6] Login ECR..."
aws ecr get-login-password --region "$REGION" --profile zentriz | \
  docker login --username AWS --password-stdin "$REGISTRY"

# Mapeamento: "local_image_name:ecr_name" (compatível com bash 3+ e zsh)
IMAGES=(
  "zentriz-genesis-api:api"
  "zentriz-genesis-runner:runner"
  "zentriz-genesis-agents:agents"
  "zentriz-genesis-genesis-web:genesis-web"
)

STEP=2
for ENTRY in "${IMAGES[@]}"; do
  LOCAL_NAME="${ENTRY%%:*}"
  ECR_NAME="${ENTRY##*:}"
  ECR_URI="$REGISTRY/$NAMESPACE/$ECR_NAME:latest"

  echo "[$STEP/6] $LOCAL_NAME -> $ECR_URI"

  # Verifica se a imagem local existe
  if ! docker image inspect "$LOCAL_NAME:latest" > /dev/null 2>&1; then
    echo "  ERRO: imagem $LOCAL_NAME:latest nao encontrada localmente."
    echo "  Rode: docker compose build  (na raiz do zentriz-genesis)"
    exit 1
  fi

  # GUARD: para genesis-web, verifica label e bundle antes de pushar.
  # Bug histórico: build local com NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
  # e push ao ECR = portal EC2 quebra chamando localhost do cliente.
  if [ "$LOCAL_NAME" = "zentriz-genesis-genesis-web" ]; then
    LABEL_TARGET=$(docker image inspect "$LOCAL_NAME:latest" --format='{{ index .Config.Labels "com.zentriz.build_target" }}' 2>/dev/null || echo "")
    if [ "$LABEL_TARGET" = "dev" ]; then
      echo "  ERRO [GUARD]: imagem tem label com.zentriz.build_target=dev — RECUSANDO push ao ECR." >&2
      echo "  Solução: rebuild sem docker-compose.override.dev.yml (comando padrão 'docker compose build genesis-web')." >&2
      exit 2
    fi
    # Sanity extra: inspeciona bundle interno da imagem.
    TMPCID=$(docker create "$LOCAL_NAME:latest")
    BUNDLE_HAS_LOCAL=$(docker cp "$TMPCID:/app/.next/static" - 2>/dev/null | tar -xO 2>/dev/null | grep -cE 'http://localhost:3000|http://127\.0\.0\.1' || true)
    docker rm "$TMPCID" >/dev/null 2>&1 || true
    if [ "${BUNDLE_HAS_LOCAL:-0}" -gt 0 ]; then
      echo "  ERRO [GUARD]: bundle Next.js contém http://localhost:3000 embutido — RECUSANDO push." >&2
      echo "  Origem provável: build feito com NEXT_PUBLIC_API_BASE_URL apontando localhost." >&2
      echo "  Corrija: docker compose build genesis-web (sem override.dev.yml) e rode este script novamente." >&2
      exit 3
    fi
    echo "  OK [GUARD]: imagem genesis-web validada (bundle sem localhost)"
  fi

  docker tag "$LOCAL_NAME:latest" "$ECR_URI"
  docker push "$ECR_URI"
  echo "  OK Push concluido"

  STEP=$((STEP + 1))
done

echo ""
echo "=== Todas as imagens enviadas para o ECR ==="
echo ""
echo "Próximo passo: terraform apply (se ainda não rodou) ou"
echo "se a EC2 já está de pé, acesse via SSH e rode:"
echo "  cd /opt/zentriz-genesis && docker compose pull && docker compose up -d"
