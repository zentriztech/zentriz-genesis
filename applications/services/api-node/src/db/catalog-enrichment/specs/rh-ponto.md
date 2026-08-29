# Controle de Ponto Eletrônico

## 0. Metadados
- **Produto:** ClockIn — sistema de registro de ponto e apuração de jornada para RH
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Registrar entradas e saídas de colaboradores, calcular banco de horas com base em escala configurada, apurar horas extras e faltas, e gerar espelho de ponto exportável para folha de pagamento.

## 2. Personas
- Colaborador — registra ponto e consulta seu saldo de horas.
- Gestor de RH — configura escalas, aprova ajustes e exporta espelho de ponto.
- Auditor — consulta histórico imutável de marcações para conformidade com legislação trabalhista.

## 3. Requisitos Funcionais (FR)

### FR-01 — Marcação de ponto por colaborador
DADO um colaborador autenticado, QUANDO clica em "Registrar ponto", ENTÃO o sistema registra timestamp, IP e geolocalização (se habilitada), e exibe a marcação confirmada.

### FR-02 — Configuração de escalas e jornada
DADO um gestor de RH, QUANDO cadastra uma escala com dias da semana, horário de entrada/saída e intervalo, ENTÃO a escala é associada a colaboradores e usada como base para cálculo de desvios.

### FR-03 — Apuração de horas extras e faltas
DADO um colaborador com escala de 8h/dia (seg-sex), QUANDO o sistema apura o mês fechado, ENTÃO calcula horas extras (acima de 8h/dia), faltas (ausência sem marcação) e saldo de banco de horas.

### FR-04 — Ajuste manual de marcação
DADO um colaborador que esqueceu de marcar ponto, QUANDO o gestor de RH cadastra um ajuste com justificativa, ENTÃO a marcação é inserida com flag "ajuste manual" e aguarda aprovação de segundo nível.

### FR-05 — Espelho de ponto exportável
DADO um gestor de RH, QUANDO solicita espelho de ponto de um colaborador para um período, ENTÃO o sistema gera PDF com todas as marcações, ajustes, totalizadores (horas trabalhadas, extras, faltas) e assinatura digital.

## 4. Requisitos Não-Funcionais
- Marcação de ponto com latência < 300ms. Disponibilidade 99,9%. Histórico de marcações imutável (append-only log). Dados de geolocalização retidos por 1 ano (LGPD). Espelho de ponto assinado digitalmente (conformidade NR-1).

## 5. Regras de Negócio
- Marcação duplicada em intervalo < 1 minuto é rejeitada. Ajuste manual exige aprovação de gestor diferente do solicitante. Banco de horas acumula até 100h; excedente converte em pagamento. Falta não justificada desconta dia de trabalho.

## 6. Modelo de Dados
- employees(id, matricula, nome, departamento, escala_id, saldo_horas, status)
- schedules(id, nome, dias_semana, entrada, saida, intervalo_min)
- punches(id, employee_id, timestamp, tipo, ip, lat, lng, ajuste, aprovado_por)
- apuracao_mensal(id, employee_id, mes_ref, horas_trabalhadas, horas_extras, faltas, saldo_final)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para painel web. Backend: Fastify + PostgreSQL com trigger de append-only em punches. Geração de PDF: Puppeteer. Assinatura digital: ICP-Brasil ou equivalente.
