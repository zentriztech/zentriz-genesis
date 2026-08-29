# Cartões Corporativos

## 0. Metadados
- **Produto:** CorpCard — gestão de cartões corporativos, limites e prestação de contas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Controlar emissão de cartões virtuais, limites por centro de custo, rastreamento de transações e prestação de contas com anexo de comprovantes.

## 2. Personas
- Gestor financeiro — emite cartões, define limites e aprova despesas.
- Colaborador — usa cartão virtual, anexa comprovantes e consulta saldo.
- Contador — extrai relatórios de despesas por centro de custo.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um colaborador cadastrado, QUANDO faz login com credenciais válidas, ENTÃO acessa dashboard com seus cartões e transações.

### FR-02 — Emissão de cartões virtuais por colaborador
DADO um gestor financeiro, QUANDO solicita emissão de cartão para colaborador com limite de R$ 2.000, ENTÃO o cartão virtual é criado e o colaborador recebe os dados por e-mail.

### FR-03 — Limites e políticas de gasto por centro de custo
DADO um cartão vinculado ao centro de custo Marketing, QUANDO a soma das transações atinge o limite mensal, ENTÃO novas compras são bloqueadas até aprovação de aumento.

### FR-04 — Registro de transações e anexo de comprovante
DADO um colaborador que usou o cartão, QUANDO a transação aparece no sistema, ENTÃO ele anexa foto do comprovante e categoriza a despesa.

### FR-05 — Aprovação de despesas
DADO um gestor financeiro, QUANDO revisa despesas pendentes, ENTÃO aprova ou rejeita com comentário, e a despesa muda de status.

### FR-06 — Relatório de despesas por centro de custo
DADO um contador, QUANDO exporta relatório do mês, ENTÃO recebe CSV com todas as transações aprovadas agrupadas por centro de custo.

### FR-07 — Bloqueio e cancelamento de cartão
DADO um gestor financeiro, QUANDO bloqueia um cartão, ENTÃO novas transações são rejeitadas e o colaborador é notificado.

## 4. Requisitos Não-Funcionais
- API de transações com latência < 300ms p95. Disponibilidade 99,9%. Comprovantes armazenados com retenção de 7 anos. PII (CPF, dados bancários) cifrados em repouso.

## 5. Regras de Negócio
- Um colaborador pode ter múltiplos cartões. Limite de cartão não pode exceder limite do centro de custo. Transação sem comprovante anexado em 7 dias gera alerta ao gestor. Cancelamento de cartão não remove histórico.

## 6. Modelo de Dados
- users(id, email, password_hash, role)
- cost_centers(id, name, monthly_limit)
- cards(id, user_id, cost_center_id, card_limit, status, card_number_encrypted)
- transactions(id, card_id, amount, merchant, transaction_date, status, receipt_url)
- approvals(id, transaction_id, approved_by, status, comment, approved_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Storage: S3 para comprovantes. Criptografia: AWS KMS para dados sensíveis.
