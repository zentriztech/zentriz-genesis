# Gestão de Condomínio

## 0. Metadados
- **Produto:** CondoManager — sistema de gestão condominial com cobrança e reservas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para síndicos e moradores gerenciarem unidades, taxas condominiais, reservas de áreas comuns e comunicados, centralizando a administração do condomínio.

## 2. Personas
- Síndico — cadastra unidades, emite cobranças e aprova reservas.
- Morador — consulta taxas, reserva áreas comuns e lê comunicados.
- Zelador — gerencia manutenção de áreas comuns.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de unidades e moradores
DADO um síndico autenticado, QUANDO cadastra uma unidade com identificação única (bloco/número) e associa morador titular, ENTÃO a unidade é registrada e o morador recebe acesso ao portal.

### FR-02 — Cobrança de taxa condominial mensal
DADO o primeiro dia do mês, QUANDO o sistema executa job de geração de cobranças, ENTÃO uma cobrança é criada para cada unidade com valor base mais rateio de despesas, e boleto é gerado via API de pagamento.

### FR-03 — Consulta e pagamento de taxas pelo morador
DADO um morador autenticado, QUANDO acessa extrato de cobranças, ENTÃO visualiza taxas pendentes e pagas com boletos disponíveis para download, e pode pagar via PIX ou cartão.

### FR-04 — Reserva de áreas comuns
DADO um morador, QUANDO solicita reserva de área comum (salão, churrasqueira) para data/horário disponível, ENTÃO a reserva é registrada como "pendente" e o síndico recebe notificação para aprovar ou rejeitar.

### FR-05 — Aprovação e cancelamento de reservas
DADO um síndico, QUANDO visualiza reserva pendente, ENTÃO pode aprovar (bloqueando o horário) ou rejeitar com justificativa, e o morador recebe notificação da decisão.

### FR-06 — Comunicados e assembleias
DADO um síndico, QUANDO publica comunicado ou convoca assembleia, ENTÃO todos os moradores recebem notificação por e-mail e o aviso fica disponível no portal.

### FR-07 — Registro de manutenção de áreas comuns
DADO um zelador, QUANDO registra manutenção realizada em área comum, ENTÃO o registro é salvo com data, descrição e fotos, e o síndico recebe relatório mensal.

## 4. Requisitos Não-Funcionais
- Portal deve carregar em menos de 600ms p95.
- Disponibilidade de 99% para consultas e reservas.
- PII de moradores (CPF, telefone) nunca em logs.
- LGPD: consentimento para uso de dados pessoais em comunicados.

## 5. Regras de Negócio
- Unidade não pode ter cobrança duplicada para o mesmo mês.
- Área comum não pode ter reservas sobrepostas para o mesmo horário.
- Morador inadimplente há mais de 3 meses não pode reservar áreas comuns.
- Cancelamento de reserva pelo morador deve ser feito com pelo menos 48 horas de antecedência.

## 6. Modelo de Dados
- units(id, condo_id, block, number, owner_id, status)
- residents(id, name, cpf, email, phone, role)
- charges(id, unit_id, month, base_amount, extras, status, due_date)
- common_areas(id, condo_id, name, hourly_rate, max_hours)
- reservations(id, area_id, resident_id, date, start_time, end_time, status)
- notices(id, condo_id, title, content, published_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal síndico/morador.
- Backend: Fastify + PostgreSQL para transações.
- Jobs: cron para geração de cobranças mensais.
- Integração: API de pagamento (boleto/PIX) e envio de e-mails transacionais.
