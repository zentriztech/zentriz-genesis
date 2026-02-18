# Smoke Test Mobile (Checklist)

## Objetivo
Confirmar que o app compila e executa fluxos mínimos do spec.

## Checklist mínimo (RN ou Nativo)
- [ ] Build/Compile OK (Debug)
- [ ] App abre sem crash
- [ ] Tela inicial renderiza
- [ ] Fluxo principal do spec (ex.: login ou listagem) funciona
- [ ] Logs não contém dados sensíveis
- [ ] Se usa API, validar que BASE_URL está correto por env

## Evidências
- Print do build (CI log)
- Print de execução (simulador/emulador)
