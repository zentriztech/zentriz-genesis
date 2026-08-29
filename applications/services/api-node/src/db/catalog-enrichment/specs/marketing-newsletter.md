# Newsletter e Campanhas

## 0. Metadados
- **Produto:** MailFlow — gerenciamento de listas, editor de campanhas e envio em massa com métricas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Criar e gerenciar listas de contatos com opt-in, compor campanhas de e-mail com editor visual, agendar envios em massa e acompanhar métricas de abertura e clique. Aumentar engajamento com segmentação.

## 2. Personas
- Profissional de marketing — cria campanhas e analisa resultados.
- Assinante — recebe e-mails segmentados e gerencia preferências.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de lista e opt-in
DADO um visitante, QUANDO confirma assinatura via e-mail, ENTÃO é adicionado à lista com status ativo e timestamp de confirmação.

### FR-02 — Segmentação
DADO um usuário com múltiplas listas, QUANDO cria campanha, ENTÃO seleciona lista ou segmento por tag e data de inscrição.

### FR-03 — Editor de campanha
DADO um usuário autenticado, QUANDO compõe e-mail com editor visual, ENTÃO salva HTML renderizado e permite preview em desktop e mobile.

### FR-04 — Agendamento e envio
DADO uma campanha pronta, QUANDO agenda para data futura, ENTÃO o worker envia em massa respeitando throttling de 500 e-mails/minuto.

### FR-05 — Rastreamento de abertura
DADO um e-mail entregue, QUANDO o assinante abre, ENTÃO registra evento de abertura com timestamp e user-agent.

### FR-06 — Rastreamento de clique
DADO um link em campanha, QUANDO o assinante clica, ENTÃO redireciona e registra evento de clique associado ao link.

### FR-07 — Descadastramento
DADO um assinante, QUANDO clica em "cancelar inscrição", ENTÃO remove da lista e não recebe mais campanhas futuras.

## 4. Requisitos Não-Funcionais
- Envio de 100k e-mails em até 4h; taxa de entrega >95%. PII (e-mail) restrito e não compartilhado. API de envio com retry e DLQ para falhas.

## 5. Regras de Negócio
- Campanha só enviada para contatos com opt-in confirmado; link de descadastramento obrigatório em todo e-mail.
- Abertura detectada por pixel 1x1; clique por redirecionamento via servidor.
- Assinante que cancela pode reinscrever-se a qualquer momento.

## 6. Modelo de Dados
- lists(id, name, description)
- subscribers(id, list_id, email, status, confirmed_at)
- campaigns(id, list_id, subject, html_body, scheduled_at, sent_at, status)
- events(id, campaign_id, subscriber_id, event_type, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + editor de e-mail (react-email-editor). Backend: Fastify + PostgreSQL + RabbitMQ. Worker: Node.js com Nodemailer ou API de envio (SES, SendGrid).
