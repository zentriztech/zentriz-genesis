# Gestão de Frota

## 0. Metadados
- **Produto:** FleetOps — gestão de frota para transportadoras
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Controlar veículos, motoristas e manutenção, reduzindo paradas não planejadas e custo por quilômetro rodado. O sistema centraliza abastecimento, ordens de serviço e alertas de vencimento de documentos.

## 2. Personas
- Gestor de frota — cadastra veículos, acompanha custos e planeja manutenção preventiva.
- Motorista — registra abastecimentos e quilometragem no campo.
- Mecânico — recebe e executa ordens de manutenção.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboard conforme perfil (gestor, motorista ou mecânico).

### FR-02 — Cadastro de veículos
DADO um gestor autenticado, QUANDO cadastra veículo com placa única, modelo, ano e quilometragem inicial, ENTÃO o veículo é persistido como "disponível".

### FR-03 — Registro de abastecimento
DADO um motorista, QUANDO registra litros, valor pago e leitura do hodômetro, ENTÃO o sistema calcula consumo médio (km/L) e atualiza quilometragem do veículo.

### FR-04 — Ordens de manutenção
DADO um gestor, QUANDO abre ordem de serviço para veículo com descrição e tipo (preventiva ou corretiva), ENTÃO o veículo passa a status "em manutenção" até conclusão.

### FR-05 — Alertas de vencimento de documentos
DADO um veículo com CRLV ou seguro a vencer em 30 dias, QUANDO o sistema executa job diário, ENTÃO envia notificação ao gestor de frota.

### FR-06 — Relatório de custos por veículo
DADO um gestor, QUANDO consulta relatório mensal, ENTÃO vê total gasto por veículo (combustível + manutenção) e custo por km rodado.

### FR-07 — Gestão de motoristas
DADO um gestor, QUANDO cadastra motorista com CNH e data de validade, ENTÃO o sistema alerta 60 dias antes do vencimento da habilitação.

## 4. Requisitos Não-Funcionais
- API responde em < 400ms p95; disponibilidade 99,5%. Dados pessoais (CNH, CPF) nunca em logs. Backup diário automático. Mobile-friendly para motoristas em campo.

## 5. Regras de Negócio
- Placa única por tenant. Veículo em manutenção não recebe nova viagem. Consumo médio recalculado a cada abastecimento. Alerta de documento dispara apenas uma vez até renovação.

## 6. Modelo de Dados
- vehicles(id, plate, model, year, status, odometer, tenant_id)
- drivers(id, name, cnh, cnh_expiry, tenant_id)
- fuel_logs(id, vehicle_id, driver_id, liters, amount, odometer, date)
- maintenance_orders(id, vehicle_id, type, description, status, opened_at, closed_at, cost)
- documents(id, vehicle_id, type, number, expiry_date)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 (responsivo). Backend: Fastify + PostgreSQL. Job scheduler: node-cron para alertas. Relatórios: exportação CSV.
