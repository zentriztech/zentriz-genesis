# API Node.js (Template)
Template mínimo para API server-side (Node.js).

## Stack sugerida
- TypeScript
- Fastify (ou NestJS, conforme PM)
- Testes: Vitest/Jest
- Deploy: Serverless (AWS Lambda/API Gateway) ou equivalente

## Próximos passos (Dev Backend)
1) Gerar projeto (ex.: `npm init` + tsconfig)
2) Implementar endpoints do [docs/API_CONTRACT.md](../docs/API_CONTRACT.md)
3) Adicionar testes por FR
4) Integrar logs JSON + request_id (NFR-03)
