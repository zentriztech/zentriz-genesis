# Definition of Done (Global)
Uma entrega é considerada **DONE** somente se:

## Evidência e rastreio
- [ ] Cada item entregue está ligado a **FR-xx** e/ou **NFR-xx**
- [ ] O PR/entrega cita **arquivos** e **seções** alteradas
- [ ] Há evidência de execução (logs/prints/relatórios)

## Qualidade
- [ ] Testes automatizados PASS (mínimo: unit + integração quando aplicável)
- [ ] Lint/format/typecheck PASS
- [ ] Build PASS

## Segurança (mínimo)
- [ ] Secrets não estão hardcoded
- [ ] Inputs validados/sanitizados
- [ ] Logs sem dados sensíveis

## Documentação
- [ ] Docs atualizadas (`docs/*`)
- [ ] Instruções de execução local e deploy registradas

## Aprovação
- [ ] QA report = PASS (ou exceções aprovadas pelo PM com justificativa)

## Smoke tests (quando houver deploy)
- [ ] Smoke tests pós-deploy executados (ver [tests/smoke/](../tests/smoke/))
- [ ] Evidência anexada no QA report/Status
