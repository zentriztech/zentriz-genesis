# Loja Dropshipping

## 0. Metadados
- **Produto:** DropShip Pro — marketplace dropshipping com repasse automatizado a fornecedores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de e-commerce dropshipping que permite lojistas venderem produtos sem estoque físico, integrando catálogo de fornecedores e automatizando o repasse de pedidos.

## 2. Personas
- Lojista — importa produtos de fornecedores e gerencia vendas.
- Cliente final — navega catálogo e realiza compras.
- Fornecedor — recebe pedidos repassados e atualiza rastreamento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um lojista cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o painel administrativo.

### FR-02 — Importação de produtos de fornecedores
DADO um lojista autenticado, QUANDO importa produtos via CSV ou API de fornecedor, ENTÃO os produtos são cadastrados no catálogo com margem de lucro configurada e sincronização de estoque ativa.

### FR-03 — Catálogo e checkout ao cliente final
DADO um cliente não autenticado, QUANDO navega o catálogo e adiciona produtos ao carrinho, ENTÃO pode finalizar compra informando dados de entrega e pagamento, gerando um pedido confirmado.

### FR-04 — Repasse automatizado de pedido ao fornecedor
DADO um pedido confirmado e pago, QUANDO o webhook de pagamento é recebido, ENTÃO o sistema cria automaticamente um pedido no fornecedor via API e registra o ID de fulfillment.

### FR-05 — Sincronização de estoque e rastreamento
DADO um produto com sincronização ativa, QUANDO o fornecedor atualiza estoque ou código de rastreio via webhook, ENTÃO o catálogo é atualizado e o cliente recebe notificação de envio.

### FR-06 — Gestão de margens e precificação
DADO um lojista, QUANDO define margem percentual sobre o preço de custo do fornecedor, ENTÃO o preço de venda é calculado automaticamente e ajustado em tempo real se o fornecedor alterar o preço de custo.

## 4. Requisitos Não-Funcionais
- Catálogo deve carregar em menos de 500ms p95.
- Disponibilidade de 99,5% para operações de checkout.
- PII de clientes (CPF, cartão) nunca em logs; armazenamento criptografado.
- LGPD: consentimento explícito para uso de dados pessoais e direito ao esquecimento.

## 5. Regras de Negócio
- Pedido só é repassado ao fornecedor após confirmação de pagamento.
- Produto sem estoque no fornecedor é automaticamente ocultado do catálogo.
- Margem mínima de 10% sobre preço de custo do fornecedor.
- Cada lojista pode ter múltiplos fornecedores, mas um produto pertence a apenas um fornecedor.

## 6. Modelo de Dados
- suppliers(id, name, api_key, webhook_url, status)
- products(id, supplier_id, sku, name, cost_price, margin_percent, stock, visible)
- orders(id, customer_email, total, status, payment_status, created_at)
- order_items(id, order_id, product_id, quantity, unit_price)
- fulfillments(id, order_id, supplier_order_id, tracking_code, status)

## 7. Stack sugerida
- Frontend: Next.js 14 (App Router) + MUI para painel admin; Tailwind para storefront.
- Backend: Fastify + PostgreSQL para transações; Redis para cache de estoque.
- Pagamentos: integração Stripe ou Mercado Pago.
