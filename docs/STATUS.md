# Status do Projeto — Voucher MVP (exemplo)

- **Data**: 2026-02-17
- **Status geral**: ON_TRACK
- **Módulos (stacks)**:
  - **Backend**: Planejado. Backlog em [docs/BACKLOG_BACKEND.md](BACKLOG_BACKEND.md). API a ser implementada em services/api-node (ou api-python). Endpoints conforme [docs/API_CONTRACT.md](API_CONTRACT.md).
  - **Web**: Planejado. Backlog em [docs/BACKLOG_WEB.md](BACKLOG_WEB.md). App a ser implementada em apps/web-react.
  - **Mobile**: Fora de escopo neste MVP.
- **Riscos**: Nenhum crítico registrado.
- **Próximos passos**:
  1. Implementar API Backend (FR-01 a FR-04) em services/api-node ou api-python.
  2. Implementar aplicação Web em apps/web-react (páginas e integração com API).
  3. Executar smoke tests ([tests/smoke/](../tests/smoke/)).
  4. (Opcional) Provisionar IaC e deploy (infra/aws ou equivalente).
