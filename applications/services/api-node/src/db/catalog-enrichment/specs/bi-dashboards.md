# Plataforma de BI e Dashboards Analíticos

## 0. Metadados
- **Produto:** InsightBoard — plataforma de business intelligence com dashboards personalizáveis e conectores de dados
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar métricas de negócio em dashboards interativos com filtros temporais, comparativos e compartilhamento seguro por equipe.

## 2. Personas
- Analista de dados — cria dashboards, conecta fontes de dados e modela métricas.
- Executivo — consome dashboards prontos e exporta relatórios para decisão estratégica.
- Administrador — gerencia permissões e fontes de dados corporativas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e controle de acesso
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboards conforme permissões de leitura ou edição.

### FR-02 — Conectores de fontes de dados
DADO um analista autenticado, QUANDO configura conector para banco SQL ou API REST com credenciais, ENTÃO o sistema valida conexão e armazena credenciais criptografadas.

### FR-03 — Modelagem de métricas calculadas
DADO um dataset conectado, QUANDO o analista define métrica calculada com fórmula SQL ou agregação, ENTÃO a métrica fica disponível para uso em widgets.

### FR-04 — Criação de dashboards com widgets
DADO um analista autenticado, QUANDO adiciona widget de gráfico (linha, barra, pizza) com métrica e dimensão, ENTÃO o dashboard renderiza o gráfico com dados em tempo real.

### FR-05 — Filtros temporais e comparativos de período
DADO um dashboard com métricas temporais, QUANDO o usuário aplica filtro de período (últimos 7 dias, mês atual) ou comparativo (vs. mês anterior), ENTÃO todos os widgets atualizam automaticamente.

### FR-06 — Compartilhamento e permissões por painel
DADO um dashboard criado, QUANDO o analista compartilha com equipe ou perfil, ENTÃO os destinatários recebem acesso de leitura ou edição conforme permissão concedida.

### FR-07 — Exportação de relatórios
DADO um dashboard renderizado, QUANDO o executivo solicita exportação em PDF ou CSV, ENTÃO o sistema gera arquivo com todos os gráficos e tabelas do dashboard.

## 4. Requisitos Não-Funcionais
- Consultas analíticas com cache de 5 minutos; resposta < 2s p95 para dashboards com até 10 widgets.
- Suporte a até 10.000 linhas por widget; paginação server-side para datasets maiores.
- Credenciais de conectores armazenadas com AES-256; nunca logadas.
- Interface responsiva; disponibilidade 99,5%.

## 5. Regras de Negócio
- Métrica calculada só pode referenciar campos do dataset origem; validação de sintaxe SQL obrigatória antes de salvar.
- Dashboard compartilhado com permissão de leitura não permite edição de widgets ou filtros salvos.
- Cache de consulta é invalidado a cada 5 minutos ou quando o usuário força atualização manual.
- Exportação de dashboard maior que 20 páginas exige processamento assíncrono com notificação por e-mail.

## 6. Modelo de Dados
- data_sources(id, name, type, connection_string_encrypted, created_by)
- datasets(id, source_id, name, query_sql, refresh_interval)
- metrics(id, dataset_id, name, formula, aggregation_type)
- dashboards(id, name, owner_id, created_at)
- widgets(id, dashboard_id, metric_id, chart_type, config_json, position_x, position_y)
- dashboard_permissions(id, dashboard_id, user_id, permission_level)

## 7. Stack sugerida
- Frontend: Next.js 14 + Recharts ou Apache ECharts para visualizações; MUI para layout e controles.
- Backend: Fastify + PostgreSQL para metadados; cache de consultas com Redis; workers assíncronos para exportação.
- Conectores: bibliotecas de cliente SQL (pg, mysql2) e HTTP (axios) para integração com APIs externas.
