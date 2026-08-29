# Reservas de Hotel

## 0. Metadados
- **Produto:** HotelBook — sistema de reservas de hotel com motor de disponibilidade e gestão de tarifas dinâmicas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de gestão hoteleira que controla disponibilidade de quartos em tempo real, aplica tarifas dinâmicas por período e canal de venda, processa reservas com check-in/check-out e integra com sistemas de pagamento e PMS legados.

## 2. Personas
- Hóspede — busca disponibilidade por datas, reserva quarto online, realiza check-in antecipado via web.
- Recepcionista — visualiza mapa de ocupação, faz check-in/check-out presencial, altera reservas.
- Gerente de receita — configura tarifas dinâmicas por período, monitora taxa de ocupação e RevPAR.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de quartos e tipos
DADO um gerente autenticado, QUANDO cadastra quarto informando número, tipo (standard, superior, suíte), capacidade e comodidades (ar-condicionado, vista mar), ENTÃO o quarto é adicionado ao inventário com status "disponível para reserva".

### FR-02 — Motor de disponibilidade por período
DADO um hóspede buscando reserva, QUANDO informa datas de check-in e check-out, ENTÃO o sistema consulta disponibilidade de quartos livres em TODOS os dias do período e retorna apenas tipos com unidades disponíveis ininterruptamente.

### FR-03 — Tarifas dinâmicas por período e canal
DADO um gerente configurando tarifário, QUANDO define tarifa base, regras de desconto (antecedência, grupo) e markup por canal (site próprio, OTA), ENTÃO o sistema aplica cálculo dinâmico no momento da busca e exibe preço final ao hóspede.

### FR-04 — Reserva com pagamento online
DADO um hóspede selecionando quarto e datas, QUANDO preenche dados pessoais e efetua pagamento via gateway, ENTÃO o sistema bloqueia o quarto no período, cria reserva com status "confirmada" e envia voucher por e-mail.

### FR-05 — Check-in antecipado e atribuição de quarto
DADO uma reserva confirmada, QUANDO o hóspede faz check-in online 24 horas antes ou na recepção, ENTÃO o sistema atribui número de quarto específico (se não atribuído), muda status para "hospedado" e gera chave de acesso (física ou digital).

### FR-06 — Check-out e faturamento final
DADO um hóspede hospedado, QUANDO recepcionista processa check-out informando consumo de frigobar e extras, ENTÃO o sistema calcula total (diárias + extras), gera nota fiscal, processa pagamento pendente e libera o quarto com status "sujo" para governança.

### FR-07 — Política de cancelamento configurável
DADO uma reserva confirmada, QUANDO hóspede solicita cancelamento, ENTÃO o sistema avalia política (prazo de cancelamento gratuito, penalidade por atraso), calcula reembolso devido, processa estorno e libera o quarto para novas reservas.

## 4. Requisitos Não-Funcionais
- Motor de disponibilidade responde em menos de 500ms para consulta de período de até 30 dias.
- Disponibilidade de 99,9% para subsistema de reservas (crítico para vendas 24/7).
- Overbooking controlado: sistema permite até 5% de sobrevenda configurável para mitigar no-shows.
- PII de hóspedes (CPF, dados de cartão) armazenada cifrada (AES-256) e em conformidade com PCI-DSS.

## 5. Regras de Negócio
- Check-in padrão 14h, check-out 12h; early check-in ou late check-out sujeito a disponibilidade e cobrança extra.
- Cancelamento gratuito até 48 horas antes do check-in; após, cobra 1 diária de multa.
- Quarto "sujo" após check-out não entra em disponibilidade até que governança mude status para "limpo".
- No-show (não comparecer sem cancelar) resulta em cobrança integral da primeira diária.

## 6. Modelo de Dados
- rooms(id, room_number, room_type, capacity, amenities, status)
- room_types(id, name, base_rate, max_occupancy)
- rates(id, room_type_id, start_date, end_date, rate, channel)
- reservations(id, guest_id, room_id, check_in_date, check_out_date, status, total_amount, cancellation_policy)
- guests(id, name, email, document, phone)
- invoices(id, reservation_id, room_charges, extras, total, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para site de reservas público; painel interno para recepção.
- Backend: Fastify + PostgreSQL com bloqueio pessimista para evitar double-booking; Redis para cache de disponibilidade; RabbitMQ para processamento assíncrono de faturas.
- Integração: gateway de pagamento (Stripe/Adyen); API de PMS legado (SOAP/REST) para sincronização de reservas.
