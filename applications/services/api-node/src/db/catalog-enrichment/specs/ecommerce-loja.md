# Loja E-commerce

## 0. Metadados
- **Produto:** ShopHub — plataforma de e-commerce para pequenos e médios lojistas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que lojistas vendam produtos online com catálogo organizado, carrinho de compras, cálculo de frete e checkout integrado, enquanto compradores navegam, comparam e finalizam pedidos de forma simples e segura.

## 2. Personas
- Comprador — navega o catálogo, adiciona produtos ao carrinho e finaliza a compra.
- Lojista — cadastra produtos, gerencia estoque, atualiza preços e acompanha pedidos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação de usuários
DADO um comprador ou lojista cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa sua área correspondente.

### FR-02 — Catálogo de produtos com busca e filtros
DADO um comprador no catálogo, QUANDO busca por nome ou aplica filtro de categoria, ENTÃO visualiza lista paginada de produtos correspondentes com imagem, nome, preço e disponibilidade.

### FR-03 — Carrinho de compras e cálculo de frete
DADO um comprador com produtos no carrinho, QUANDO informa CEP de entrega, ENTÃO o sistema calcula frete via API dos Correios e exibe total do pedido.

### FR-04 — Checkout e finalização de pedido
DADO um comprador no checkout, QUANDO confirma endereço e forma de pagamento, ENTÃO o pedido é registrado com status "aguardando pagamento" e o comprador recebe número de confirmação.

### FR-05 — Gestão de pedidos e status de entrega
DADO um lojista autenticado, QUANDO acessa painel de pedidos, ENTÃO visualiza lista de pedidos com status (aguardando/pago/enviado/entregue) e pode atualizar o rastreamento.

### FR-06 — Painel administrativo de produtos
DADO um lojista autenticado, QUANDO cadastra ou edita um produto, ENTÃO pode definir nome, descrição, preço, estoque, categoria e imagem.

### FR-07 — Relatório de vendas
DADO um lojista autenticado, QUANDO acessa relatórios, ENTÃO visualiza total de vendas por período, produtos mais vendidos e ticket médio.

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; disponibilidade 99,5%. Imagens de produtos via CDN.
- Dados de pagamento (cartão) nunca persistidos localmente; integração com gateway externo.
- LGPD: CPF e endereço de entrega restritos ao contexto do pedido, nunca em logs.

## 5. Regras de Negócio
- Produto com estoque zerado não pode ser adicionado ao carrinho.
- Pedido só pode ter status alterado sequencialmente (aguardando→pago→enviado→entregue).
- Frete calculado por peso total do carrinho e CEP de destino; frete grátis acima de R$ 200.

## 6. Modelo de Dados
- products(id, name, description, price, stock, category_id, image_url)
- categories(id, name, slug)
- carts(id, user_id, created_at)
- cart_items(id, cart_id, product_id, quantity)
- orders(id, user_id, total, shipping_cost, status, tracking_code, created_at)
- order_items(id, order_id, product_id, quantity, unit_price)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI para catálogo e checkout responsivo.
- Backend: Fastify + PostgreSQL para API de produtos, pedidos e autenticação.
- Integração: API Correios para frete, gateway de pagamento externo (webhook para confirmação).
