#!/usr/bin/env bash
set -euo pipefail

# Variáveis esperadas:
# - WEB_URL (ex: https://dxxxx.cloudfront.net)
# - REQUEST_ID (ex: uuid)
#
# Uso:
# WEB_URL=... REQUEST_ID=... ./tests/smoke/web_smoke_test.sh

echo "== Smoke Test Web =="
echo "WEB_URL=$WEB_URL"
echo "REQUEST_ID=$REQUEST_ID"

# 1) Home acessível
echo "-> GET /"
html=$(curl -fsS -H "x-request-id: ${REQUEST_ID}" "${WEB_URL}/")
echo "$html" | grep -qi "<html" || (echo "FAIL: resposta não parece HTML" && exit 1)

# 2) Health/metadata (opcional)
echo "-> GET /meta.json (opcional)"
curl -fsS -H "x-request-id: ${REQUEST_ID}" "${WEB_URL}/meta.json" >/dev/null || echo "WARN: /meta.json não disponível"

echo "PASS: Smoke Web"
