# Eventos e Networking

## 0. Metadados
- **Produto:** NetEvent — plataforma de eventos corporativos com networking
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para organização de eventos corporativos com inscrição online, agenda personalizada, credenciamento digital e ferramentas de networking entre participantes, potencializando conexões profissionais.

## 2. Personas
- Organizador de evento — cria evento, gerencia sessões e credenciamento.
- Participante — inscreve-se, monta agenda e conecta-se com outros participantes.
- Palestrante — gerencia sua sessão e interage com participantes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de evento e sessões
DADO um organizador autenticado, QUANDO cria evento informando data, local e descrição e adiciona sessões com título, palestrante e horário, ENTÃO o evento é publicado e fica disponível para inscrições.

### FR-02 — Inscrição e pagamento de ingresso
DADO um usuário, QUANDO visualiza evento público e seleciona tipo de ingresso (gratuito ou pago), ENTÃO preenche dados pessoais, efetua pagamento via gateway e recebe confirmação com QR code de credenciamento.

### FR-03 — Credenciamento digital
DADO um participante inscrito, QUANDO apresenta QR code no dia do evento, ENTÃO o organizador valida via app, marca presença e libera acesso ao recinto.

### FR-04 — Agenda pessoal do participante
DADO um participante credenciado, QUANDO navega grade de programação, ENTÃO pode adicionar sessões à sua agenda pessoal e recebe lembrete 10 minutos antes de cada uma.

### FR-05 — Perfil público e busca de participantes
DADO um participante, QUANDO preenche perfil com foto, bio e interesses, ENTÃO seu perfil fica disponível para busca de outros participantes por cargo, empresa ou interesse.

### FR-06 — Solicitação de conexão entre participantes
DADO um participante, QUANDO visualiza perfil de outro participante, ENTÃO pode enviar solicitação de conexão com mensagem personalizada, e o destinatário pode aceitar ou recusar.

### FR-07 — Mensagens entre participantes conectados
DADO dois participantes conectados, QUANDO um envia mensagem, ENTÃO o outro recebe notificação em tempo real e pode responder via chat do evento.

## 4. Requisitos Não-Funcionais
- Grade de programação carrega em menos de 500ms p95.
- Disponibilidade de 99,5% durante período de inscrições.
- Chat em tempo real com latência inferior a 200ms.
- PII de participantes (CPF, telefone) nunca em logs; LGPD com consentimento explícito para networking.

## 5. Regras de Negócio
- Inscrição só é confirmada após pagamento aprovado (para ingressos pagos).
- Participante só pode adicionar à agenda sessões do evento em que está inscrito.
- Credenciamento só é válido no dia do evento e uma única vez por participante.
- Mensagens só podem ser enviadas entre participantes que aceitaram conexão mutuamente.

## 6. Modelo de Dados
- events(id, name, description, date, location, status)
- sessions(id, event_id, title, speaker, start_time, end_time, room)
- attendees(id, event_id, user_id, ticket_type, payment_status, checked_in_at)
- user_profiles(id, name, photo_url, bio, company, position, interests)
- connections(id, requester_id, recipient_id, status, created_at)
- messages(id, connection_id, sender_id, content, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal organizador/participante; React Native para app de credenciamento.
- Backend: Fastify + PostgreSQL para dados relacionais; WebSocket (Socket.io) para chat em tempo real.
- Integração: Stripe para pagamento de ingressos; Twilio para notificações SMS.
- Storage: S3 para fotos de perfil e materiais do evento.
