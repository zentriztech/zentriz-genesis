# Backlog — Backend (exemplo)

- TSK-BE-001: Implementar FR-01 (POST /vouchers) — DEV_BACKEND — P1
  - Requisitos: FR-01, NFR-02
  - Aceite: retorna voucherId, status=ACTIVE
  - Evidência: testes Jest PASS + logs

- TSK-BE-002: Implementar FR-02 (GET /vouchers/{id}) — DEV_BACKEND — P1
  - Requisitos: FR-02, NFR-03

- TSK-BE-003: Implementar FR-03 (redeem) — DEV_BACKEND — P1
  - Requisitos: FR-03, NFR-02

- TSK-BE-004: Testes e QA report — QA_BACKEND — P1
  - Requisitos: FR-01..03, NFR-02, NFR-03

- TSK-BE-005: Provisionar deploy (AWS) + smoke — DEVOPS_AWS — P1
  - Requisitos: NFR-03, NFR-04
  - DoD: [contracts/devops_definition_of_done.md](../contracts/devops_definition_of_done.md)
