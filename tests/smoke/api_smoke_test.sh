#!/usr/bin/env bash
set -euo pipefail

# Variáveis esperadas:
# - BASE_URL (ex: https://xxxxx.execute-api.us-east-1.amazonaws.com)
# - REQUEST_ID (ex: uuid)
# - API_KEY (opcional)
#
# Uso:
# BASE_URL=... REQUEST_ID=... ./tests/smoke/api_smoke_test.sh

echo "== Smoke Test API =="
echo "BASE_URL=$BASE_URL"
echo "REQUEST_ID=$REQUEST_ID"

headers=(-H "x-request-id: ${REQUEST_ID}" -H "content-type: application/json")
if [[ -n "${API_KEY:-}" ]]; then
  headers+=(-H "x-api-key: ${API_KEY}")
fi

# 1) Healthcheck (se existir)
echo "-> GET /health (opcional)"
curl -fsS "${headers[@]}" "${BASE_URL}/health" >/dev/null || echo "WARN: /health não disponível (ok se não fizer parte do spec)"

# 2) Exemplo: criar voucher (FR-01)
echo "-> POST /vouchers (FR-01)"
resp=$(curl -fsS "${headers[@]}" -X POST "${BASE_URL}/vouchers" -d '{"value":50,"recipient_name":"Teste","recipient_document":"00000000000"}')
echo "$resp" | grep -q "voucherId" || (echo "FAIL: voucherId ausente" && exit 1)

# Extrai voucherId de forma simples (sem jq)
voucherId=$(echo "$resp" | sed -n 's/.*"voucherId"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
[[ -n "$voucherId" ]] || (echo "FAIL: não foi possível extrair voucherId" && exit 1)

# 3) Consultar voucher (FR-02)
echo "-> GET /vouchers/${voucherId} (FR-02)"
curl -fsS "${headers[@]}" "${BASE_URL}/vouchers/${voucherId}" | grep -q "$voucherId" || (echo "FAIL: consulta não retornou voucher" && exit 1)

echo "PASS: Smoke API"
