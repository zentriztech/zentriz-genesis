# Reserva de Coworking

## 0. Metadados
- **Produto:** CoworkHub — plataforma de reserva de espaços de coworking com planos flexíveis e controle de acesso
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de gestão de coworking que permite reserva avulsa ou por plano de salas privativas, estações compartilhadas e salas de reunião. Integra com catraca de controle de acesso, calcula faturamento por uso e gera relatórios de ocupação.

## 2. Personas
- Coworker avulso — reserva sala de reunião ou estação por hora via app, faz check-in presencial.
- Coworker plano mensal — acessa espaço livremente dentro de cota de horas do plano, visualiza saldo de créditos.
- Administrador do espaço — cadastra salas e capacidades, configura preços e planos, monitora ocupação em tempo real.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de espaços e capacidade
DADO um administrador autenticado, QUANDO cadastra novo espaço informando tipo (sala privativa, estação, sala de reunião), capacidade e recursos (TV, projetor, quadro), ENTÃO o espaço é publicado no catálogo de reservas com status "disponível".

### FR-02 — Reserva avulsa por hora
DADO um coworker não assinante, QUANDO seleciona espaço, data e horário (mínimo 1 hora), ENTÃO o sistema verifica disponibilidade, calcula preço pela tabela de tarifas e cria reserva com status "pendente de pagamento".

### FR-03 — Planos de acesso mensal
DADO um coworker, QUANDO contrata plano mensal (exemplo: 40 horas/mês de estação compartilhada), ENTÃO o sistema cria assinatura recorrente, concede crédito de horas do mês vigente e libera acesso ao espaço sem reserva prévia.

### FR-04 — Check-in e controle de acesso
DADO um coworker com reserva confirmada ou plano ativo, QUANDO faz check-in via QR code na catraca ou app, ENTÃO o sistema valida reserva/saldo de horas, registra entrada com timestamp e libera acesso físico via integração com catraca.

### FR-05 — Consumo de créditos de plano
DADO um coworker plano mensal que fez check-in, QUANDO faz check-out, ENTÃO o sistema calcula tempo de permanência, debita horas do saldo do plano e, se ultrapassar cota, gera cobrança avulsa de horas extras.

### FR-06 — Faturamento consolidado
DADO um coworker com reservas avulsas e/ou horas extras de plano, QUANDO chega a data de fechamento de ciclo, ENTÃO o sistema gera fatura consolidada (plano + horas extras + reservas avulsas) e envia por e-mail com link de pagamento.

### FR-07 — Painel de ocupação em tempo real
DADO um administrador visualizando dashboard, QUANDO acessa visão de ocupação, ENTÃO visualiza mapa de calor dos espaços (livre, ocupado, reservado), taxa de ocupação do dia e forecast de reservas da semana.

## 4. Requisitos Não-Funcionais
- Sistema suporta até 200 check-ins simultâneos em horário de pico (8h-9h).
- Disponibilidade de 99,7% para subsistema de controle de acesso (crítico para entrada no espaço).
- Integração com catraca responde em menos de 500ms para não bloquear acesso físico.
- PII de coworkers (CPF, dados de pagamento) armazenada cifrada (AES-256).

## 5. Regras de Negócio
- Reserva só pode ser cancelada até 2 horas antes do horário, senão cobra 50% do valor.
- Créditos de horas de plano mensal não acumulam para o próximo ciclo (use ou perca).
- Coworker plano só pode trazer convidado se tiver crédito de horas suficiente para 2 pessoas.
- Espaço ocupado fisicamente sem reserva gera alerta e cobrança retroativa por hora (penalidade).

## 6. Modelo de Dados
- spaces(id, name, type, capacity, resources, hourly_rate, status)
- plans(id, name, monthly_fee, included_hours, space_type)
- subscriptions(id, user_id, plan_id, status, current_cycle_hours_remaining, next_billing_date)
- bookings(id, user_id, space_id, start_time, end_time, status, amount)
- checkins(id, user_id, space_id, checked_in_at, checked_out_at, hours_consumed)
- invoices(id, user_id, cycle_start, cycle_end, total_amount, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal web; React Native para app mobile de check-in.
- Backend: Fastify + PostgreSQL; Redis para cache de disponibilidade em tempo real; RabbitMQ para processamento assíncrono de faturas.
- Integração: API REST de catraca de controle de acesso (protocolo proprietário); gateway de pagamento para cobranças recorrentes.
