# Programa de Afiliados

## 0. Metadados
- **Produto:** AffiliateHub — gestão de afiliados, rastreio de conversões e pagamento de comissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que afiliados gerem links únicos de indicação, rastreiem cliques e conversões, e recebam comissões automaticamente por vendas geradas.

## 2. Personas
- Afiliado — cadastra-se, gera links, acompanha conversões e solicita saque.
- Gestor de marketing — define regras de comissão, aprova afiliados e analisa performance.
- Comprador — clica em link de afiliado e finaliza compra.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de afiliados e aprovação
DADO um visitante que deseja ser afiliado, QUANDO preenche formulário e envia, ENTÃO o cadastro fica pendente até aprovação do gestor.

### FR-02 — Geração de links únicos de indicação
DADO um afiliado aprovado, QUANDO acessa dashboard, ENTÃO pode gerar link único por produto ou campanha com código de rastreio exclusivo.

### FR-03 — Rastreio de clique e conversão
DADO um comprador que clica em link de afiliado, QUANDO finaliza compra em até 30 dias, ENTÃO a conversão é registrada e vinculada ao afiliado.

### FR-04 — Cálculo de comissão por regra
DADO uma conversão de R$ 1.000 em produto com regra de 10% de comissão, QUANDO a venda é confirmada, ENTÃO o afiliado acumula R$ 100 em saldo disponível.

### FR-05 — Painel de performance do afiliado
DADO um afiliado autenticado, QUANDO acessa dashboard, ENTÃO vê cliques, conversões, comissões acumuladas e taxa de conversão.

### FR-06 — Solicitação de repasse
DADO um afiliado com saldo de R$ 500, QUANDO solicita saque com PIX, ENTÃO o repasse é processado em até 5 dias úteis e ele recebe comprovante.

### FR-07 — Relatório de afiliados e ROI
DADO um gestor de marketing, QUANDO exporta relatório, ENTÃO vê todos os afiliados com total de vendas geradas, comissões pagas e ROI da campanha.

## 4. Requisitos Não-Funcionais
- Rastreio de clique com latência < 200ms. Atribuição de conversão em até 30 dias. Disponibilidade 99,5%. PII (CPF, chave PIX) cifrados em repouso. Repasse via integração bancária.

## 5. Regras de Negócio
- Um clique cria cookie de atribuição válido por 30 dias. Conversão só gera comissão após confirmação de pagamento. Saldo mínimo de R$ 100 para saque. Comissão varia por produto/campanha. Afiliado bloqueado perde saldo pendente.

## 6. Modelo de Dados
- affiliates(id, email, name, status, approved_at, pix_key)
- affiliate_links(id, affiliate_id, product_id, code, created_at)
- clicks(id, link_id, ip, user_agent, clicked_at, cookie_token)
- conversions(id, link_id, order_id, order_value, commission_rate, commission_amount, converted_at)
- payouts(id, affiliate_id, amount, status, requested_at, paid_at, receipt_url)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para dashboard de afiliado. Backend: Fastify + PostgreSQL. Rastreio: Redis para cache de atribuição. Pagamento: integração Stripe Connect ou API bancária para repasse.
