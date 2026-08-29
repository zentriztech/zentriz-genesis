# Estoque e PDV

## 0. Metadados
- **Produto:** StockPOS — controle de estoque e ponto de venda para pequeno e médio varejo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema integrado de estoque e vendas para varejistas que precisam de controle em tempo real de saldo, movimentações e ruptura, eliminando descontrole manual e perda de vendas por falta de produtos.

## 2. Personas
- Dono da loja — cadastra produtos, monitora giro de estoque e relatórios de vendas.
- Operador de caixa — registra vendas no PDV com baixa automática de estoque.
- Repositor — consulta saldo e recebe alertas de ruptura para reposição de gôndola.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (dono, caixa ou repositor).

### FR-02 — Cadastro de produtos e saldo inicial
DADO um dono de loja autenticado, QUANDO cadastra um produto informando código de barras, nome, preço de custo e venda, ENTÃO o sistema registra o produto com saldo inicial zero e permite posterior entrada de estoque.

### FR-03 — Entrada e saída manual de estoque
DADO um produto cadastrado, QUANDO o dono registra uma entrada informando quantidade e fornecedor, ENTÃO o saldo é incrementado e o custo médio recalculado; saídas por perda ou devolução decrementam o saldo.

### FR-04 — Venda no PDV com baixa automática de estoque
DADO um operador de caixa autenticado, QUANDO finaliza uma venda informando produtos e quantidades via código de barras, ENTÃO o sistema calcula o total, registra a venda, baixa o estoque automaticamente e emite comprovante.

### FR-05 — Alerta de ruptura e estoque mínimo
DADO produtos cadastrados com estoque mínimo definido, QUANDO o saldo de um produto atinge ou fica abaixo do mínimo, ENTÃO o sistema exibe alerta no painel e notifica o dono e repositor.

### FR-06 — Relatório de giro de estoque e produtos parados
DADO um período selecionado pelo dono, QUANDO solicita o relatório de giro, ENTÃO o sistema calcula a rotatividade por produto (vendas/estoque médio) e destaca produtos com giro zero (parados há mais de 30 dias).

## 4. Requisitos Não-Funcionais
- PDV deve responder em < 200ms para finalização de venda; operação offline com fila de sincronização quando rede cair.
- Disponibilidade 99,5%; backup diário de transações.
- Dados de custo e margem visíveis apenas para perfil dono.

## 5. Regras de Negócio
- Código de barras é único por tenant; produto sem código pode ser vendido por busca manual.
- Venda com estoque insuficiente é bloqueada; sistema sugere venda parcial.
- Custo médio do produto recalculado a cada entrada pelo método FIFO.
- Cancelamento de venda exige senha de supervisor e recompõe o estoque.

## 6. Modelo de Dados
- products(id, barcode, name, cost_price, sell_price, stock_qty, min_stock_qty)
- stock_movements(id, product_id, movement_type, qty, cost_price, timestamp, user_id, notes)
- sales(id, total_amount, payment_method, completed_at, cashier_user_id, status)
- sale_items(id, sale_id, product_id, qty, unit_price, subtotal)

## 7. Stack sugerida
- Frontend: React + Electron (PDV desktop offline). Backend: Fastify + PostgreSQL. Auth JWT.
