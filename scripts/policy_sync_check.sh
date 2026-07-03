#!/usr/bin/env bash
# policy_sync_check.sh
# Verifica sincronia entre applications/agents/policies/project_types.yaml
# e os project_type ids expostos pelo portal (spec/page.tsx).
#
# Modos:
#   --wave0   (default) — falha se tipo canônico do YAML não existe no portal
#             (evita definir política que ninguém consegue escolher)
#   --strict  — falha se qualquer id do portal não estiver no YAML
#              (canônico OU alias). Uso: Wave 2 quando toda UI deve estar coberta.
#   --list    — só lista status, exit 0
#
# Uso local:      ./scripts/policy_sync_check.sh
# Uso em CI:      ./scripts/policy_sync_check.sh --wave0 (ou --strict na Wave 2)
# Uso pre-commit: adicionar chamada em .husky/pre-commit ou .git/hooks/pre-commit

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YAML_FILE="$REPO_ROOT/applications/agents/policies/project_types.yaml"
PORTAL_FILE="$REPO_ROOT/applications/apps/genesis-web/app/(dashboard)/spec/page.tsx"
MODE="${1:---wave0}"

if [ ! -f "$YAML_FILE" ]; then
  echo "❌ ERRO: YAML não encontrado em $YAML_FILE"
  exit 2
fi
if [ ! -f "$PORTAL_FILE" ]; then
  echo "❌ ERRO: Portal não encontrado em $PORTAL_FILE"
  exit 2
fi

# Extrai ids do portal
# Nota: usar [[:space:]] em vez de \s — BSD sed (macOS) não expande \s.
PORTAL_IDS=$(grep -oE 'value:[[:space:]]*"[a-z_]+"' "$PORTAL_FILE" | sed -E 's/value:[[:space:]]*"([a-z_]+)"/\1/' | sort -u)

# Extrai canônicos + aliases do YAML usando Python (mais robusto que grep aninhado)
YAML_INFO=$(python3 - "$YAML_FILE" <<'PY'
import sys, yaml
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
canon = sorted(d.get('types', {}).keys())
aliases = sorted(d.get('type_aliases', {}).keys())
print("CANONICAL:" + ",".join(canon))
print("ALIASES:"  + ",".join(aliases))
PY
)

CANONICAL=$(echo "$YAML_INFO" | grep "^CANONICAL:" | sed 's/^CANONICAL://' | tr ',' '\n' | sort -u)
ALIASES=$(echo "$YAML_INFO"   | grep "^ALIASES:"   | sed 's/^ALIASES://'   | tr ',' '\n' | sort -u)

# _default é reservado interno — remove do set de comparação
CANONICAL_PUBLIC=$(echo "$CANONICAL" | grep -v "^_default$" || true)

# União: tudo que YAML reconhece
KNOWN=$(echo -e "$CANONICAL_PUBLIC\n$ALIASES" | sort -u)

# Interseção e diferenças
NOT_IN_YAML=$(comm -23 <(echo "$PORTAL_IDS") <(echo "$KNOWN"))
NOT_IN_PORTAL=$(comm -23 <(echo "$CANONICAL_PUBLIC") <(echo "$PORTAL_IDS"))

echo "─────────────────────────────────────────────────────────"
echo " policy_sync_check.sh  ·  mode=$MODE"
echo "─────────────────────────────────────────────────────────"
echo " Portal ids:         $(echo "$PORTAL_IDS" | wc -l | tr -d ' ')"
echo " YAML canônicos:     $(echo "$CANONICAL_PUBLIC" | wc -l | tr -d ' ') (+ _default reservado)"
echo " YAML aliases:       $(echo "$ALIASES" | wc -l | tr -d ' ')"
echo " Portal ∉ YAML:      $(echo "$NOT_IN_YAML" | grep -c . || true)"
echo " YAML ∉ Portal:      $(echo "$NOT_IN_PORTAL" | grep -c . || true)"
echo "─────────────────────────────────────────────────────────"

FAIL=0

case "$MODE" in
  --strict)
    if [ -n "$NOT_IN_YAML" ]; then
      echo ""
      echo "❌ STRICT: ids do portal sem cobertura no YAML (canônico/alias):"
      echo "$NOT_IN_YAML" | sed 's/^/     - /'
      FAIL=1
    fi
    ;;
  --wave0)
    # Wave 0 tolera ids do portal fora do YAML (caem em _default = REVISION do CTO)
    # Falha se tipo canônico do YAML NÃO existe no portal (política sem UI)
    if [ -n "$NOT_IN_PORTAL" ]; then
      # 'other' é interno mas o portal também tem — checar se está lá
      REAL_MISSING=$(echo "$NOT_IN_PORTAL" | while read t; do
        [ -n "$t" ] && ! echo "$PORTAL_IDS" | grep -qx "$t" && echo "$t"
      done)
      if [ -n "$REAL_MISSING" ]; then
        echo ""
        echo "❌ WAVE0: tipos canônicos do YAML sem UI no portal:"
        echo "$REAL_MISSING" | sed 's/^/     - /'
        echo ""
        echo "   Cada tipo canônico deve estar selecionável no portal (spec/page.tsx)."
        echo "   Ou remova do YAML, ou adicione ao dropdown."
        FAIL=1
      fi
    fi
    # Informativo — não falha
    if [ -n "$NOT_IN_YAML" ]; then
      COUNT=$(echo "$NOT_IN_YAML" | grep -c . || true)
      echo ""
      echo "ℹ️  Wave 0: $COUNT ids do portal caem em _default (BLOCKER via REVISION do CTO)."
      echo "   Isso é intencional. Wave 2 (T-15) adiciona overrides ou aliases."
    fi
    ;;
  --list)
    echo ""
    echo "Portal ids:"
    echo "$PORTAL_IDS" | sed 's/^/  /'
    echo ""
    echo "YAML canônicos (públicos):"
    echo "$CANONICAL_PUBLIC" | sed 's/^/  /'
    echo ""
    echo "YAML aliases:"
    echo "$ALIASES" | sed 's/^/  /'
    ;;
  *)
    echo "Uso: $0 [--wave0|--strict|--list]"
    exit 2
    ;;
esac

if [ $FAIL -eq 0 ]; then
  echo ""
  echo "✓ policy_sync_check OK"
  exit 0
else
  exit 1
fi
