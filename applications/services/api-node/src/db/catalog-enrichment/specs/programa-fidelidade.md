# Programa de Fidelidade

## 0. Metadados
- **Produto:** LoyaltyHub — plataforma de fidelização com pontos e recompensas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de programa de fidelidade que permite empresas recompensarem clientes com pontos por compras, e clientes resgatarem recompensas de catálogo, incentivando recorrência.

## 2. Personas
- Gestor de marketing — configura regras de pontos e catálogo de recompensas.
- Cliente membro — acumula pontos e resgata recompensas.
- Atendente — valida resgates presenciais.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de membro e autenticação
DADO um novo cliente com CPF válido, QUANDO se cadastra no programa de fidelidade, ENTÃO uma conta é criada com saldo zero de pontos no nível Bronze e ele recebe credenciais de acesso.

### FR-02 — Acúmulo de pontos por compra
DADO um membro, QUANDO finaliza compra em loja integrada, ENTÃO pontos são creditados automaticamente conforme regra configurada (ex: 1 ponto por R$ 10 gastos) e o saldo é atualizado.

### FR-03 — Níveis de fidelidade progressivos
DADO um membro, QUANDO atinge pontuação acumulada de 1000 pontos, ENTÃO é promovido ao nível Prata com benefícios adicionais (multiplicador 1.5x em acúmulo), e notificado da promoção.

### FR-04 — Catálogo de recompensas
DADO um gestor de marketing, QUANDO cadastra recompensa no catálogo com foto, descrição e custo em pontos, ENTÃO a recompensa fica disponível para resgate por membros com saldo suficiente.

### FR-05 — Resgate de recompensas
DADO um membro com saldo suficiente, QUANDO solicita resgate de recompensa, ENTÃO os pontos são debitados, um voucher é gerado com código único e prazo de validade, e o membro recebe confirmação por e-mail.

### FR-06 — Validação de voucher pelo atendente
DADO um atendente em loja física, QUANDO valida código de voucher via aplicativo, ENTÃO o voucher é marcado como utilizado se válido e não expirado, ou rejeitado com mensagem de erro caso contrário.

### FR-07 — Extrato de pontos e histórico de resgates
DADO um membro autenticado, QUANDO acessa extrato, ENTÃO visualiza histórico de acúmulos e resgates com datas, descrições e saldo atual.

## 4. Requisitos Não-Funcionais
- Acúmulo de pontos processado em menos de 500ms p95.
- Disponibilidade de 99,5% para operações de resgate.
- PII (CPF, telefone) nunca em logs; LGPD com consentimento explícito.
- Catálogo de recompensas com cache para imagens (CDN).

## 5. Regras de Negócio
- Pontos expiram após 12 meses sem movimentação na conta.
- Resgate só é permitido se saldo de pontos for suficiente no momento da solicitação.
- Promoção de nível é irreversível (não há rebaixamento).
- Voucher não pode ser validado após expiração ou se já foi utilizado.

## 6. Modelo de Dados
- members(id, cpf, name, email, points_balance, tier, last_activity)
- point_transactions(id, member_id, type, amount, description, created_at)
- rewards(id, name, description, cost_points, image_url, active)
- redemptions(id, member_id, reward_id, voucher_code, status, expires_at, redeemed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal do membro; React Native para app de atendente.
- Backend: Fastify + PostgreSQL para transações de pontos.
- Jobs: cron para expiração de pontos e vouchers.
- CDN: S3 + CloudFront para imagens de recompensas.
