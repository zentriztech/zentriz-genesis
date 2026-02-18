# PRODUCT SPEC — Exemplo (Mini Voucher API + Web)

## 0. Metadados
- Produto: Voucher MVP
- Versão do Spec: 0.1
- Data: 2026-01-29
- Stack preferida: AWS Serverless + Node.js (API) + React (Web)
- Restrições: LGPD (não logar dados sensíveis), custo baixo

## 1. Visão do produto
Permitir criar vouchers e resgatar vouchers com validação simples.

## 3. Requisitos Funcionais (FR)
- **FR-01**: Criar voucher com valor e destinatário (nome + documento).
  - Aceite:
    - DADO dados válidos
    - QUANDO criar voucher
    - ENTÃO retornar voucherId e status=ACTIVE
- **FR-02**: Consultar voucher por voucherId.
- **FR-03**: Resgatar voucher (apenas se ACTIVE).
- **FR-04**: Listar vouchers paginados (admin).

## 4. Requisitos Não-Funcionais (NFR)
- **NFR-01 (Performance)**: p95 < 500ms para endpoints.
- **NFR-02 (Segurança)**: validação de input + rate limit básico.
- **NFR-03 (Observabilidade)**: logs estruturados por request_id.
- **NFR-04 (Custo)**: priorizar serviços serverless gerenciados.

## 9. DoD do produto
- [ ] Cada FR possui testes automatizados.
- [ ] QA report PASS.
