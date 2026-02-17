#!/usr/bin/env bash
set -euo pipefail

# Smoke test da API Voucher. Rode contra a API local ou em Docker.
#
# Variáveis:
#   BASE_URL ou API_BASE_URL — URL base da API (ex: http://localhost:3000). Default: http://localhost:3000
#   REQUEST_ID — opcional; x-request-id enviado nas requisições
#   API_KEY — opcional; header x-api-key
#
# Uso:
#   ./tests/smoke/api_smoke_test.sh
#   API_BASE_URL=http://localhost:3000 ./tests/smoke/api_smoke_test.sh
#   BASE_URL=https://api.example.com REQUEST_ID=my-id ./tests/smoke/api_smoke_test.sh

BASE_URL="${BASE_URL:-${API_BASE_URL:-http://localhost:3000}}"
REQUEST_ID="${REQUEST_ID:-$(uuidgen 2>/dev/null || echo "smoke-$(date +%s)")}"

echo "== Smoke Test API =="
echo "BASE_URL=$BASE_URL"
echo "REQUEST_ID=$REQUEST_ID"

headers=(-H "x-request-id: ${REQUEST_ID}" -H "content-type: application/json")
if [[ -n "${API_KEY:-}" ]]; then
  headers+=(-H "x-api-key: ${API_KEY}")
fi

# 1) Healthcheck
echo "-> GET /health"
curl -fsS "${headers[@]}" "${BASE_URL}/health" | grep -q "ok" || (echo "FAIL: /health não retornou ok" && exit 1)

# 2) Criar voucher (FR-01) — base path /api
echo "-> POST /api/vouchers (FR-01)"
resp=$(curl -fsS "${headers[@]}" -X POST "${BASE_URL}/api/vouchers" -d '{"value":50,"recipient_name":"Teste","recipient_document":"00000000000"}')
echo "$resp" | grep -q "voucherId" || (echo "FAIL: voucherId ausente em $resp" && exit 1)
echo "$resp" | grep -q "ACTIVE" || (echo "FAIL: status ACTIVE ausente" && exit 1)

voucherId=$(echo "$resp" | sed -n 's/.*"voucherId"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
[[ -n "$voucherId" ]] || (echo "FAIL: não foi possível extrair voucherId" && exit 1)

# 3) Consultar voucher (FR-02)
echo "-> GET /api/vouchers/${voucherId} (FR-02)"
curl -fsS "${headers[@]}" "${BASE_URL}/api/vouchers/${voucherId}" | grep -q "$voucherId" || (echo "FAIL: consulta não retornou voucher" && exit 1)

# 4) Resgatar voucher (FR-03)
echo "-> POST /api/vouchers/${voucherId}/redeem (FR-03)"
curl -fsS "${headers[@]}" -X POST "${BASE_URL}/api/vouchers/${voucherId}/redeem" | grep -q "REDEEMED" || (echo "FAIL: redeem não retornou REDEEMED" && exit 1)

# 5) Listar admin (FR-04)
echo "-> GET /api/admin/vouchers (FR-04)"
curl -fsS "${headers[@]}" "${BASE_URL}/api/admin/vouchers?page=1&pageSize=5" | grep -q "items" || (echo "FAIL: admin/vouchers não retornou items" && exit 1)

echo "PASS: Smoke API"
