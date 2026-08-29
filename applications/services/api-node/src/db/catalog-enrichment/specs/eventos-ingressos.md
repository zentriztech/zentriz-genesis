# Sistema de Venda e Validação de Ingressos

## 0. Metadados
- **Produto:** TicketGate — plataforma de venda de ingressos com check-in via QR Code
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Vender ingressos para eventos físicos por lotes com preços diferenciados e validar entrada via leitura de QR Code na portaria. Reduzir fraude, facilitar acesso de participantes e fornecer relatórios de vendas e presença em tempo real.

## 2. Personas
- Organizador de evento — cadastra eventos, define lotes de ingressos e acompanha vendas.
- Comprador — adquire ingressos, recebe QR Code por e-mail e apresenta na entrada.
- Porteiro — valida QR Code no app mobile e registra check-in no evento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de eventos
DADO um organizador autenticado, QUANDO cria evento com nome, data, local, capacidade máxima e descrição, ENTÃO o evento fica disponível para configuração de lotes de ingresso.

### FR-02 — Criação de lotes de ingressos
DADO um evento cadastrado, QUANDO o organizador cria lote com nome (ex: 1º lote, VIP), quantidade disponível, preço e data limite de venda, ENTÃO o lote fica disponível para compra enquanto houver estoque e estiver dentro do prazo.

### FR-03 — Compra de ingresso
DADO um comprador no site do evento com lote disponível, QUANDO preenche dados (nome, e-mail, CPF) e conclui pagamento simulado, ENTÃO recebe ingresso com QR Code único por e-mail e o estoque do lote é decrementado.

### FR-04 — Geração de QR Code
DADO um ingresso vendido, QUANDO o sistema gera o ingresso, ENTÃO cria QR Code contendo hash SHA-256(ticket_id + secret) não reversível e único por ingresso.

### FR-05 — Check-in na entrada
DADO um porteiro com app mobile, QUANDO escaneia QR Code de ingresso, ENTÃO o sistema valida o hash, verifica se o ingresso não foi usado e registra check-in com timestamp; tentativa de reutilização do mesmo QR Code retorna erro "já utilizado".

### FR-06 — Relatório de vendas
DADO um organizador, QUANDO acessa painel do evento, ENTÃO visualiza total de ingressos vendidos por lote, receita acumulada, taxa de ocupação (vendidos / capacidade) e gráfico de vendas ao longo do tempo.

### FR-07 — Relatório de presença
DADO um evento em andamento ou finalizado, QUANDO o organizador consulta presença, ENTÃO visualiza total de check-ins realizados, lista de participantes presentes com horário de entrada e taxa de comparecimento (check-ins / ingressos vendidos).

## 4. Requisitos Não-Funcionais
- Validação de QR Code responde em < 300ms mesmo com conectividade 3G.
- Disponibilidade de 99,9% durante período de vendas e horário do evento.
- Sistema suporta pico de 500 compras simultâneas por evento.
- Dados pessoais (CPF, e-mail) são criptografados em repouso e nunca aparecem em logs (LGPD).
- QR Code não contém dados pessoais em texto claro, apenas hash validável.

## 5. Regras de Negócio
- Lote esgota quando quantidade vendida iguala quantidade disponível; compras acima do estoque retornam erro 409.
- Ingresso só pode ser usado uma única vez; segunda leitura do QR Code retorna "ingresso já utilizado" com timestamp do primeiro check-in.
- Cancelamento de ingresso é permitido até 48 horas antes do evento; após isso, ingresso é não reembolsável.
- Evento com capacidade esgotada não permite venda de novos lotes mesmo que estoque de lote anterior não tenha sido totalmente vendido.

## 6. Modelo de Dados
- events(id, organizer_id, title, description, venue, capacity, event_date, created_at)
- ticket_batches(id, event_id, name, quantity, price, sale_start, sale_end)
- tickets(id, batch_id, buyer_name, buyer_email, buyer_document, qr_code_hash, status, purchased_at)
- checkins(id, ticket_id, checked_in_by, checked_in_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 (site de vendas) + React Native (app mobile de check-in).
- Backend: Fastify + PostgreSQL (índices em event_id, qr_code_hash).
- QR Code: biblioteca qrcode (Node) para geração de PNG; crypto nativo para hash SHA-256.
- E-mail: AWS SES para envio de ingresso com QR Code anexado em PDF.
