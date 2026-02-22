# Project Charter — Voucher MVP (produto de exemplo)

> **Nota:** Este arquivo é um **exemplo de charter** gerado pelo pipeline para um produto (Voucher MVP). O **Zentriz Genesis** em si é o orquestrador (portal + API + runner + agents) que produz charters e backlogs a partir de specs. Spec do exemplo: [spec/PRODUCT_SPEC.md](../spec/PRODUCT_SPEC.md).

## Escopo

- **Objetivo**: Entregar um MVP funcional que permita criar, consultar, resgatar e listar (admin) vouchers, com API e interface web, atendendo aos FR e NFR do spec.
- **Entregáveis**:
  - API Backend (Node.js ou Python, serverless) com endpoints FR-01 a FR-04.
  - Aplicação Web (React) para criar voucher, consultar por ID, resgatar e listagem admin (paginada).
  - Testes automatizados por FR; smoke tests pós-deploy.
  - Documentação de API e instruções de execução/deploy.
- **Fora de escopo** (nesta fase): Mobile app; autenticação avançada; múltiplos ambientes além de dev/staging.

## Módulos (squads)

- **Backend/API**: Node.js (ou Python), AWS Lambda + API Gateway (ou equivalente), persistência (ex.: DynamoDB ou DB gerenciado). Endpoints: POST/GET /vouchers, POST /vouchers/{id}/redeem, GET /admin/vouchers (paginado).
- **Web**: React + TypeScript, consumo da API, páginas para criar, consultar, resgatar e listar vouchers; state management e testes (unit/e2e mínimo).
- **Mobile**: Não incluído neste MVP.

(Infra/DevOps é responsabilidade do DevOps em cada squad: Backend e Web.)

## Riscos e suposições

- **Risco**: Dependência de ambiente cloud (AWS) para deploy. **Mitigação**: Spec e backlogs permitem troca de cloud (Azure/GCP) via DevOps; manter IaC parametrizada.
- **Suposição**: Spec está estável para este ciclo; mudanças de FR/NFR podem exigir atualização de Charter e backlogs.

## Critérios de aceite

- Baseado no spec: todos os FR-01 a FR-04 implementados e cobertos por testes; NFR-01 a NFR-04 atendidos (performance, segurança, observabilidade, custo).
- DoD global e DoD DevOps cumpridos quando houver deploy.
- Smoke tests (API e Web) PASS.
