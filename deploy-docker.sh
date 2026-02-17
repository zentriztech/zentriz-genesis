#!/usr/bin/env bash
# deploy-docker.sh — Criar, destruir ou atualizar o ambiente Docker do Zentriz Genesis.
# Uso: ./deploy-docker.sh [--create | --destroy]
#   --destroy  Remove containers, redes e (opcional) volumes do projeto.
#   --create   Garante .env, depois sobe o stack (build + up).
#   (sem flag) Atualiza: rebuild e up (pull/build/up).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
COMPOSE_CMD="docker compose"
PROJECT_NAME="zentriz-genesis"

# --- helpers ---
log() { echo "[deploy-docker] $*"; }
err() { echo "[deploy-docker] ERROR: $*" >&2; }
die() { err "$1"; exit "${2:-1}"; }

# Checar se estamos no diretório correto
check_repo() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    die "docker-compose.yml não encontrado em $REPO_ROOT. Execute a partir da raiz do repositório."
  fi
}

# Checar Docker disponível
check_docker() {
  if ! command -v docker &>/dev/null; then
    die "Docker não está instalado ou não está no PATH."
  fi
  if ! docker info &>/dev/null; then
    die "Docker daemon não está rodando ou o usuário não tem permissão (docker info falhou)."
  fi
  # Preferir "docker compose" (v2); fallback para "docker-compose" (v1)
  if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
  else
    die "Nem 'docker compose' nem 'docker-compose' encontrados. Instale Docker Compose."
  fi
  log "Usando: $COMPOSE_CMD"
}

# Garantir .env existe (cópia de .env.example se faltar)
ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    log ".env já existe."
    return 0
  fi
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    die ".env não existe e .env.example não encontrado."
  fi
  log "Criando .env a partir de .env.example (preencha CLAUDE_API_KEY e outros se necessário)."
  cp "$ENV_EXAMPLE" "$ENV_FILE"
}

# Validar configuração do compose
validate_compose() {
  log "Validando docker-compose..."
  (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" config --quiet) || die "docker-compose config inválido."
}

# Parar e remover containers/rede; opcionalmente volumes
destroy() {
  log "Destruindo ambiente Docker (project: $PROJECT_NAME)..."
  (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" down --remove-orphans) || true
  log "Ambiente destruído (volumes preservados)."
}

# Build e up
create_or_update() {
  log "Build e início dos serviços..."
  (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d --build) || {
    err "Falha no up. Tentando down e up novamente..."
    (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" down --remove-orphans) || true
    (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d --build) || die "Falha ao subir o stack."
  }
  log "Stack no ar. Verificando containers..."
  (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" ps)
}

# --- main ---
main() {
  local mode="update"
  if [[ "${1:-}" == "--destroy" ]]; then
    mode="destroy"
  elif [[ "${1:-}" == "--create" ]]; then
    mode="create"
  elif [[ -n "${1:-}" ]]; then
    log "Uso: $0 [--create | --destroy]"
    log "  --create   Criar ambiente (garante .env, build e up)"
    log "  --destroy  Destruir ambiente (down)"
    log "  (vazio)    Atualizar (build e up)"
    exit 0
  fi

  check_repo
  check_docker

  case "$mode" in
    destroy)
      validate_compose
      destroy
      ;;
    create)
      ensure_env
      validate_compose
      create_or_update
      ;;
    update)
      ensure_env
      validate_compose
      create_or_update
      ;;
  esac

  log "Concluído."
}

main "$@"
