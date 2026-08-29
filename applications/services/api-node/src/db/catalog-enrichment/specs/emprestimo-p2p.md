# Plataforma de Empréstimos P2P

## 0. Metadados
- **Produto:** LendMatch — marketplace de empréstimos peer-to-peer com análise de crédito
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conectar tomadores que precisam de crédito com investidores que oferecem capital, realizando análise de risco, montagem de lastro e repasse automatizado de parcelas. Reduz spread bancário e oferece rentabilidade acima da poupança.

## 2. Personas
- Tomador — solicita empréstimo, informa renda e recebe proposta baseada em score.
- Investidor — escolhe perfil de risco, aloca capital em múltiplos empréstimos e recebe juros mensais.
- Analista de crédito — aprova ou recusa solicitações com base em score e documentação.

## 3. Requisitos Funcionais (FR)

### FR-01 — Solicitação de empréstimo com análise de crédito
DADO um tomador autenticado, QUANDO solicita empréstimo informando valor, prazo e documentos, ENTÃO o sistema calcula score de crédito e retorna taxa de juros sugerida.

### FR-02 — Aprovação e publicação de proposta
DADO uma solicitação com score acima do mínimo, QUANDO o analista aprova, ENTÃO a proposta é publicada no marketplace com prazo para captação de lastro.

### FR-03 — Oferta de investidores e montagem de lastro
DADO uma proposta publicada, QUANDO investidores alocam valores parciais, ENTÃO o sistema registra participação de cada um até completar 100% do valor solicitado.

### FR-04 — Geração de contrato e liberação de recursos
DADO lastro completo dentro do prazo, QUANDO o tomador aceita, ENTÃO contrato digital é gerado, recursos são transferidos ao tomador e cronograma de parcelas é criado.

### FR-05 — Cobrança de parcelas e repasse aos investidores
DADO uma parcela com vencimento hoje, QUANDO o worker de cobrança processa, ENTÃO debita o tomador, calcula juros proporcionais de cada investidor e credita suas contas.

### FR-06 — Inadimplência e cobrança
DADO uma parcela vencida há mais de 15 dias, QUANDO o tomador não paga, ENTÃO o sistema marca como inadimplente, notifica investidores e aciona cobrança externa.

### FR-07 — Dashboard de carteira do investidor
DADO um investidor autenticado, QUANDO acessa o dashboard, ENTÃO visualiza empréstimos ativos, parcelas recebidas, saldo disponível e rentabilidade acumulada.

## 4. Requisitos Não-Funcionais
- Transações financeiras em ledger dupla-entrada append-only.
- Cálculo de juros com precisão de 4 casas decimais.
- Dados de CPF/RG armazenados criptografados (LGPD).
- Disponibilidade de 99,9% em horário comercial.

## 5. Regras de Negócio
- Score mínimo de 600 para aprovação de empréstimo.
- Taxa de juros varia de 1,5% a 4% ao mês conforme score.
- Investidor pode alocar no mínimo R$ 100 por empréstimo.
- Repasse aos investidores em D+1 após recebimento da parcela.
- Inadimplência acima de 60 dias aciona baixa contábil e cobrança judicial.

## 6. Modelo de Dados
- borrowers(id, name, cpf, score, monthly_income)
- investors(id, name, cpf, balance, risk_profile)
- loans(id, borrower_id, amount, rate, term, status)
- loan_participations(id, loan_id, investor_id, invested_amount, share_pct)
- installments(id, loan_id, due_date, amount, status, paid_at)
- ledger_entries(id, account_id, type, amount, timestamp)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7.
- Backend: Fastify + PostgreSQL com transações ACID.
- Worker: Bull para cobrança diária e repasse.
- Integração bancária: API Pix e boleto.
