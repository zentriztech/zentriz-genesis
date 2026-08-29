# Telemetria IoT

## 0. Metadados
- **Produto:** IoTMonitor — plataforma de telemetria para dispositivos IoT com dashboards e alertas em tempo real
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de ingestão e visualização de telemetria de sensores IoT, suportando milhares de dispositivos simultâneos. Armazena séries temporais de métricas, dispara alertas por violação de limiar e exibe dashboards customizáveis em tempo real.

## 2. Personas
- Técnico de campo — instala sensores, registra dispositivos na plataforma e acompanha saúde dos equipamentos.
- Operador — monitora dashboards de métricas agregadas, responde a alertas de threshold.
- Gestor — analisa histórico de telemetria, identifica padrões e planeja manutenções preventivas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de dispositivo IoT
DADO um técnico autenticado, QUANDO registra novo dispositivo informando identificador único, tipo de sensor e localização, ENTÃO o sistema gera token de autenticação MQTT e persiste o dispositivo com status "inativo".

### FR-02 — Ingestão de leituras via MQTT
DADO um dispositivo cadastrado, QUANDO publica leitura em tópico MQTT informando timestamp, métrica e valor, ENTÃO o sistema valida token, persiste leitura em série temporal e atualiza status do dispositivo para "ativo".

### FR-03 — Série temporal por métrica
DADO um operador visualizando dashboard, QUANDO seleciona dispositivo e métrica (temperatura, umidade, pressão), ENTÃO o sistema retorna série temporal das últimas 24 horas com granularidade de 1 minuto.

### FR-04 — Configuração de alertas por limiar
DADO um operador autenticado, QUANDO cria regra de alerta informando métrica, operador de comparação (>, <, =) e valor de limiar, ENTÃO a regra é ativada e passa a avaliar leituras em tempo real.

### FR-05 — Disparo de alerta em tempo real
DADO uma leitura recém-ingerida, QUANDO o valor viola regra de alerta ativa, ENTÃO o sistema cria evento de alerta, envia notificação push para operadores e registra no histórico de alertas do dispositivo.

### FR-06 — Dashboard customizável
DADO um gestor autenticado, QUANDO cria dashboard informando widgets (gráfico de linha, gauge, mapa de calor) e métricas, ENTÃO o dashboard é salvo e atualiza automaticamente com dados em tempo real via WebSocket.

### FR-07 — Detecção de dispositivo offline
DADO um dispositivo ativo, QUANDO passa 10 minutos sem enviar leitura, ENTÃO o sistema muda status para "offline" e dispara alerta de conectividade para técnico responsável.

## 4. Requisitos Não-Funcionais
- Ingestão suporta até 10.000 leituras por segundo com latência máxima de 500ms.
- Disponibilidade de 99,9% para subsistema de ingestão.
- Retenção de séries temporais por 90 dias com granularidade de 1 minuto; agregação diária para histórico de 2 anos.
- Dashboard atualiza em tempo real com latência máxima de 2 segundos (WebSocket).

## 5. Regras de Negócio
- Token MQTT de dispositivo expira após 1 ano; renovação automática 30 dias antes do vencimento.
- Leituras com timestamp futuro ou anterior a 1 hora são rejeitadas (proteção contra clock skew).
- Alerta só dispara uma vez até que métrica retorne a faixa normal (evita spam).
- Dispositivo sem leitura por 30 dias é automaticamente marcado como "desativado".

## 6. Modelo de Dados
- devices(id, device_id, type, location_lat, location_lng, mqtt_token, status, last_seen_at)
- readings(device_id, metric, value, timestamp) — tabela de série temporal (TimescaleDB/InfluxDB)
- alert_rules(id, metric, operator, threshold, device_id, active)
- alerts(id, rule_id, device_id, triggered_at, value, acknowledged_at)
- dashboards(id, user_id, name, layout_config)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal; Recharts para gráficos; WebSocket para updates em tempo real.
- Backend: Fastify + TimescaleDB para séries temporais; Redis para cache de dispositivos ativos; Mosquitto MQTT broker.
- Infraestrutura: SQS para fila de ingestão assíncrona; Lambda para avaliação de regras de alerta.
