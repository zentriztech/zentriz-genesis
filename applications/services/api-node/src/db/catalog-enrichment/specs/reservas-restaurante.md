# Reservas de Restaurante

## 0. Metadados
- **Produto:** TableBook — sistema de reservas de mesas com controle de capacidade e notificações automáticas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar reservas de mesas respeitando capacidade, horários disponíveis e regras de overbooking, com confirmação automática, lembretes via email/SMS e painel administrativo para o restaurante.

## 2. Personas
- Gerente do restaurante — configura mesas, horários e política de cancelamento.
- Cliente — realiza reserva online, recebe confirmação e pode cancelar até prazo-limite.
- Atendente — consulta reservas do dia e confirma chegada de clientes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa painel conforme perfil (gerente, atendente ou cliente).

### FR-02 — Configuração de mesas e horários
DADO um gerente autenticado, QUANDO cadastra mesas com capacidade e define horários de funcionamento (ex.: jantar 18h-23h, slots de 30min), ENTÃO o sistema gera grade de disponibilidade.

### FR-03 — Reserva pelo cliente com confirmação
DADO um cliente, QUANDO seleciona data, horário e número de pessoas disponível, ENTÃO o sistema reserva mesa provisória e envia email de confirmação com código.

### FR-04 — Controle de capacidade e overbooking
DADO um horário com todas as mesas ocupadas, QUANDO gerente habilita overbooking (10%), ENTÃO o sistema permite 1 reserva extra em horário cheio, sinalizando como "sob confirmação".

### FR-05 — Lembrete automático
DADO uma reserva confirmada, QUANDO faltam 24h para o horário, ENTÃO o sistema envia email/SMS de lembrete ao cliente.

### FR-06 — Cancelamento pelo cliente
DADO um cliente com reserva ativa, QUANDO cancela até 2h antes do horário, ENTÃO mesa é liberada e cliente recebe confirmação de cancelamento.

### FR-07 — Painel de chegadas do dia
DADO um atendente, QUANDO acessa painel de chegadas, ENTÃO vê lista de reservas do dia ordenadas por horário, com status (confirmada, check-in, no-show).

## 4. Requisitos Não-Funcionais
- API responde em < 300ms p95; disponibilidade 99,5%. Grade de horários atualizada em tempo real. Dados pessoais (telefone, email) nunca em logs. Notificações entregues em < 5min após gatilho.

## 5. Regras de Negócio
- Reserva sem check-in em 15min após horário marca como no-show. Cliente com 3 no-shows consecutivos bloqueado por 30 dias. Cancelamento após prazo-limite não libera mesa. Overbooking limitado a 10% da capacidade por horário.

## 6. Modelo de Dados
- tables(id, restaurant_id, number, capacity)
- time_slots(id, restaurant_id, day_of_week, start_time, end_time, slot_duration)
- reservations(id, table_id, customer_id, reservation_date, slot_time, party_size, status, created_at)
- customers(id, name, email, phone, no_show_count)
- restaurants(id, name, overbooking_enabled, overbooking_limit_pct, cancellation_deadline_hours)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + date-picker. Backend: Fastify + PostgreSQL. Notificações: integração com Twilio (SMS) e SendGrid (email). Job scheduler: node-cron para lembretes.
