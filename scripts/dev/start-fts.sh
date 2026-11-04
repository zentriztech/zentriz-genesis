#!/usr/bin/env bash
# start-fts.sh — sobe o full-test-server (FTS) no host de DESENVOLVIMENTO com bind restrito e verificação de firewall (AV/A-6, B-2 parcial).
#
# O que faz, nesta ordem (fail-closed):
#   1. carrega o EnvironmentFile (FTS_ENV_FILE; padrão /etc/systemd/genesis-fts.env se existir) SEM sobrescrever o que já está no ambiente;
#   2. recusa subir sem FTS_AUTH_TOKEN (o servidor também recusa; aqui o erro é claro e imediato);
#   3. define FTS_BIND: loopback + IP da bridge do Docker (docker0; padrão 172.17.0.1) — é o endereço que `host.docker.internal`
#      (host-gateway do compose) resolve dentro dos containers. NUNCA 0.0.0.0. Para outro bind, exporte FTS_BIND antes;
#   4. confere o firewall (`fts-firewall.sh --check`): ausente => aviso; com FTS_REQUIRE_FIREWALL=1 => recusa;
#   5. B-2: o FTS roda código do produto no host. Em host de PRODUÇÃO (FTS_HOST_ROLE=production) RECUSA subir, a menos que o executor
#      esteja isolado (FTS_ISOLATED_EXECUTOR=1: container descartável, Host B ou executor sem rede — ver
#      project/docs/analysis/EVOLUIR-PROJETO-AX-b2-isolamento-executor.md). Padrão do papel: development.
#
# Uso:  scripts/dev/start-fts.sh [--dry-run]     (--dry-run só imprime o que faria; não sobe nada e não exige root)
# NÃO reinicia nem para um FTS já em execução: se a porta estiver ocupada, o servidor falha ao subir (nada é derrubado aqui).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

ENV_FILE="${FTS_ENV_FILE:-/etc/systemd/genesis-fts.env}"
if [ -r "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -z "${!key+x}" ] && export "$key=$val"
  done < "$ENV_FILE"
fi

die() { echo "start-fts: $*" >&2; exit "${2:-1}"; }

[ -n "${FTS_AUTH_TOKEN:-}" ] || die "FTS_AUTH_TOKEN nao definido (gerar: openssl rand -hex 32; mesmo valor em /opt/zentriz-genesis/.env)." 2

if [ "${FTS_HOST_ROLE:-development}" = "production" ] && [ "${FTS_ISOLATED_EXECUTOR:-0}" != "1" ]; then
  die "host de PRODUCAO sem executor isolado (B-2): o FTS roda npm/jest/claude do produto no host. Veja project/docs/analysis/EVOLUIR-PROJETO-AX-b2-isolamento-executor.md. Defina FTS_ISOLATED_EXECUTOR=1 SOMENTE depois de isolar." 3
fi

if [ -z "${FTS_BIND:-}" ]; then
  BRIDGE_IP="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
  FTS_BIND="127.0.0.1,${BRIDGE_IP:-172.17.0.1}"
fi
export FTS_BIND
case ",$FTS_BIND," in *,0.0.0.0,*|*,::,*) die "FTS_BIND=$FTS_BIND escuta em todas as interfaces; use 127.0.0.1 e o IP da bridge (172.17.0.1)." 4 ;; esac

FW="ausente"
if "$HERE/fts-firewall.sh" --check >/dev/null 2>&1; then FW="presente"; fi
if [ "$FW" != "presente" ]; then
  echo "start-fts: AVISO: regra de firewall da porta ${FULL_TEST_PORT:-7878} ausente (ou ilegivel sem root). Aplique: sudo $HERE/fts-firewall.sh" >&2
  [ "${FTS_REQUIRE_FIREWALL:-0}" = "1" ] && die "FTS_REQUIRE_FIREWALL=1 e o firewall nao esta presente." 5
fi

echo "start-fts: bind=$FTS_BIND porta=${FULL_TEST_PORT:-7878} papel=${FTS_HOST_ROLE:-development} firewall=$FW"
[ "$DRY" -eq 1 ] && exit 0
cd "$ROOT"
exec python3 scripts/full-test-server.py
