# Finanças Pessoais

## 0. Metadados
- **Produto:** MyFinance — controle de receitas, despesas e metas orçamentárias pessoais
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que pessoas físicas registrem receitas e despesas, categorizem transações e acompanhem metas orçamentárias mensais com relatórios visuais. Aumentar consciência financeira e reduzir gastos não planejados.

## 2. Personas
- Usuário final — registra lançamentos diários e consulta saldo.
- Gestor doméstico — define metas por categoria e analisa relatórios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard.

### FR-02 — Registro de transação
DADO um usuário autenticado, QUANDO lança receita ou despesa com valor, data e categoria, ENTÃO a transação é persistida e o saldo da conta é atualizado.

### FR-03 — Categorias customizáveis
DADO um usuário, QUANDO cria categoria personalizada, ENTÃO ela fica disponível para classificação de transações futuras.

### FR-04 — Contas múltiplas
DADO um usuário com múltiplas contas bancárias, QUANDO registra transação, ENTÃO informa a conta de origem e o saldo dessa conta reflete a operação.

### FR-05 — Metas orçamentárias
DADO um usuário, QUANDO define limite mensal por categoria, ENTÃO o sistema alerta ao atingir 80% e bloqueia novos lançamentos ao estourar.

### FR-06 — Relatório mensal
DADO um usuário, QUANDO acessa relatórios, ENTÃO visualiza gráfico de pizza por categoria e evolução de saldo ao longo do mês.

## 4. Requisitos Não-Funcionais
- API < 300ms p95; disponibilidade 99%. PII (CPF, saldo) criptografado em repouso e nunca exposto em logs.

## 5. Regras de Negócio
- Saldo negativo permitido; transação não pode ter valor zero.
- Meta não retroage — só vale para mês corrente.
- Exclusão de transação recalcula saldo da conta.

## 6. Modelo de Dados
- accounts(id, user_id, name, balance)
- categories(id, user_id, name, type)
- transactions(id, account_id, category_id, amount, description, date, type)
- budgets(id, user_id, category_id, month_year, limit_amount, spent_amount)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Chart.js. Backend: Fastify + PostgreSQL com trigger de atualização de saldo.
