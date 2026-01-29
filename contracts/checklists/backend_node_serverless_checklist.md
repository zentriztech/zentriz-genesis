# Checklist Backend (Node.js Serverless)

## API
- [ ] Contrato em `docs/API_CONTRACT.md`
- [ ] Validação de input (schema)
- [ ] Erros padronizados com `request_id`
- [ ] Paginação/ordenação quando aplicável

## Qualidade
- [ ] Tests unit + integração
- [ ] Lint/typecheck
- [ ] Build ok

## Observabilidade
- [ ] Logs JSON
- [ ] request_id em toda request
- [ ] Métricas/alarms básicos (via DevOps)

## Segurança
- [ ] Secrets via env/secret manager
- [ ] Rate limit básico (ou WAF/API Gateway)
