# Helpdesk de Tickets

## 0. Metadados
- **Produto:** SupportHub — plataforma de atendimento e resolução de chamados com controle de SLA
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar e agilizar o atendimento de suporte técnico com filas organizadas, histórico completo e monitoramento de SLA, reduzindo tempo de resolução e aumentando a satisfação do cliente.

## 2. Personas
- Atendente — visualiza tickets da sua fila, responde chamados e muda status.
- Cliente — abre tickets, acompanha status e avalia o atendimento.
- Gestor de suporte — monitora SLA, distribui filas e analisa indicadores.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard do seu perfil (cliente, atendente ou gestor).

### FR-02 — Abertura de ticket pelo cliente
DADO um cliente autenticado, QUANDO preenche título, descrição, categoria e prioridade, ENTÃO o ticket é criado com status "novo" e número de protocolo único.

### FR-03 — Atribuição de tickets a filas e atendentes
DADO um ticket novo, QUANDO um gestor atribui a uma fila, ENTÃO atendentes daquela fila visualizam o ticket e podem assumir o atendimento.

### FR-04 — Histórico de mensagens no ticket
DADO um ticket em atendimento, QUANDO o atendente ou cliente envia uma mensagem, ENTÃO ela é registrada com timestamp e autor, visível para ambas as partes.

### FR-05 — Controle de SLA e alertas
DADO um ticket com prioridade e SLA definidos, QUANDO o prazo está próximo de expirar (80%), ENTÃO o gestor e o atendente responsável recebem alerta visual e por e-mail.

### FR-06 — Resolução e avaliação de ticket
DADO um ticket resolvido pelo atendente, QUANDO o cliente confirma a resolução, ENTÃO o ticket é fechado e o cliente pode avaliar o atendimento com nota de 1 a 5.

### FR-07 — Indicadores de desempenho
DADO um gestor autenticado, QUANDO acessa o dashboard de indicadores, ENTÃO visualiza tempo médio de primeira resposta, tempo médio de resolução, tickets dentro e fora do SLA e avaliação média do período.

## 4. Requisitos Não-Funcionais
- API deve responder em menos de 500ms (p95) sob carga de 100 tickets simultâneos.
- Disponibilidade de 99,5% em horário comercial.
- PII (e-mail, telefone do cliente) nunca em logs; dados anonimizados em relatórios.
- Notificações por e-mail devem ser enviadas em até 2 minutos após o evento.

## 5. Regras de Negócio
- Ticket sem categoria é automaticamente classificado como "Geral".
- SLA começa a contar a partir da abertura do ticket e pausa quando aguarda resposta do cliente.
- Atendente só pode assumir tickets da sua fila; gestor pode reatribuir tickets entre filas.
- Cliente não pode reabrir ticket fechado há mais de 30 dias.

## 6. Modelo de Dados
- users(id, email, name, role)
- tickets(id, protocol, subject, category, priority, status, sla_deadline, created_at, assigned_to, customer_id)
- ticket_messages(id, ticket_id, author_id, message, created_at)
- queues(id, name, department)
- queue_assignments(queue_id, agent_id)
- ticket_ratings(id, ticket_id, rating, comment)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI para dashboard responsivo e notificações em tempo real.
- Backend: Fastify + PostgreSQL para API REST com suporte a filtros avançados e agregações de SLA.
- Notificações: Amazon SES para e-mails e WebSocket para alertas em tempo real.
