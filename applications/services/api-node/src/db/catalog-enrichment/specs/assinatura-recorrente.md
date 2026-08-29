# Sistema de Assinaturas Recorrentes

## 0. Metadados
- **Produto:** SubsHub — plataforma de gestão de assinaturas recorrentes para SaaS
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar planos de assinatura, cobranças recorrentes e ciclo de vida de assinantes, reduzindo inadimplência e automatizando renovações. Permite upgrade, downgrade e suspensão de planos.

## 2. Personas
- Administrador — cadastra planos, define preços e acompanha receita recorrente.
- Assinante — contrata plano, atualiza cartão e consulta faturas.
- Sistema de cobrança — processa renovações automáticas e retenta falhas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard do seu perfil.

### FR-02 — Cadastro de planos
DADO um administrador autenticado, QUANDO cadastra um plano com nome, preço e ciclo (mensal/anual), ENTÃO o plano é persistido e fica disponível para contratação.

### FR-03 — Contratação de assinatura
DADO um assinante autenticado e um plano ativo, QUANDO seleciona o plano e informa dados de pagamento, ENTÃO a assinatura é criada com status "ativa" e a primeira cobrança é agendada.

### FR-04 — Upgrade e downgrade de plano
DADO uma assinatura ativa, QUANDO o assinante solicita mudança de plano, ENTÃO a alteração é registrada com efeito na próxima renovação e o valor é recalculado proporcionalmente.

### FR-05 — Cobrança recorrente automática
DADO uma assinatura com renovação prevista para hoje, QUANDO o worker de cobrança processa o lote, ENTÃO gera fatura, cobra o meio de pagamento e atualiza a data da próxima renovação.

### FR-06 — Retentativa em falha de cobrança
DADO uma cobrança que falhou, QUANDO passam 3 dias, ENTÃO o sistema tenta novamente até 3 vezes com intervalo de 3 dias, e se todas falharem, suspende a assinatura.

### FR-07 — Portal do assinante
DADO um assinante autenticado, QUANDO acessa o portal, ENTÃO visualiza histórico de faturas, status da assinatura, atualiza forma de pagamento e pode cancelar.

## 4. Requisitos Não-Funcionais
- API REST com tempo de resposta < 500ms p95.
- Disponibilidade de 99,5% no horário comercial.
- Dados de cartão armazenados via tokenização (PCI-DSS compliant).
- Worker de cobrança roda diariamente às 6h com retry em falha.

## 5. Regras de Negócio
- Assinatura cancelada pelo cliente entra em "cancelada" ao final do ciclo pago.
- Upgrade gera crédito proporcional do plano anterior na próxima fatura.
- Após 3 falhas de cobrança, a assinatura é suspensa e o acesso bloqueado.
- Histórico de faturas mantido por 5 anos para auditoria.

## 6. Modelo de Dados
- plans(id, name, price, cycle, active)
- subscriptions(id, user_id, plan_id, status, next_billing_date, payment_method_token)
- invoices(id, subscription_id, amount, due_date, status, attempts)
- users(id, email, password_hash, role)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7.
- Backend: Fastify + PostgreSQL + Bull (fila de jobs).
- Pagamentos: integração Stripe ou PagSeguro.
- Worker: Node.js com Bull e cron diário.
