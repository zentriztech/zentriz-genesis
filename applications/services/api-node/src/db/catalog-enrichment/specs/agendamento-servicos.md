# Agendamento de Serviços

## 0. Metadados
- **Produto:** BookIt — plataforma de agendamento online para prestadores de serviços e clientes
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema web e mobile para prestadores de serviços (médicos, barbeiros, personal trainers, salões) configurarem agenda e serviços oferecidos, clientes agendarem horários disponíveis com prevenção de conflito, e ambos receberem lembretes automáticos, reduzindo no-show e otimizando ocupação da agenda.

## 2. Personas
- Prestador de serviço — cadastra serviços com duração e valor, configura horários de atendimento, visualiza agenda e confirma agendamentos.
- Cliente final — busca prestadores, visualiza horários disponíveis, agenda serviço e recebe lembrete.
- Recepcionista — agenda serviços em nome de clientes que ligam, gerencia cancelamentos e remarcações.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de usuário
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (cliente, prestador ou recepcionista).

### FR-02 — Cadastro de prestadores e serviços oferecidos
DADO um prestador autenticado, QUANDO cadastra um serviço informando nome, descrição, duração em minutos e valor, ENTÃO o sistema registra o serviço ativo e permite vinculá-lo à agenda; prestador pode cadastrar múltiplos serviços (ex: corte, barba, hidratação).

### FR-03 — Configuração de agenda e horários de atendimento
DADO um prestador, QUANDO configura sua agenda informando dias da semana, horário de início e término, e intervalo de almoço, ENTÃO o sistema gera slots de horário disponíveis respeitando a duração de cada serviço e bloqueios de horários já agendados ou feriados.

### FR-04 — Agendamento pelo cliente com prevenção de conflito
DADO um cliente autenticado buscando um prestador, QUANDO seleciona um serviço e um horário disponível, ENTÃO o sistema valida que não há conflito (outro agendamento no mesmo horário), reserva o slot com status "confirmado", envia e-mail de confirmação ao cliente e notificação ao prestador.

### FR-05 — Lembrete automático ao cliente e prestador
DADO agendamentos confirmados, QUANDO o sistema executa job de lembretes a cada hora, ENTÃO identifica agendamentos nas próximas 24 horas, envia e-mail e SMS ao cliente com dados do serviço e prestador, e notifica o prestador da lista de atendimentos do dia seguinte.

### FR-06 — Cancelamento e remarcação de agendamento
DADO um agendamento confirmado, QUANDO o cliente ou prestador solicita cancelamento com antecedência mínima de 2 horas, ENTÃO o sistema libera o horário, atualiza status para "cancelado", registra o motivo e notifica a outra parte; remarcação cria novo agendamento e cancela o anterior.

## 4. Requisitos Não-Funcionais
- Busca de horários disponíveis retorna resultado em < 200ms; cache de agenda por 5 minutos.
- Sistema tolera até 10 agendamentos simultâneos do mesmo prestador (recepcionistas) sem conflito de slot.
- Disponibilidade 99,5%; lembretes enviados com tolerância de até 10 minutos do horário programado.
- Dados de contato de clientes visíveis apenas para o prestador do agendamento e recepcionistas do mesmo estabelecimento.

## 5. Regras de Negócio
- Um prestador não pode ter dois agendamentos sobrepostos; sistema bloqueia slots ocupados em tempo real.
- Cancelamento com menos de 2 horas de antecedência é permitido mas marcado como "falta" do cliente; 3 faltas bloqueiam novos agendamentos por 30 dias.
- Cliente pode agendar até 3 serviços futuros simultaneamente; acima disso exige confirmação manual do prestador.
- Prestador pode marcar bloqueios de agenda (férias, feriados, compromissos) que impedem novos agendamentos nos horários bloqueados.

## 6. Modelo de Dados
- users(id, email, name, phone, role, status)
- providers(id, user_id, business_name, address, category)
- services(id, provider_id, name, description, duration_minutes, price, status)
- provider_schedule(id, provider_id, day_of_week, start_time, end_time, lunch_break_start, lunch_break_end)
- bookings(id, service_id, client_user_id, provider_id, booking_date, start_time, end_time, status, notes, created_at, canceled_at)
- schedule_blocks(id, provider_id, block_start, block_end, reason)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + FullCalendar.js (visualização de agenda). Backend: Fastify + PostgreSQL + Bull (jobs de lembrete). Notificações: integração com provedor de SMS (Twilio, Zenvia). Auth JWT.
