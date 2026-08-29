# Delivery de Comida

## 0. Metadados
- **Produto:** FoodExpress — plataforma de delivery de comida conectando clientes, restaurantes e entregadores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conectar clientes a restaurantes, processar pedidos com pagamento online, calcular taxa de entrega e rastrear entrega em tempo real, oferecendo conveniência e rapidez.

## 2. Personas
- Cliente — busca restaurantes, monta pedido e acompanha entrega em tempo real.
- Restaurante — recebe pedidos, confirma preparo e notifica quando está pronto.
- Entregador — aceita entregas, navega até o endereço e confirma entrega.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo de restaurantes
DADO um cliente na plataforma, QUANDO busca por categoria (pizza, japonês) ou nome, ENTÃO visualiza restaurantes disponíveis com tempo estimado de entrega, avaliação e taxa de entrega.

### FR-02 — Montagem do pedido
DADO um cliente visualizando o cardápio de um restaurante, QUANDO adiciona itens ao carrinho com adicionais e observações, ENTÃO o sistema calcula o subtotal, taxa de entrega e total do pedido.

### FR-03 — Pagamento e finalização do pedido
DADO um cliente com carrinho preenchido, QUANDO escolhe forma de pagamento (cartão online, PIX, dinheiro na entrega) e confirma, ENTÃO o pedido é enviado ao restaurante e o pagamento é processado (se online).

### FR-04 — Confirmação e preparo pelo restaurante
DADO um restaurante recebendo um pedido, QUANDO confirma o recebimento, ENTÃO o status muda para "em preparo" e o cliente recebe notificação com tempo estimado.

### FR-05 — Atribuição de entregador
DADO um pedido com status "pronto", QUANDO o restaurante marca como pronto, ENTÃO o sistema busca entregadores disponíveis próximos e envia notificação ao primeiro disponível.

### FR-06 — Rastreamento em tempo real
DADO um pedido atribuído a um entregador, QUANDO ele está a caminho, ENTÃO o cliente visualiza a posição do entregador no mapa em tempo real (atualização a cada 10 segundos).

### FR-07 — Avaliação de restaurante e entregador
DADO um pedido entregue, QUANDO o cliente avalia com nota de 1 a 5 estrelas e comentário, ENTÃO a avaliação é registrada e impacta a média pública do restaurante e entregador.

## 4. Requisitos Não-Funcionais
- Mapa em tempo real com WebSocket. API < 500ms p95. Integração de pagamento segura (PCI-DSS). Disponibilidade 99,5%. LGPD: dados de localização do cliente nunca em logs. Cálculo de taxa de entrega por distância (API de geolocalização).

## 5. Regras de Negócio
- Taxa de entrega calculada por distância linear (ex.: R$ 2,00 + R$ 0,50/km acima de 3km).
- Restaurante só recebe pedidos quando status é "aberto" e dentro do horário de funcionamento.
- Entregador pode recusar pedido; sistema busca próximo disponível.
- Avaliação abaixo de 3 estrelas exige comentário obrigatório.

## 6. Modelo de Dados
- restaurants(id, name, category, address, lat, lng, rating, open_status, delivery_fee_base)
- menu_items(id, restaurant_id, name, description, price, available)
- orders(id, customer_id, restaurant_id, delivery_address, subtotal, delivery_fee, total, payment_method, status, created_at)
- order_items(id, order_id, menu_item_id, quantity, extras, notes, subtotal)
- deliveries(id, order_id, driver_id, pickup_at, delivered_at, status)
- ratings(id, order_id, target_type, target_id, score, comment)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Mapbox ou Google Maps API. Backend: Fastify + PostgreSQL. Tempo real: WebSocket (Socket.io) para status e localização. Pagamento: integração com gateway (Stripe, Mercado Pago). Geolocalização: Haversine para cálculo de distância.
