# Guia: PM Auto-Backlog (geração por FR/NFR)

## Entrada
- `spec/PRODUCT_SPEC.md` com IDs FR-xx e NFR-xx.

## Processo (determinístico e simples)
1) Listar FRs e agrupar por módulo:
   - Backend: endpoints, modelos, validações
   - Web: páginas, componentes, state, chamadas API
   - Mobile: telas/fluxos, armazenamento, chamadas API
   - Infra/DevOps: deploy, pipeline, observabilidade

2) Para cada FR, criar pelo menos:
   - 1 task DEV (implementação)
   - 1 task QA (testes e validação)
   - 1 task DevOps (se houver deploy)

3) Para NFRs:
   - NFR-02 Segurança -> task de validação (lint/sast básico, headers, secrets)
   - NFR-03 Observabilidade -> logs estruturados + request_id + dashboards/alarms mínimos
   - NFR-04 Custo -> escolhas serverless e notas de otimização

## Saída
- `docs/BACKLOG_<AREA>.md` por módulo (Backend/Web/Mobile/Infra)
- Status inicial em `docs/STATUS.md`
