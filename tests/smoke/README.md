# Smoke Tests (Templates)

## Objetivo
Validar rapidamente, pós-deploy, que o serviço/cliente está funcionando.

## Padrões
- Deve rodar em CI/CD após deploy
- Deve falhar com mensagem clara
- Deve ser rápido (< 2 min)

## Templates
- `api_smoke_test.sh` (curl)
- `web_smoke_test.sh` (curl + checagem de HTML/health)
- `mobile_smoke_test.md` (checklist de build e sanity)
