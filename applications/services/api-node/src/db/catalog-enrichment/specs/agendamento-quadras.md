# Agendamento de Quadras Esportivas

## 0. Metadados
- **Produto:** CourtBook — sistema de reserva de quadras esportivas com pagamento online
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar o aluguel de quadras esportivas com reserva por horário, pagamento automatizado e gestão de mensalistas, reduzindo conflitos e inadimplência.

## 2. Personas
- Administrador do clube — cadastra quadras, define valores e acompanha ocupação.
- Cliente — reserva horários e efetua pagamento online.
- Mensalista — cliente com plano recorrente e acesso prioritário.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token e acessa o dashboard conforme seu perfil (admin ou cliente).

### FR-02 — Cadastro de quadras e grade horária
DADO um administrador autenticado, QUANDO cadastra uma quadra com tipo (futebol, tênis, vôlei) e grade de horários de 1 hora, ENTÃO a quadra fica disponível para reservas.

### FR-03 — Reserva avulsa com prevenção de conflito
DADO um cliente autenticado, QUANDO seleciona quadra e horário disponível, ENTÃO o sistema bloqueia o slot por 10 minutos para pagamento e impede reservas simultâneas.

### FR-04 — Pagamento online
DADO uma reserva bloqueada, QUANDO o cliente confirma pagamento via Pix ou cartão, ENTÃO a reserva é confirmada e o cliente recebe QR code de acesso.

### FR-05 — Reserva recorrente para mensalistas
DADO um cliente mensalista ativo, QUANDO solicita reserva do mesmo horário por 4 semanas, ENTÃO o sistema reserva automaticamente todos os slots sem nova cobrança.

### FR-06 — Política de cancelamento
DADO uma reserva confirmada, QUANDO o cliente cancela com antecedência mínima de 3 horas, ENTÃO recebe reembolso integral; caso contrário, o valor é retido.

## 4. Requisitos Não-Funcionais
- API de reserva com resposta < 500ms p95; reserva simultânea sem race condition (locks transacionais).
- Gateway de pagamento com suporte a Pix e cartão; webhook de confirmação em até 30 segundos.
- Aplicativo mobile responsivo (PWA); disponibilidade 99,5%.
- Dados de pagamento (PAN) nunca armazenados; apenas token do gateway.

## 5. Regras de Negócio
- Reserva expira em 10 minutos se pagamento não for confirmado; slot retorna ao disponível.
- Mensalista tem prioridade na reserva de horários fixos; clientes avulsos veem apenas horários livres.
- Cancelamento fora do prazo (menos de 3h) retém 100% do valor como penalidade.
- Quadra não pode ter reservas sobrepostas; sistema usa lock pessimista na transação de reserva.

## 6. Modelo de Dados
- courts(id, name, court_type, hourly_rate, status)
- time_slots(id, court_id, day_of_week, start_time, end_time)
- customers(id, name, email, phone, is_monthly_member)
- bookings(id, customer_id, court_id, slot_date, start_time, end_time, status, payment_status, payment_id, created_at)
- payments(id, booking_id, amount, method, confirmed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para calendário e seleção de horários; PWA com suporte offline.
- Backend: Fastify + PostgreSQL com locks transacionais; integração com gateway de pagamento (Stripe ou Asaas).
- Notificações: e-mail via SES e SMS via Twilio para confirmações e lembretes.
