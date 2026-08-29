# Marketplace Multivendedor

## 0. Metadados
- **Produto:** MultiMarket — plataforma de marketplace multivendedor com split de pagamento e comissão
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Marketplace que conecta múltiplos vendedores independentes a compradores, centralizando catálogo, carrinho e pagamento. Calcula e distribui comissão da plataforma automaticamente, gerando repasses aos vendedores conforme política configurável.

## 2. Personas
- Vendedor — cadastra sua loja virtual, produtos e preços; acompanha vendas e recebe repasses.
- Comprador — navega catálogo agregado, compra de múltiplos vendedores em único pedido.
- Administrador da plataforma — define taxas de comissão, aprova novos vendedores, monitora transações.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e aprovação de vendedor
DADO um usuário não autenticado, QUANDO preenche formulário de solicitação de loja informando CNPJ, dados bancários e documentos, ENTÃO a solicitação entra em fila de análise com status "pendente".

### FR-02 — Gestão de catálogo por vendedor
DADO um vendedor aprovado, QUANDO cadastra um produto informando título, descrição, preço, estoque e categoria, ENTÃO o produto é publicado no catálogo agregado da plataforma com identificação da loja de origem.

### FR-03 — Carrinho multivendedor
DADO um comprador navegando o catálogo, QUANDO adiciona produtos de diferentes vendedores ao carrinho, ENTÃO o sistema agrupa itens por vendedor e exibe subtotal de cada loja mais frete unificado.

### FR-04 — Pedido com split de pagamento
DADO um comprador finalizando compra com carrinho de múltiplos vendedores, QUANDO efetua pagamento via gateway, ENTÃO o sistema registra um pedido-pai e cria um subpedido por vendedor, calculando comissão da plataforma sobre cada subtotal.

### FR-05 — Repasse ao vendedor
DADO um subpedido confirmado como entregue, QUANDO completa o prazo de garantia configurado (exemplo: 7 dias), ENTÃO o sistema calcula valor líquido (subtotal menos comissão) e gera crédito de repasse na conta do vendedor.

### FR-06 — Painel de repasses
DADO um vendedor autenticado, QUANDO acessa painel financeiro, ENTÃO visualiza histórico de vendas, comissões retidas, saldo disponível para saque e histórico de transferências bancárias realizadas.

## 4. Requisitos Não-Funcionais
- Catálogo agregado suporta até 100.000 produtos ativos com busca full-text em menos de 300ms.
- Disponibilidade de 99,9% para fluxo de checkout.
- PII de vendedores (CNPJ, dados bancários) armazenada cifrada (AES-256) e nunca exposta em logs.
- Conformidade PCI-DSS para processamento de pagamentos (gateway terceirizado).

## 5. Regras de Negócio
- Taxa de comissão é percentual configurável por categoria de produto (padrão 12%).
- Repasse só ocorre após confirmação de entrega e fim do prazo de garantia.
- Vendedor precisa saldo mínimo de R$ 50 para solicitar saque.
- Produto com estoque zero é automaticamente ocultado do catálogo.

## 6. Modelo de Dados
- sellers(id, name, cnpj, bank_account_encrypted, status, commission_rate)
- stores(id, seller_id, store_name, slug, logo_url)
- products(id, store_id, title, price, stock, category, active)
- orders(id, buyer_id, total, status, created_at)
- order_items(id, order_id, product_id, seller_id, quantity, subtotal, commission)
- payouts(id, seller_id, amount, status, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para marketplace público e painel de vendedor.
- Backend: Fastify + PostgreSQL; Redis para cache de catálogo; RabbitMQ para processamento assíncrono de repasses.
- Integração: gateway de pagamento (Stripe/Asaas); webhook de confirmação de entrega.
