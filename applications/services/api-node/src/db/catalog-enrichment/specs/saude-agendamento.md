# Agendamento de Consultas

## 0. Metadados
- **Produto:** MediSchedule — plataforma de agendamento médico online
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de agendamento de consultas que conecta pacientes e profissionais de saúde, permitindo reserva de horários, cancelamento e lembretes automáticos, reduzindo faltas e otimizando a agenda.

## 2. Personas
- Profissional de saúde — configura agenda e disponibilidade.
- Paciente — busca especialistas, agenda e cancela consultas.
- Secretária de clínica — gerencia agenda de múltiplos profissionais.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de profissionais e especialidades
DADO um profissional de saúde com CRM válido, QUANDO se cadastra informando especialidade e horários de atendimento, ENTÃO seu perfil é criado e fica disponível para busca de pacientes.

### FR-02 — Busca de profissionais por especialidade e localização
DADO um paciente, QUANDO busca profissionais filtrando por especialidade e cidade, ENTÃO recebe lista ordenada por avaliação com foto, nome e horários disponíveis.

### FR-03 — Visualização de agenda com horários disponíveis
DADO um paciente visualizando perfil de profissional, QUANDO consulta agenda, ENTÃO vê slots de 30 minutos disponíveis para os próximos 30 dias, excluindo horários já reservados ou bloqueados.

### FR-04 — Agendamento de consulta com bloqueio de conflito
DADO um paciente autenticado, QUANDO seleciona horário disponível e confirma, ENTÃO a consulta é registrada e o slot é bloqueado atomicamente para evitar dupla reserva, e o paciente recebe confirmação por e-mail.

### FR-05 — Cancelamento de consulta pelo paciente
DADO um paciente com consulta agendada, QUANDO solicita cancelamento com pelo menos 24 horas de antecedência, ENTÃO a consulta é cancelada, o slot é liberado e ambos recebem notificação.

### FR-06 — Lembrete automático antes da consulta
DADO uma consulta agendada, QUANDO faltam 24 horas para o horário, ENTÃO o sistema envia lembrete por e-mail e SMS ao paciente com dados da consulta e link para cancelamento.

### FR-07 — Bloqueio de horários pelo profissional
DADO um profissional, QUANDO bloqueia período de férias ou indisponibilidade, ENTÃO os slots desse período ficam ocultos para novos agendamentos e consultas já marcadas são mantidas.

## 4. Requisitos Não-Funcionais
- Busca de profissionais retorna resultados em menos de 400ms p95.
- Disponibilidade de 99,5% para agendamentos.
- PII de pacientes (CPF, telefone, histórico) nunca em logs; armazenamento criptografado conforme LGPD.
- Lembretes enviados com pelo menos 99% de taxa de entrega.

## 5. Regras de Negócio
- Slot só pode ser reservado se disponível no momento da confirmação (check atômico).
- Cancelamento com menos de 24h de antecedência notifica o profissional mas não libera o slot.
- Paciente não pode ter mais de 3 consultas ativas simultaneamente para evitar abuso.
- Profissional pode configurar duração de consulta (30, 45 ou 60 minutos).

## 6. Modelo de Dados
- professionals(id, name, crm, specialty, city, rating, photo_url)
- availability_rules(id, professional_id, day_of_week, start_time, end_time)
- time_slots(id, professional_id, date, start_time, end_time, status)
- appointments(id, professional_id, patient_id, slot_id, status, created_at)
- patients(id, name, cpf, email, phone)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal paciente/profissional.
- Backend: Fastify + PostgreSQL com row-level locking para agendamentos concorrentes.
- Jobs: cron para geração de slots e envio de lembretes.
- Integração: Twilio para SMS e serviço de e-mail transacional.
