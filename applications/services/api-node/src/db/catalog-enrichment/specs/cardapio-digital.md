# Cardápio Digital por QR Code

## 0. Metadados
- **Produto:** MenuQR — cardápio digital para restaurantes e bares
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que clientes acessem o cardápio via QR Code na mesa, façam pedidos com adicionais e paguem sem filas, reduzindo tempo de atendimento e custos operacionais.

## 2. Personas
- Cliente — escaneia QR, escolhe pratos e envia pedido à cozinha.
- Garçom — acompanha pedidos por mesa e fecha a conta.
- Gerente — cadastra itens do cardápio e categorias.

## 3. Requisitos Funcionais (FR)

### FR-01 — Acesso ao cardápio por QR Code
DADO um cliente na mesa, QUANDO escaneia o QR Code único da mesa, ENTÃO carrega o cardápio do restaurante com fotos e preços atualizados.

### FR-02 — Montagem do pedido com adicionais
DADO um cliente visualizando um prato, QUANDO adiciona itens ao carrinho e escolhe adicionais (ex.: queijo extra, molho especial), ENTÃO o sistema calcula o total com as personalizações.

### FR-03 — Envio do pedido à cozinha
DADO um cliente com itens no carrinho, QUANDO confirma o pedido, ENTÃO ele é enviado em tempo real à cozinha com o número da mesa e o garçom recebe notificação.

### FR-04 — Acompanhamento do status do pedido
DADO um pedido confirmado, QUANDO a cozinha atualiza o status (em preparo, pronto, entregue), ENTÃO o cliente visualiza o progresso em tempo real na tela.

### FR-05 — Fechamento de conta por mesa
DADO um garçom autenticado, QUANDO fecha a conta da mesa, ENTÃO o sistema soma todos os pedidos da mesa e marca a mesa como disponível.

### FR-06 — Gestão de cardápio
DADO um gerente autenticado, QUANDO cadastra ou edita um prato com nome, descrição, preço, categoria e foto, ENTÃO ele fica visível para os clientes imediatamente.

## 4. Requisitos Não-Funcionais
- Interface responsiva para smartphones. API < 500ms p95. Disponibilidade 99%. Imagens otimizadas (WebP, max 200KB). Conexão segura (HTTPS) e dados de pagamento fora do escopo inicial.

## 5. Regras de Negócio
- Cada mesa tem QR único; pedidos vinculados à mesa até o fechamento.
- Item fora de estoque não pode ser adicionado ao carrinho.
- Mesa só pode ser reaberta após fechamento completo da conta anterior.

## 6. Modelo de Dados
- tables(id, number, qr_code, status)
- menu_items(id, name, description, price, category, image_url, available)
- menu_item_extras(id, menu_item_id, name, price)
- orders(id, table_id, status, created_at)
- order_items(id, order_id, menu_item_id, quantity, extras_json, subtotal)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI (mobile-first). Backend: Fastify + PostgreSQL. Tempo real: WebSocket ou Server-Sent Events para status de pedido.
