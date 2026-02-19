#!/usr/bin/env bash
# deploy-docker.sh — Criar, destruir ou atualizar o ambiente Docker do Zentriz Genesis.
# Uso: ./deploy-docker.sh [OPÇÕES] [SERVICE...]
#   --destroy        Remove containers, redes e (opcional) volumes do projeto.
#   --create         Garante .env, depois sobe o stack (build + up).
#   --prune          Limpa cache do Docker (builder prune) e depois faz create/update. Use se der "no space left on device".
#   --no-cache       Build sem usar cache (docker compose build --no-cache).
#   --force-recreate Recria containers ao subir (docker compose up -d --force-recreate).
#   SERVICE...       Nomes dos serviços a buildar/rodar (ex.: agents runner). Se omitido, todos.
#   (sem flag)       Atualiza: rebuild e up. Build é sequencial para reduzir pico de uso de disco.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
COMPOSE_CMD="docker compose"
PROJECT_NAME="zentriz-genesis"

# Ordem padrão do build sequencial (usada quando não se passam serviços)
DEFAULT_SERVICES=(api genesis-web agents runner)
# Arrays de serviços sobrescritos por main() quando o usuário passa SERVICE... (evita unbound com set -u)
SERVICES_TO_BUILD=()
SERVICES_TO_UP=()

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

# Limpar cache do builder (libera disco; use se der "no space left on device")
run_prune() {
  log "Limpando cache do Docker builder..."
  docker builder prune -f || true
  log "Cache limpo."
}

# Build sequencial (um serviço por vez) para reduzir pico de uso de disco.
# Uso: build_sequential [--no-cache] [svc1 svc2 ...]
build_sequential() {
  local build_args=()
  [[ "${BUILD_NO_CACHE:-false}" == "true" ]] && build_args+=(--no-cache)
  local services=()
  if [[ ${#SERVICES_TO_BUILD[@]} -gt 0 ]]; then
    services=("${SERVICES_TO_BUILD[@]}")
  else
    services=("${DEFAULT_SERVICES[@]}")
  fi
  log "Build sequencial (${services[*]})..."
  for svc in "${services[@]}"; do
    if [[ ${#build_args[@]} -gt 0 ]]; then
      (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" build "${build_args[@]}" "$svc") || die "Build do $svc falhou."
    else
      (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" build "$svc") || die "Build do $svc falhou."
    fi
  done
  log "Build concluído."
}

# Build e up (usa BUILD_NO_CACHE, FORCE_RECREATE e SERVICES_TO_BUILD/SERVICES_TO_UP se definidos)
create_or_update() {
  log "Build e início dos serviços..."
  build_sequential

  local up_args=(-d)
  [[ "${FORCE_RECREATE:-false}" == "true" ]] && up_args+=(--force-recreate)

  if [[ ${#SERVICES_TO_UP[@]} -gt 0 ]]; then
    log "Subindo apenas: ${SERVICES_TO_UP[*]}"
    (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d "${up_args[@]}" "${SERVICES_TO_UP[@]}") || {
      err "Falha no up. Tentando novamente..."
      (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d "${up_args[@]}" "${SERVICES_TO_UP[@]}") || die "Falha ao subir os serviços."
    }
  else
    (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d "${up_args[@]}") || {
      err "Falha no up. Tentando down e up novamente..."
      (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" down --remove-orphans) || true
      (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" up -d "${up_args[@]}") || die "Falha ao subir o stack."
    }
  fi
  log "Stack no ar. Verificando containers..."
  (cd "$REPO_ROOT" && $COMPOSE_CMD -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" ps)
}

# --- main ---
main() {
  local mode="update"
  local do_prune=false
  BUILD_NO_CACHE=false
  FORCE_RECREATE=false
  HOST_AGENTS=false
  SERVICES_TO_BUILD=()
  SERVICES_TO_UP=()

  while [[ -n "${1:-}" ]]; do
    case "$1" in
      --destroy)        mode="destroy"; shift ;;
      --create)          mode="create"; shift ;;
      --prune)           do_prune=true; shift ;;
      --no-cache)        BUILD_NO_CACHE=true; shift ;;
      --force-recreate)  FORCE_RECREATE=true; shift ;;
      --host-agents)     HOST_AGENTS=true; shift ;;
      -h|--help)
        echo "Uso: $0 [OPÇÕES] [SERVICE...]"
        echo ""
        echo "Modos:"
        echo "  --create         Criar ambiente (garante .env, build e up)"
        echo "  --destroy        Destruir ambiente (down)"
        echo "  --prune          Limpar cache do Docker e depois build+up (use se der 'no space left on device')"
        echo "  (sem modo)       Atualizar (build sequencial e up)"
        echo ""
        echo "Opções de build/up:"
        echo "  --no-cache       Build sem cache (docker compose build --no-cache)"
        echo "  --force-recreate Recria containers ao subir (útil após alterar .env)"
        echo "  --host-agents    Rodar agentes no host (contorna TLS no Docker Desktop Mac)"
        echo ""
        echo "Serviços (opcional):"
        echo "  SERVICE...       Nomes dos serviços a buildar e subir (ex.: agents runner). Se omitido, todos."
        echo ""
        echo "Exemplos:"
        echo "  $0                                    # build e up de todos"
        echo "  $0 --no-cache --force-recreate        # rebuild completo e recriar containers"
        echo "  $0 --force-recreate agents runner     # só agents e runner, recriados"
        echo "  $0 agents                             # só build e up do agents"
        exit 0
        ;;
      -*)
        log "Opção desconhecida: $1"
        exit 1
        ;;
      *)
        SERVICES_TO_BUILD+=("$1")
        SERVICES_TO_UP+=("$1")
        shift
        ;;
    esac
  done

  check_repo
  check_docker

  if [[ "$do_prune" == true ]]; then
    run_prune
  fi

  # Se --host-agents: excluir container agents da lista de serviços e configurar runner
  if [[ "$HOST_AGENTS" == true ]]; then
    log "Modo host-agents: o serviço 'agents' NÃO será subido no Docker."
    log "O runner usará API_AGENTS_URL=http://host.docker.internal:8000"
    log ""
    log "Após o deploy, rode em outro terminal:"
    log "  ./start-agents-host.sh"
    log ""
    # Garantir que API_AGENTS_URL aponta para o host no .env
    if [[ -f "$ENV_FILE" ]] && ! grep -q "^API_AGENTS_URL=" "$ENV_FILE"; then
      echo "API_AGENTS_URL=http://host.docker.internal:8000" >> "$ENV_FILE"
      log "Adicionado API_AGENTS_URL=http://host.docker.internal:8000 ao .env"
    fi
    # Remover agents da lista default e das listas customizadas
    DEFAULT_SERVICES=(api genesis-web runner)
    local new_build=()
    local new_up=()
    for s in "${SERVICES_TO_BUILD[@]+"${SERVICES_TO_BUILD[@]}"}"; do
      [[ "$s" != "agents" ]] && new_build+=("$s")
    done
    for s in "${SERVICES_TO_UP[@]+"${SERVICES_TO_UP[@]}"}"; do
      [[ "$s" != "agents" ]] && new_up+=("$s")
    done
    SERVICES_TO_BUILD=("${new_build[@]+"${new_build[@]}"}")
    SERVICES_TO_UP=("${new_up[@]+"${new_up[@]}"}")
    FORCE_RECREATE=true
  fi

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

  if [[ "$HOST_AGENTS" == true ]]; then
    log ""
    log "IMPORTANTE: Agora rode em outro terminal: ./start-agents-host.sh"
    log "Os agentes no host falarão com a Claude (sem problema de TLS no Docker)."
  fi

  log "Concluído."
}

main "$@"
