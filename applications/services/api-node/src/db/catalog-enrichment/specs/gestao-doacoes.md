# Gestão de Doações ONG

## 0. Metadados
- **Produto:** DonorHub — plataforma de gestão de doadores, campanhas e prestação de contas para ONGs
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar a captação de recursos para ONGs por meio de campanhas organizadas, doações únicas ou recorrentes, emissão automática de recibos e prestação de contas transparente por projeto, fortalecendo a confiança dos doadores.

## 2. Personas
- Doador — cadastra-se, escolhe campanha, faz doação única ou recorrente e recebe recibo.
- Gestor de ONG — cria campanhas, acompanha arrecadação em tempo real e publica prestação de contas.
- Contador da ONG — exporta relatórios de doações por período para contabilidade fiscal.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de doadores e campanhas
DADO um gestor autenticado, QUANDO cria uma campanha com título, meta financeira, prazo e descrição, ENTÃO a campanha fica ativa e visível no portal público com barra de progresso.

### FR-02 — Doação única e recorrente
DADO um doador no portal, QUANDO escolhe campanha e valor, ENTÃO pode optar por doação única ou recorrente (mensal) via cartão ou PIX, e recebe confirmação por e-mail.

### FR-03 — Emissão de recibo e comprovante de doação
DADO uma doação confirmada, QUANDO o pagamento é processado, ENTÃO o sistema gera recibo em PDF com dados da ONG, doador, valor e finalidade, enviando por e-mail e disponibilizando para download.

### FR-04 — Prestação de contas por campanha
DADO uma campanha encerrada ou em andamento, QUANDO o gestor publica prestação de contas, ENTÃO anexa comprovantes de despesas (fotos/PDFs), descreve aplicação dos recursos e notifica doadores por e-mail.

### FR-05 — Dashboard de arrecadação
DADO um gestor autenticado, QUANDO acessa dashboard, ENTÃO visualiza total arrecadado por campanha, quantidade de doadores ativos, ticket médio e gráfico de doações por mês.

### FR-06 — Renovação automática de doação recorrente
DADO um doador com doação recorrente ativa, QUANDO chega a data de cobrança mensal, ENTÃO o sistema processa cobrança no cartão cadastrado, envia confirmação e atualiza total da campanha.

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; disponibilidade 99,5%. Portal público responsivo para acesso mobile.
- LGPD: CPF de doador restrito ao recibo e relatórios internos, nunca exposto publicamente.
- Dados de cartão nunca persistidos (tokenização via gateway de pagamento).
- Worker de cobrança recorrente com retry e notificação de falha ao doador.

## 5. Regras de Negócio
- Campanha só pode ser excluída se não houver doações associadas (senão apenas arquivada).
- Doação recorrente cancelável a qualquer momento pelo doador; últimas 3 cobranças ficam visíveis no histórico.
- Recibo válido fiscalmente deve conter CNPJ da ONG, data, valor e finalidade da doação.

## 6. Modelo de Dados
- donors(id, name, cpf_hash, email, phone, created_at)
- campaigns(id, title, description, goal_amount, deadline, status, total_raised)
- donations(id, donor_id, campaign_id, amount, type, status, payment_method, receipt_url, created_at)
- recurring_donations(id, donor_id, campaign_id, amount, card_token, status, next_charge_date)
- accountability_reports(id, campaign_id, description, expenses_json, attachments_urls, published_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal público e painel administrativo.
- Backend: Fastify + PostgreSQL para API de campanhas, doações e recibos.
- Worker: Node.js com Bull (Redis) para cobrança recorrente e envio de e-mails.
- Integração: gateway de pagamento (Stripe/PagSeguro) para cartão e PIX; geração de PDF via Puppeteer.
