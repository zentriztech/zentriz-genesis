#!/usr/bin/env bash
# fts-firewall.sh — regra de firewall do full-test-server (FTS), versionada (AV/A-6).
#
# O FTS executa código do produto no HOST (npm ci/postinstall, jest/vitest, `claude --dangerously-skip-permissions`). A autenticação por
# token (X-FTS-Token) é a 1ª barreira; esta regra é a 2ª: a porta do FTS só é alcançável a partir de loopback e de redes privadas do
# Docker (172.16.0.0/12). Qualquer outra origem é descartada (DROP) — inclusive o `/health`, que é aberto.
#
# Uso:
#   sudo scripts/dev/fts-firewall.sh            # aplica (idempotente: não duplica regra)
#   scripts/dev/fts-firewall.sh --check         # SOMENTE LEITURA: exit 0 = regras presentes; 1 = faltam; 2 = sem iptables/permissão
#   sudo scripts/dev/fts-firewall.sh --remove   # remove as regras que este script criou
#
# Variáveis: FTS_PORT (padrão FULL_TEST_PORT ou 7878) · FTS_ALLOWED_CIDR (padrão 172.16.0.0/12) · IPTABLES_BIN / IP6TABLES_BIN (testes).
# Observação: as regras NÃO sobrevivem a reboot; persista com `netfilter-persistent save` (Debian/Ubuntu) ou aplique no ExecStartPre
# do unit. Em AWS, o Security Group da instância também deve fechar a porta (defesa em profundidade) — conferir no console.
set -euo pipefail

PORT="${FTS_PORT:-${FULL_TEST_PORT:-7878}}"
CIDR="${FTS_ALLOWED_CIDR:-172.16.0.0/12}"
IPT="${IPTABLES_BIN:-iptables}"
IPT6="${IP6TABLES_BIN:-ip6tables}"
MODE="apply"
case "${1:-}" in
  "" ) ;;
  --check ) MODE="check" ;;
  --remove ) MODE="remove" ;;
  -h|--help ) sed -n '2,17p' "$0"; exit 0 ;;
  * ) echo "uso: $0 [--check|--remove]" >&2; exit 64 ;;
esac

# Regras (ordem importa: ACCEPT de loopback ANTES do DROP; `! -s CIDR` também pegaria 127.0.0.1).
accept_lo=(INPUT -i lo -p tcp --dport "$PORT" -j ACCEPT)
drop_ext=(INPUT ! -s "$CIDR" -p tcp --dport "$PORT" -j DROP)
drop_v6=(INPUT ! -i lo -p tcp --dport "$PORT" -j DROP)

# Root só é exigido com o iptables REAL (IPTABLES_BIN definido = binário de teste).
need_root() { [ -n "${IPTABLES_BIN:-}" ] || [ "$(id -u)" -eq 0 ] || { echo "fts-firewall: precisa de root (sudo)" >&2; exit 2; }; }
have() { "$@" >/dev/null 2>&1; }
if ! command -v "$IPT" >/dev/null 2>&1; then echo "fts-firewall: '$IPT' nao encontrado" >&2; exit 2; fi

status=0
report() { printf '%-9s %s\n' "$1" "$2"; }

check_rule() { # $1=bin  $2=descrição  resto=regra
  local bin="$1" desc="$2"; shift 2
  if have "$bin" -C "$@"; then report PRESENTE "$desc"; return 0; fi
  # -C falha tanto por regra ausente quanto por falta de permissão; distingue com -S (listar também exige root em alguns hosts)
  report AUSENTE "$desc"; return 1
}

case "$MODE" in
  check)
    check_rule "$IPT" "ACCEPT loopback -> :$PORT" "${accept_lo[@]}" || status=1
    check_rule "$IPT" "DROP origem fora de $CIDR -> :$PORT" "${drop_ext[@]}" || status=1
    if command -v "$IPT6" >/dev/null 2>&1; then
      check_rule "$IPT6" "DROP IPv6 nao-loopback -> :$PORT" "${drop_v6[@]}" || status=1
    fi
    if [ "$status" -ne 0 ]; then echo "fts-firewall: regras ausentes (ou sem permissao para ler). Aplique: sudo $0" >&2; fi
    exit "$status" ;;
  apply)
    need_root
    # ACCEPT de loopback primeiro, DROP depois; -C evita duplicar em reexecução.
    have "$IPT" -C "${accept_lo[@]}" || "$IPT" -I INPUT 1 "${accept_lo[@]:1}"
    if ! have "$IPT" -C "${drop_ext[@]}"; then
      # insere logo depois do ACCEPT de loopback (posição 2)
      "$IPT" -I INPUT 2 "${drop_ext[@]:1}"
    fi
    if command -v "$IPT6" >/dev/null 2>&1 && ! have "$IPT6" -C "${drop_v6[@]}"; then "$IPT6" -I INPUT 1 "${drop_v6[@]:1}" || true; fi
    report APLICADO "porta $PORT: loopback + $CIDR; demais origens DROP"
    exec "$0" --check ;;
  remove)
    need_root
    while have "$IPT" -C "${drop_ext[@]}"; do "$IPT" -D "${drop_ext[@]}"; done
    while have "$IPT" -C "${accept_lo[@]}"; do "$IPT" -D "${accept_lo[@]}"; done
    if command -v "$IPT6" >/dev/null 2>&1; then while have "$IPT6" -C "${drop_v6[@]}"; do "$IPT6" -D "${drop_v6[@]}"; done; fi
    report REMOVIDO "regras da porta $PORT" ;;
esac
