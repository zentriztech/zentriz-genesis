# Roteiros de Viagem

## 0. Metadados
- **Produto:** TripPlanner — plataforma de criação de roteiros de viagem personalizados
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que viajantes montem roteiros personalizados por dia, descobrindo atrações, reservando atividades e compartilhando o itinerário com acompanhantes, otimizando a experiência de planejamento.

## 2. Personas
- Viajante — busca destinos, monta roteiro por dia e reserva passeios.
- Agência de turismo — cadastra destinos, atrações e pacotes de atividades.
- Acompanhante — recebe roteiro compartilhado e acompanha a viagem.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo de destinos e atrações
DADO um viajante na plataforma, QUANDO busca um destino (ex.: Paris), ENTÃO visualiza atrações turísticas com descrição, horário de funcionamento, preço médio e avaliações.

### FR-02 — Criação de roteiro por dia
DADO um viajante criando um roteiro, QUANDO adiciona uma atração ao dia 1, ENTÃO ela é inserida na ordem escolhida com horário sugerido baseado na duração média de visita.

### FR-03 — Reserva de atividades
DADO um viajante visualizando uma atração, QUANDO seleciona "Reservar passeio guiado", ENTÃO escolhe data, horário e quantidade de pessoas, e o sistema valida disponibilidade e processa pagamento.

### FR-04 — Estimativa de tempo e deslocamento
DADO um roteiro com múltiplas atrações no mesmo dia, QUANDO o viajante salva o roteiro, ENTÃO o sistema calcula tempo de deslocamento entre atrações (via API de mapas) e alerta se o dia está sobrecarregado.

### FR-05 — Compartilhamento do roteiro
DADO um viajante com roteiro criado, QUANDO compartilha via link público ou e-mail, ENTÃO acompanhantes podem visualizar o itinerário completo (somente leitura) e comentar em cada dia.

### FR-06 — Acompanhamento durante a viagem
DADO um viajante com roteiro ativo, QUANDO marca uma atração como "visitada", ENTÃO ela é destacada como concluída e o próximo item do dia é destacado.

## 4. Requisitos Não-Funcionais
- Integração com API de mapas (Google Maps, Mapbox) para deslocamento. API < 600ms p95. Disponibilidade 99%. Pagamento seguro (PCI-DSS) para reservas. Armazenamento de imagens de atrações otimizado (CDN). Compartilhamento com link único (UUID) e expiração configurável.

## 5. Regras de Negócio
- Atração só pode ser adicionada uma vez por dia no mesmo roteiro.
- Reserva de atividade exige pagamento adiantado; cancelamento até 48h antes com reembolso de 80%.
- Roteiro compartilhado expira após 90 dias de inatividade (sem edições).
- Tempo de deslocamento considera tráfego médio do horário configurado.

## 6. Modelo de Dados
- destinations(id, name, country, description, cover_image_url)
- attractions(id, destination_id, name, description, category, duration_avg_minutes, price_avg, lat, lng, rating)
- itineraries(id, user_id, destination_id, start_date, end_date, shared_link, shared_at, expires_at)
- itinerary_days(id, itinerary_id, day_number, date)
- itinerary_items(id, itinerary_day_id, attraction_id, order, start_time, visited)
- bookings(id, itinerary_item_id, user_id, activity_name, scheduled_at, guests, amount, payment_status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Mapbox ou Google Maps API. Backend: Fastify + PostgreSQL. Pagamento: integração com gateway (Stripe). API de deslocamento: Google Directions API. CDN: Cloudflare ou CloudFront para imagens.
