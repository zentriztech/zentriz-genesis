# Carteira Digital

## 0. Metadados
- **Produto:** WalletPay — carteira digital com transferências P2P e ledger auditável
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Sistema de carteira digital que permite depósitos, transferências instantâneas entre usuários e consulta de extrato, com ledger de dupla entrada e trilha de auditoria completa.

## 2. Personas
- Usuário titular — realiza depósitos, transferências e consulta saldo.
- Auditor interno — revisa lançamentos para conformidade contábil.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de conta e autenticação
DADO um novo usuário com CPF válido, QUANDO se cadastra com e-mail e senha, ENTÃO uma conta é criada com saldo zero e ele recebe token de acesso.

### FR-02 — Depósito via boleto ou PIX
DADO um usuário autenticado, QUANDO gera um boleto ou chave PIX, ENTÃO após confirmação de pagamento via webhook o saldo é creditado e dois lançamentos são registrados no ledger (débito conta-origem, crédito conta-usuário).

### FR-03 — Transferência entre usuários com idempotência
DADO um usuário com saldo suficiente, QUANDO solicita transferência para outro usuário informando idempotency-key única, ENTÃO o saldo é debitado da origem e creditado no destino em transação atômica, e chamadas duplicadas com mesma key retornam o resultado original.

### FR-04 — Consulta de extrato paginado
DADO um usuário autenticado, QUANDO solicita extrato com filtros de data, ENTÃO recebe lista paginada de lançamentos (débitos e créditos) ordenados por data decrescente.

### FR-05 — Ledger de dupla entrada e auditoria
DADO qualquer operação financeira (depósito, transferência, estorno), QUANDO é executada, ENTÃO são criados dois lançamentos no ledger (débito e crédito) com hash criptográfico vinculando-os à operação original, garantindo rastreabilidade.

### FR-06 — Bloqueio de conta por suspeita de fraude
DADO um usuário, QUANDO o sistema detecta padrão de transações suspeitas, ENTÃO a conta é bloqueada automaticamente e novas transferências são rejeitadas até análise manual.

## 4. Requisitos Não-Funcionais
- Transferências executadas em menos de 300ms p95.
- Disponibilidade de 99,9% para operações críticas.
- PII (CPF, dados bancários) restrito a serviço de identidade, nunca em logs.
- LGPD: dados pessoais anonimizados após 5 anos de inatividade.
- Ledger imutável com auditoria por hash criptográfico.

## 5. Regras de Negócio
- Saldo nunca negativo; transferência é rejeitada se saldo insuficiente.
- Transferências são atômicas: ou ambos os lançamentos são persistidos ou nenhum.
- Idempotência garantida por 24 horas para evitar duplicação em retry de cliente.
- Cada lançamento no ledger possui exatamente uma contraparte (débito ↔ crédito).

## 6. Modelo de Dados
- accounts(id, user_id, balance, status, created_at)
- ledger_entries(id, account_id, operation_id, type, amount, balance_after, hash, created_at)
- transfers(id, from_account_id, to_account_id, amount, idempotency_key, status, created_at)
- operations(id, type, idempotency_key, status, metadata, created_at)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL com transações ACID e row-level locking.
- Cache: Redis para idempotency-keys (TTL 24h).
- Integração: webhook handlers para confirmação de pagamento (boleto/PIX).
