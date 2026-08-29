# E-commerce de Farmácia com Delivery

## 0. Metadados
- **Produto:** FarmaExpress — venda online de medicamentos com validação de receita e entrega controlada
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir compra online de medicamentos com controle de receita médica obrigatória, integração com sistemas de entrega e histórico de compras para facilitar recompra. Garante conformidade com legislação sanitária e agiliza acesso a medicamentos.

## 2. Personas
- Cliente — busca medicamentos, faz pedido e acompanha entrega.
- Farmacêutico — valida receitas enviadas e aprova dispensação de controlados.
- Operador logístico — coleta pedidos, empacota e entrega no endereço do cliente.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo com classificação de receita
DADO um visitante, QUANDO navega o catálogo, ENTÃO visualiza medicamentos separados em "venda livre", "receita simples" e "receita controlada", com indicação clara da exigência.

### FR-02 — Upload e validação de receita
DADO um cliente autenticado com item de receita no carrinho, QUANDO faz upload de foto ou PDF da receita, ENTÃO o sistema extrai dados (CRM, data, medicamentos) e encaminha ao farmacêutico para validação.

### FR-03 — Aprovação pelo farmacêutico
DADO uma receita pendente, QUANDO o farmacêutico revisa, ENTÃO pode aprovar (liberando o pedido), solicitar nova foto ou recusar com justificativa.

### FR-04 — Carrinho e finalização de pedido
DADO um cliente com carrinho válido e receitas aprovadas (se aplicável), QUANDO informa endereço de entrega e forma de pagamento, ENTÃO o pedido é criado com status "aguardando separação".

### FR-05 — Rastreamento de entrega
DADO um pedido com status "em rota", QUANDO o cliente acessa o rastreamento, ENTÃO visualiza localização em tempo real do entregador e previsão de chegada.

### FR-06 — Histórico de compras e recompra rápida
DADO um cliente autenticado, QUANDO acessa o histórico, ENTÃO visualiza pedidos anteriores e pode adicionar itens recorrentes ao carrinho com um clique.

### FR-07 — Notificação de status do pedido
DADO um pedido criado, QUANDO muda de status (separado, saiu para entrega, entregue), ENTÃO o cliente recebe notificação por e-mail e SMS.

## 4. Requisitos Não-Funcionais
- Receitas armazenadas criptografadas por 5 anos (exigência Anvisa).
- Dados pessoais e de saúde (PII) nunca em logs nem cache.
- Disponibilidade de 99,5% em horário comercial.
- Integração com APIs de entrega (iFood, Loggi) com fallback manual.

## 5. Regras de Negócio
- Medicamentos controlados só liberam após aprovação de farmacêutico habilitado.
- Receita simples válida por 30 dias, controlada por 30 dias (B1/B2) ou 60 dias (C1/C2).
- Cliente menor de 18 anos não pode comprar medicamentos de receita controlada.
- Prazo de entrega padrão: 2h para capital, 24h para interior.

## 6. Modelo de Dados
- products(id, name, category, requires_prescription, controlled_substance, price)
- prescriptions(id, customer_id, image_url, crm, issue_date, status, reviewed_by, reviewed_at)
- prescription_items(id, prescription_id, product_id)
- orders(id, customer_id, delivery_address, payment_method, status, total)
- order_items(id, order_id, product_id, quantity, price)
- deliveries(id, order_id, driver_id, status, estimated_arrival, delivered_at)
- customers(id, email, cpf, phone, birth_date)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + mapa de rastreamento (Mapbox).
- Backend: Fastify + PostgreSQL + AWS S3 (receitas).
- Pagamentos: integração Stripe ou PagSeguro.
- Logística: integração iFood ou API própria de entregadores.
