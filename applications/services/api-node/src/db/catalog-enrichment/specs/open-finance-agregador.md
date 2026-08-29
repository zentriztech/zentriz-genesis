# Agregador Open Finance

## 0. Metadados
- **Produto:** FinanceHub — agregador de contas bancárias via Open Finance para visão consolidada
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Consolidar saldos, transações e investimentos de múltiplas instituições financeiras em uma única interface, permitindo que usuários gerenciem suas finanças de forma centralizada e obtenham insights sobre gastos por categoria.

## 2. Personas
- Usuário final — conecta suas contas bancárias e visualiza saldo consolidado e histórico de transações.
- Analista financeiro — categoriza lançamentos automaticamente e gera relatórios de gastos por período.

## 3. Requisitos Funcionais (FR)

### FR-01 — Consentimento e conexão de contas via Open Finance
DADO um usuário autenticado, QUANDO inicia fluxo de consentimento com uma instituição financeira, ENTÃO é redirecionado para autorização OAuth2 e, ao aprovar, recebe token de acesso armazenado com validade e escopo.

### FR-02 — Sincronização periódica de saldos e transações
DADO uma conta conectada com consentimento válido, QUANDO o worker de sincronização executa, ENTÃO busca saldos atualizados e novas transações via API Open Finance e persiste com timestamp de sync.

### FR-03 — Categorização automática de lançamentos
DADO uma nova transação sincronizada, QUANDO o sistema analisa descrição e merchant, ENTÃO aplica regra de categorização (alimentação, transporte, saúde, etc.) e marca confiança (alta/média/baixa).

### FR-04 — Visão consolidada por conta e categoria
DADO um usuário autenticado, QUANDO acessa dashboard financeiro, ENTÃO visualiza saldo total consolidado, lista de contas conectadas com saldo individual e gráfico de gastos por categoria no período selecionado.

### FR-05 — Renovação de consentimento expirado
DADO uma conexão com consentimento próximo ao vencimento (30 dias), QUANDO o sistema detecta, ENTÃO envia alerta ao usuário via e-mail e oferece renovação com um clique.

### FR-06 — Histórico de transações com busca e filtro
DADO um usuário no histórico, QUANDO busca por palavra-chave ou filtra por categoria e período, ENTÃO visualiza lista paginada de transações correspondentes com data, valor, merchant e categoria.

## 4. Requisitos Não-Funcionais
- API com p95 < 600ms; disponibilidade 99,9% (dados financeiros críticos).
- Dados sensíveis (saldos, CPF, tokens OAuth) criptografados em repouso (AES-256) e em trânsito (TLS 1.3).
- LGPD: PII e dados financeiros nunca em logs; consentimento explícito e revogável a qualquer momento.
- Worker de sincronização com retry exponencial e circuit breaker para falhas de API externa.

## 5. Regras de Negócio
- Consentimento com validade máxima de 12 meses; renovação obrigatória.
- Transação não categorizada automaticamente pode ser recategorizada manualmente pelo usuário.
- Saldo consolidado exclui contas desconectadas ou com sync falho há mais de 7 dias.

## 6. Modelo de Dados
- connections(id, user_id, institution_name, consent_token_encrypted, consent_expires_at, status, last_sync_at)
- accounts(id, connection_id, account_number_hash, account_type, balance, currency, updated_at)
- transactions(id, account_id, transaction_id_external, date, amount, description, merchant, category_id, confidence, created_at)
- categories(id, name, icon, parent_category_id)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL com Drizzle ORM para API REST e persistência.
- Worker: Node.js com Bull (Redis) para sincronização agendada e retry.
- Segurança: crypto nativo Node.js para criptografia de tokens; rate limiting e IP whitelist para API Open Finance.
