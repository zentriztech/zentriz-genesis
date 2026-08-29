# Gestão de Fazenda

## 0. Metadados
- **Produto:** AgroSafe — gestão completa de propriedades rurais e ciclo produtivo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para produtores rurais controlarem talhões, safras, aplicação de insumos e custos de produção, substituindo planilhas por rastreabilidade digital e reduzindo perdas por descontrole de estoque e aplicação inadequada.

## 2. Personas
- Produtor rural — cadastra talhões, planeja safras e acompanha custos e produtividade.
- Engenheiro agrônomo — registra aplicações de defensivos e fertilizantes, emite recomendações técnicas.
- Operador de máquinas — consulta prescrições de aplicação e registra execução no campo.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e controle de acesso por perfil
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (produtor, agrônomo ou operador).

### FR-02 — Cadastro de talhões e culturas
DADO um produtor autenticado, QUANDO cadastra um talhão informando área em hectares, coordenadas GPS e cultura plantada, ENTÃO o sistema registra o talhão com status "ativo" e permite vincular safras futuras.

### FR-03 — Planejamento de safra
DADO um produtor, QUANDO cria um planejamento de safra vinculando talhões, data de plantio e variedade de semente, ENTÃO o sistema calcula a data estimada de colheita e inicia o ciclo produtivo.

### FR-04 — Registro de aplicação de insumos
DADO um operador no campo, QUANDO registra uma aplicação informando insumo, quantidade, dose por hectare e talhão, ENTÃO o sistema deduz do estoque, registra a operação com timestamp e vincula ao ciclo da safra.

### FR-05 — Controle de estoque de insumos
DADO um estoque de insumos cadastrados, QUANDO ocorre entrada por compra ou saída por aplicação, ENTÃO o saldo é atualizado e alertas são emitidos ao produtor quando o nível atingir o ponto de reposição.

### FR-06 — Cálculo de custo e produtividade por talhão
DADO uma safra encerrada, QUANDO o sistema consolida todos os insumos aplicados e a produção colhida, ENTÃO calcula o custo total por hectare e a produtividade em sacas/hectare, exibindo no painel comparativo.

### FR-07 — Rastreabilidade e auditoria de operações
DADO qualquer operação registrada no sistema, QUANDO o usuário consulta o histórico de um talhão ou safra, ENTÃO visualiza a linha do tempo completa com datas, responsáveis e insumos aplicados, gerando relatório para certificação.

## 4. Requisitos Não-Funcionais
- Aplicativo mobile funcionar offline no campo e sincronizar quando houver rede.
- Resposta de API < 500ms p95; disponibilidade 99%.
- Dados de produtividade e custos restritos ao proprietário da fazenda.

## 5. Regras de Negócio
- Um talhão só pode receber uma safra ativa por vez; safras encerradas liberam o talhão para novo plantio.
- Aplicação de defensivos exige receituário agronômico válido vinculado ao registro.
- Estoque negativo de insumos é bloqueado; aplicação sem saldo é rejeitada.
- Produtividade calculada apenas após registro de colheita com peso aferido.

## 6. Modelo de Dados
- farms(id, name, owner_id, total_area_ha)
- fields(id, farm_id, name, area_ha, gps_coords, status)
- crops(id, name, variety, avg_cycle_days)
- seasons(id, field_id, crop_id, planted_at, estimated_harvest_at, actual_harvest_at, yield_kg, status)
- inputs(id, name, type, unit, stock_qty, reorder_point)
- applications(id, season_id, input_id, qty, dose_per_ha, applied_at, applied_by_user_id)
- input_movements(id, input_id, movement_type, qty, timestamp)

## 7. Stack sugerida
- Frontend: Next.js 14 + React Native (mobile offline). Backend: Fastify + PostgreSQL + PostGIS (coords). Auth JWT.
