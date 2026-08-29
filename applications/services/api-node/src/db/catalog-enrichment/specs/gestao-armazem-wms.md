# Gestão de Armazém WMS

## 0. Metadados
- **Produto:** WarehousePro — sistema de gerenciamento de armazém (WMS) com controle de estoque, endereçamento e separação de pedidos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Otimizar operações de armazém com rastreabilidade completa de mercadorias, endereçamento inteligente e picking eficiente, reduzindo erros de separação e tempo de expedição.

## 2. Personas
- Operador de recebimento — confere entrada de mercadorias e registra localização.
- Separador (picker) — coleta itens de pedidos usando coletor de código de barras.
- Gestor de armazém — monitora ocupação, inventário e produtividade da equipe.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis operacionais
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema com permissões do seu perfil (operador, separador ou gestor).

### FR-02 — Recebimento e conferência de mercadoria
DADO um operador de recebimento, QUANDO escaneia código de barras da nota fiscal e dos itens, ENTÃO o sistema valida quantidade esperada versus recebida e registra divergências.

### FR-03 — Endereçamento de itens no armazém
DADO mercadoria conferida, QUANDO o operador escaneia a posição de armazenamento (corredor, prateleira, nível), ENTÃO o sistema registra localização do item e atualiza mapa de ocupação.

### FR-04 — Geração de lista de separação (picking list)
DADO um pedido confirmado, QUANDO o sistema gera a lista de picking, ENTÃO agrupa itens por proximidade de localização para otimizar rota do separador.

### FR-05 — Separação de pedido com confirmação por código de barras
DADO um separador com lista de picking, QUANDO escaneia o item e a quantidade coletada, ENTÃO o sistema valida contra a lista e marca item como separado.

### FR-06 — Expedição e baixa de estoque
DADO um pedido totalmente separado, QUANDO o operador confirma expedição, ENTÃO o sistema dá baixa no estoque das posições correspondentes e gera documento de saída.

### FR-07 — Inventário rotativo e auditoria de estoque
DADO um gestor, QUANDO agenda inventário de uma área, ENTÃO o sistema gera lista de contagem por posição e compara resultado com estoque registrado, apontando divergências.

## 4. Requisitos Não-Funcionais
- Sistema deve responder escaneamento de código de barras em menos de 300ms para não atrasar operação.
- Disponibilidade de 99,8% em horário de operação do armazém.
- Suporte a até 50 coletores simultâneos escaneando itens.
- Integrações via API REST com sistemas de pedidos (ERP) para receber picking lists automaticamente.

## 5. Regras de Negócio
- Item só pode ser alocado em posição vazia ou que já contenha o mesmo SKU.
- Separação FIFO obrigatória para itens com validade; sistema prioriza posições com data de entrada mais antiga.
- Divergência de inventário acima de 5% aciona alerta ao gestor e recontagem obrigatória.
- Pedido parcialmente separado não pode ser expedido; sistema bloqueia até 100% coletado.

## 6. Modelo de Dados
- items(id, sku, description, barcode, unit, requires_expiry)
- locations(id, aisle, shelf, level, capacity, occupied_by_sku, quantity)
- receipts(id, supplier_invoice, receipt_date, status)
- receipt_items(id, receipt_id, item_id, expected_qty, received_qty, discrepancy)
- picking_orders(id, external_order_id, status, assigned_to, created_at)
- picking_items(id, picking_order_id, item_id, quantity, location_id, picked_qty, picked_at)
- shipments(id, picking_order_id, shipped_at, document_number)
- inventory_audits(id, location_id, scheduled_date, counted_qty, system_qty, audited_by)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI adaptado para coletores móveis (touch-first) e dashboard web para gestão.
- Backend: Fastify + PostgreSQL com otimização de rotas de picking via algoritmo de menor distância.
- Integração: API REST para receber pedidos de ERP externo; webhook para notificar expedição.
