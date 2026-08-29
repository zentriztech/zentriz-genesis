# Sistema de Gestão para Salão de Beleza

## 0. Metadados
- **Produto:** BeautyBook — plataforma de agendamento e gestão financeira para salões de beleza com controle de comissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar agendamento de serviços de beleza, gestão de profissionais e cálculo de comissões, reduzindo conflitos de horário e erros financeiros.

## 2. Personas
- Administrador do salão — cadastra profissionais, serviços e acompanha faturamento.
- Profissional — visualiza sua agenda, confirma atendimentos e acompanha comissões.
- Cliente — agenda serviços online e mantém histórico de atendimentos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o sistema conforme perfil (admin, profissional ou cliente).

### FR-02 — Cadastro de profissionais e serviços
DADO um administrador autenticado, QUANDO cadastra profissional com nome, especialidades e percentual de comissão, ENTÃO o profissional fica disponível para agendamentos nos serviços que domina.

### FR-03 — Agenda com duração e prevenção de conflito
DADO um cliente autenticado, QUANDO seleciona serviço, profissional e horário disponível, ENTÃO o sistema bloqueia o slot pela duração do serviço (30, 60, 90 minutos) e impede reservas sobrepostas.

### FR-04 — Confirmação de atendimento e cálculo de comissão
DADO um agendamento realizado, QUANDO o profissional marca como concluído e informa valor cobrado, ENTÃO o sistema calcula comissão do profissional (percentual sobre valor) e registra no relatório financeiro.

### FR-05 — Ficha e histórico do cliente
DADO um cliente com atendimentos anteriores, QUANDO o profissional acessa ficha dele, ENTÃO visualiza histórico de serviços, preferências e observações registradas.

### FR-06 — Controle financeiro e relatórios
DADO agendamentos concluídos no período, QUANDO o administrador acessa relatório financeiro, ENTÃO visualiza faturamento total, comissões por profissional e serviços mais rentáveis.

## 4. Requisitos Não-Funcionais
- API de agendamento com resposta < 500ms p95; locks transacionais para prevenção de double-booking.
- Interface responsiva para mobile (clientes) e desktop (profissionais/admin); disponibilidade 99,5%.
- Dados de contato do cliente (e-mail, telefone) protegidos; histórico de serviços acessível apenas pelo profissional que atendeu ou admin.
- Notificações por SMS ou WhatsApp para confirmação de agendamento 24h antes.

## 5. Regras de Negócio
- Agendamento só pode ser confirmado por cliente cadastrado; não-clientes podem consultar horários disponíveis mas não agendar.
- Cancelamento com menos de 3 horas de antecedência gera penalidade (cliente fica bloqueado para novos agendamentos por 7 dias).
- Comissão é calculada apenas sobre serviços marcados como concluídos; agendamentos cancelados não geram comissão.
- Profissional não pode ter dois agendamentos simultâneos; sistema valida sobreposição de horários antes de confirmar reserva.

## 6. Modelo de Dados
- professionals(id, name, phone, commission_rate, status)
- services(id, name, description, duration_minutes, base_price)
- professional_services(professional_id, service_id)
- customers(id, name, email, phone, registered_at)
- bookings(id, customer_id, professional_id, service_id, booking_date, start_time, end_time, status, amount_charged, completed_at)
- commissions(id, booking_id, professional_id, commission_amount, paid_at)
- customer_notes(id, customer_id, professional_id, note, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para calendário e gestão; PWA para acesso mobile de clientes.
- Backend: Fastify + PostgreSQL com locks transacionais para agendamento; Redis para cache de horários disponíveis.
- Notificações: integração com Twilio para SMS ou API oficial do WhatsApp Business para lembretes de agendamento.
