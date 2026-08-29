# Roteirização de Entregas

## 0. Metadados
- **Produto:** RouteOptimizer — sistema de otimização de rotas de entrega para logística urbana
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Planejar rotas de entrega respeitando janelas de tempo, capacidade de veículo e prioridade, otimizando distância e tempo, com acompanhamento em tempo real do motorista.

## 2. Personas
- Planejador logístico — cadastra paradas e gera rotas otimizadas.
- Motorista — recebe rota no app e atualiza status das entregas.
- Gestor de operações — monitora cumprimento de SLA e desempenho de frota.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de paradas com endereço e janela
DADO um planejador autenticado, QUANDO cadastra uma parada com endereço, janela de entrega (ex: 14h-16h) e peso, ENTÃO o sistema geocodifica o endereço e valida a janela contra o horário operacional.

### FR-02 — Alocação de veículos com capacidade
DADO um planejador, QUANDO seleciona um conjunto de paradas e um veículo com capacidade de 500kg, ENTÃO o sistema aloca apenas paradas cujo peso somado não exceda a capacidade.

### FR-03 — Otimização de sequência de paradas
DADO uma rota com N paradas alocadas, QUANDO o planejador aciona "Otimizar", ENTÃO o sistema calcula a sequência que minimiza distância total, respeitando janelas de tempo e prioridades.

### FR-04 — Acompanhamento do motorista em rota
DADO um motorista com rota iniciada, QUANDO atualiza o status de uma parada para "entregue" ou "falhada", ENTÃO o sistema registra timestamp e localização GPS, e notifica o planejador se houver atraso em relação ao SLA.

### FR-05 — Alertas de desvio de rota
DADO uma rota em execução, QUANDO o motorista se desvia mais de 500m da sequência planejada, ENTÃO o sistema envia alerta ao gestor e sugere recalcular a rota restante.

## 4. Requisitos Não-Funcionais
- Otimização de rota com até 100 paradas em < 5 segundos. Disponibilidade 99,5%. Dados de localização do motorista retidos por 90 dias (LGPD). API de mapas com fallback (Google Maps → OpenStreetMap).

## 5. Regras de Negócio
- Parada com janela de tempo tem prioridade sobre paradas sem restrição. Veículo só pode iniciar rota se todas as paradas tiverem geocodificação válida. Entrega falhada permite até 2 reenvios automáticos na mesma rota.

## 6. Modelo de Dados
- stops(id, endereco, lat, lng, janela_inicio, janela_fim, peso, prioridade, status)
- vehicles(id, placa, capacidade_kg, tipo, status)
- routes(id, vehicle_id, planejador_id, distancia_total_km, tempo_estimado_min, status)
- route_stops(id, route_id, stop_id, sequencia, eta, status, timestamp_entrega, lat_entrega, lng_entrega)

## 7. Stack sugerida
- Frontend: Next.js 14 + Mapbox GL JS para visualização de mapas. Backend: Fastify + PostgreSQL com PostGIS. Motor de otimização: OR-Tools (Google) ou OSRM. App mobile: React Native para motorista.
