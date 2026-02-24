#!/usr/bin/env bash
# start-agents-host.sh — Roda o serviço de agentes NO HOST (fora do Docker).
# Use quando o container Docker não consegue TLS até api.anthropic.com
# (ex.: Docker Desktop no Mac com SSL: UNEXPECTED_EOF_WHILE_READING).
#
# Pré-requisitos:
#   pip install -r applications/orchestrator/agents/requirements.txt
#
# Como funciona:
#   1. Os agentes rodam no host na porta 8000 (onde TLS funciona)
#   2. O runner (no Docker) chama http://host.docker.internal:8000
#   3. No .env, defina: API_AGENTS_URL=http://host.docker.internal:8000
#   4. Recrie o runner: docker compose up -d --force-recreate runner
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGENTS_PORT:-8000}"

echo "[agents-host] Iniciando serviço de agentes no host (porta $PORT)..."
echo "[agents-host] Ctrl+C para encerrar."
echo ""

cd "$REPO_ROOT"

# Parar container agents do Docker (se estiver rodando) para liberar a porta
if docker compose ps agents --format '{{.State}}' 2>/dev/null | grep -q running; then
    echo "[agents-host] Parando container agents do Docker (porta $PORT em uso)..."
    docker compose stop agents 2>/dev/null || true
fi

# Matar qualquer processo que ainda ocupe a porta
if lsof -ti:"$PORT" &>/dev/null; then
    echo "[agents-host] Liberando porta $PORT..."
    kill $(lsof -ti:"$PORT") 2>/dev/null || true
    sleep 1
fi

# Carregar variáveis do .env para o ambiente do processo
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
    echo "[agents-host] Variáveis carregadas de .env (CLAUDE_MODEL=${CLAUDE_MODEL:-não definido})"
fi

# Garantir PROJECT_FILES_ROOT para gravação de respostas/artefatos do CTO (resiliente)
export PROJECT_FILES_ROOT="${PROJECT_FILES_ROOT:-${HOST_PROJECT_FILES_ROOT:-$HOME/zentriz-files}}"
mkdir -p "$PROJECT_FILES_ROOT"
echo "[agents-host] PROJECT_FILES_ROOT=$PROJECT_FILES_ROOT (artefatos e respostas da IA em disco)"

if ! python3 -c "import anthropic, fastapi, uvicorn" 2>/dev/null; then
    echo "[agents-host] Instalando dependências..."
    python3 -m pip install -q -r applications/orchestrator/agents/requirements.txt 2>&1 | grep -v "pyenv.*rehash" || true
fi

LOG_LEVEL_LOWER="$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"

PYTHONPATH="$REPO_ROOT/applications" \
    exec python3 -m uvicorn orchestrator.agents.server:app \
        --host 0.0.0.0 \
        --port "$PORT" \
        --log-level "$LOG_LEVEL_LOWER"
