# Oficina Mecânica

## 0. Metadados
- **Produto:** AutoService — sistema de gestão para oficinas mecânicas com ordens de serviço, orçamentos e histórico de veículos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar o fluxo de atendimento de oficinas mecânicas, desde a entrada do veículo até a entrega, com controle de orçamentos, aprovação pelo cliente e histórico completo de manutenções.

## 2. Personas
- Recepcionista — cadastra cliente, veículo e abre ordem de serviço.
- Mecânico — registra diagnóstico, peças e mão de obra necessárias.
- Cliente — recebe orçamento, aprova serviços e consulta histórico do veículo.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema com permissões do seu perfil (recepcionista, mecânico ou cliente).

### FR-02 — Cadastro de clientes e veículos
DADO um recepcionista, QUANDO cadastra cliente informando CPF ou CNPJ e dados de contato, ENTÃO pode vincular um ou mais veículos com placa, modelo, ano e chassi.

### FR-03 — Abertura de ordem de serviço
DADO um veículo cadastrado, QUANDO o recepcionista cria uma ordem de serviço informando quilometragem e problema relatado, ENTÃO a OS recebe número único e status "aguardando diagnóstico".

### FR-04 — Diagnóstico e composição de orçamento
DADO um mecânico responsável pela OS, QUANDO registra diagnóstico e adiciona peças (código, quantidade, preço) e serviços de mão de obra (descrição, horas, valor/hora), ENTÃO o sistema calcula total do orçamento e envia para aprovação do cliente.

### FR-05 — Aprovação de orçamento pelo cliente
DADO um orçamento enviado, QUANDO o cliente visualiza via link ou portal e aprova, ENTÃO a OS muda para status "em execução" e o mecânico pode iniciar o serviço.

### FR-06 — Execução e conclusão do serviço
DADO uma OS aprovada, QUANDO o mecânico finaliza os serviços e atualiza status para "concluída", ENTÃO o sistema registra data de conclusão e libera a OS para faturamento.

### FR-07 — Histórico de serviços por veículo
DADO um cliente ou recepcionista, QUANDO consulta um veículo pela placa, ENTÃO visualiza todas as ordens de serviço anteriores com data, serviços realizados, peças trocadas e quilometragem.

## 4. Requisitos Não-Funcionais
- API deve responder consultas de histórico em menos de 400ms (p95).
- Sistema suporta 30 oficinas simultâneas em modelo multi-tenant.
- Orçamento em PDF gerado automaticamente e enviado por e-mail ou WhatsApp.
- Dados de pagamento (cartão, PIX) protegidos conforme PCI-DSS; LGPD aplicada a CPF e dados pessoais.

## 5. Regras de Negócio
- Placa de veículo é única por tenant; não pode haver duplicatas na mesma oficina.
- OS só pode avançar para execução após aprovação explícita do cliente.
- Peças com estoque insuficiente geram alerta ao recepcionista no momento da composição do orçamento.
- Cliente pode reprovar orçamento; OS retorna para status "orçamento reprovado" e aguarda nova proposta.

## 6. Modelo de Dados
- customers(id, name, cpf_cnpj, email, phone)
- vehicles(id, customer_id, license_plate, brand, model, year, chassis)
- work_orders(id, vehicle_id, opened_by, opened_at, mileage, reported_issue, status, approved_at, completed_at)
- work_order_parts(id, work_order_id, part_code, description, quantity, unit_price)
- work_order_labor(id, work_order_id, service_description, hours, hourly_rate)
- service_history(id, vehicle_id, work_order_id, service_date, total_amount)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para interface responsiva com painel de ordens de serviço e portal do cliente.
- Backend: Fastify + PostgreSQL com geração de PDF de orçamento via html-pdf-node.
- Notificações: Amazon SES para e-mails e integração com API do WhatsApp para envio de orçamentos.
